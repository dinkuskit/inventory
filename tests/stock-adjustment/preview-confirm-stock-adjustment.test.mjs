import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
	createConfirmStockAdjustment,
	createAdjustStock,
	createPreviewStockAdjustment,
	createReadInventoryMutation,
	createReadReceiptHistory,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import {
	archiveFixtureLocation,
	createFixtureLocation,
} from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "principal_test_operator",
	displayName: "Test Operator",
	surface: "test",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-adjust-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function seedStock(store, filePath) {
	await createFixtureLocation(store);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	const setOpeningBalance = createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-29T10:00:00.000Z"),
		createReceiptId: () => "rcpt_opening_hat",
	});
	const result = await setOpeningBalance(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_opening_hat",
			type: "stock.opening_balance",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: {
				skuId: "sku_hat",
				quantity: { value: "10", unit: "each" },
			},
			reason: { code: "opening_balance", note: "Set Initial Stock" },
			references: [],
			expectedVersions: [
				{ skuId: "sku_hat", locationId: "location_north", version: "0" },
			],
		},
		{ principal },
	);
	assert.equal(result.outcome, "committed");

	// Reservations are intentionally outside this slice. Materialize the
	// pre-existing reservation state that adjustment preview must preserve.
	const database = new DatabaseSync(filePath);
	database
		.prepare(
			`UPDATE inventory_balances
			 SET reserved_value = '8', available_value = '2'
			 WHERE pool_id = 'pool_test'
			   AND location_id = 'location_north'
			   AND sku_id = 'sku_hat'`,
		)
		.run();
	database.close();
}

function previewInput(overrides = {}) {
	return {
		schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1",
		type: "stock.adjust",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_north",
		},
		payload: {
			skuId: "sku_hat",
			delta: { value: "-5", unit: "each" },
		},
		reason: { note: "Five hats damaged" },
		references: [],
		...overrides,
	};
}

function commandFromPreview(input, preview, commandId = "cmd_adjust_hat") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: input.type,
		context: structuredClone(input.context),
		payload: structuredClone(input.payload),
		reason: structuredClone(input.reason),
		references: structuredClone(input.references),
		expectedVersions: [
			{
				skuId: input.payload.skuId,
				locationId: input.context.locationId,
				version: preview.effect.balanceBefore.version,
			},
		],
	};
}

function boundary(
	store,
	{
		clock = { value: new Date("2026-08-29T12:00:00.000Z") },
		confirmations = ["confirm_adjust_hat"],
		receiptIds = ["rcpt_adjust_hat"],
	} = {},
) {
	let confirmationIndex = 0;
	let receiptIndex = 0;
	const now = () => new Date(clock.value);
	return {
		clock,
		preview: createPreviewStockAdjustment({
			store,
			now,
			createConfirmation: () => {
				const value = confirmations[confirmationIndex++];
				if (value === undefined) throw new Error("confirmation sequence exhausted");
				return value;
			},
		}),
		confirm: createConfirmStockAdjustment({
			store,
			now,
			createReceiptId: () => {
				const value = receiptIds[receiptIndex++];
				if (value === undefined) throw new Error("receipt sequence exhausted");
				return value;
			},
		}),
	};
}

test("previews and commits an allowed oversell with exact quantities and actor receipt", async (t) => {
	const filePath = await databasePath(t, "oversell");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seedStock(store, filePath);
	const operations = boundary(store);
	const input = previewInput({
		references: [{ kind: "corrects_receipt", id: "rcpt_prior_count" }],
	});

	const preview = await operations.preview(input, { principal });

	assert.deepEqual(preview, {
		schema: "dinkuskit.inventory.stock-adjustment-preview/v1",
		type: "stock.adjust",
		context: input.context,
		effect: {
			skuId: "sku_hat",
			locationId: "location_north",
			onHandDelta: { value: "-5", unit: "each" },
			reservedDelta: { value: "0", unit: "each" },
			balanceBefore: {
				onHand: { value: "10", unit: "each" },
				reserved: { value: "8", unit: "each" },
				available: { value: "2", unit: "each" },
				version: "1",
			},
			balanceAfter: {
				onHand: { value: "5", unit: "each" },
				reserved: { value: "8", unit: "each" },
				available: { value: "-3", unit: "each" },
				version: "2",
			},
		},
		reason: { note: "Five hats damaged" },
		references: input.references,
		warnings: [
			{
				code: "negative_available",
				reserved: { value: "8", unit: "each" },
				oversoldBy: { value: "3", unit: "each" },
				message:
					"8 units are reserved for orders. This adjustment will oversell stock by 3 units.",
			},
		],
		confirmation: {
			value: "confirm_adjust_hat",
			expiresAt: "2026-08-29T12:05:00.000Z",
		},
	});
	assert.deepEqual(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
		}),
		{
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
			onHand: { value: "10", unit: "each" },
			reserved: { value: "8", unit: "each" },
			available: { value: "2", unit: "each" },
			version: "1",
			hasStockHistory: true,
		},
	);

	const command = commandFromPreview(input, preview);
	const result = await operations.confirm(preview.confirmation.value, command, {
		principal,
	});

	assert.equal(result.outcome, "committed");
	assert.deepEqual(result.receipt.principal, principal);
	assert.deepEqual(result.receipt.reason, { note: "Five hats damaged" });
	assert.deepEqual(result.receipt.references, [
		{ kind: "corrects_receipt", id: "rcpt_prior_count" },
	]);
	assert.deepEqual(result.receipt.effects[0].balanceBefore, preview.effect.balanceBefore);
	assert.deepEqual(result.receipt.effects[0].balanceAfter, preview.effect.balanceAfter);
	assert.deepEqual(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
		}),
		{
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
			onHand: { value: "5", unit: "each" },
			reserved: { value: "8", unit: "each" },
			available: { value: "-3", unit: "each" },
			version: "2",
			hasStockHistory: true,
		},
	);
	const mutation = await createReadInventoryMutation({ store })({
		receiptId: "rcpt_adjust_hat",
	});
	assert.equal(mutation.outcome, "found");
	assert.equal(mutation.result.receipt.type, "stock.adjust");
	const history = await createReadReceiptHistory({ store })({
		poolId: "pool_test",
		scope: { kind: "location", locationId: "location_north" },
	});
	assert.deepEqual(
		history.receipts.map(({ receiptId, type }) => ({ receiptId, type })),
		[
			{ receiptId: "rcpt_adjust_hat", type: "stock.adjust" },
			{ receiptId: "rcpt_opening_hat", type: "stock.opening_balance" },
		],
	);
});

test("returns the original durable terminal result on retry and conflicts changed content", async (t) => {
	const filePath = await databasePath(t, "retry");
	let store = createLocalSqliteTestStore({ filePath });
	await seedStock(store, filePath);
	const operations = boundary(store);
	const input = previewInput();
	const preview = await operations.preview(input, { principal });
	const command = commandFromPreview(input, preview);
	const committed = await operations.confirm(preview.confirmation.value, command, {
		principal,
	});
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const replayBoundary = boundary(store, { receiptIds: [] });
	const replay = await replayBoundary.confirm(
		preview.confirmation.value,
		command,
		{ principal },
	);
	assert.equal(JSON.stringify(replay), JSON.stringify(committed));

	const conflict = await replayBoundary.confirm(
		preview.confirmation.value,
		{ ...command, reason: { note: "Changed after commit" } },
		{ principal },
	);
	assert.deepEqual(conflict, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_adjust_hat",
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	});
	assert.equal(
		(await store.readReceipt("rcpt_adjust_hat")).reason.note,
		"Five hats damaged",
	);
});

test("durably rejects a stale preview after another adjustment commits", async (t) => {
	const filePath = await databasePath(t, "stale");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seedStock(store, filePath);
	const operations = boundary(store, {
		confirmations: ["confirm_first", "confirm_stale"],
		receiptIds: ["rcpt_first", "rcpt_stale_should_not_exist"],
	});
	const firstInput = previewInput({
		payload: { skuId: "sku_hat", delta: { value: "2", unit: "each" } },
		reason: { note: "Two hats found" },
	});
	const staleInput = previewInput({
		payload: { skuId: "sku_hat", delta: { value: "-1", unit: "each" } },
		reason: { note: "One hat damaged" },
	});
	const firstPreview = await operations.preview(firstInput, { principal });
	const stalePreview = await operations.preview(staleInput, { principal });
	await operations.confirm(
		firstPreview.confirmation.value,
		commandFromPreview(firstInput, firstPreview, "cmd_first"),
		{ principal },
	);
	const staleCommand = commandFromPreview(
		staleInput,
		stalePreview,
		"cmd_stale",
	);
	const rejected = await operations.confirm(
		stalePreview.confirmation.value,
		staleCommand,
		{ principal },
	);
	assert.deepEqual(rejected, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_stale",
		code: "stale_version",
		message: "Stock changed after preview. Preview the adjustment again.",
	});
	assert.equal(await store.readReceipt("rcpt_stale_should_not_exist"), null);
	const replay = await operations.confirm(
		stalePreview.confirmation.value,
		staleCommand,
		{ principal },
	);
	assert.equal(JSON.stringify(replay), JSON.stringify(rejected));
});

test("expires after five minutes and binds confirmation to the signed-in principal", async (t) => {
	const filePath = await databasePath(t, "confirmation-gates");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seedStock(store, filePath);
	const operations = boundary(store, {
		confirmations: ["confirm_expiring"],
	});
	const input = previewInput();
	const preview = await operations.preview(input, { principal });
	const command = commandFromPreview(input, preview);
	await assert.rejects(
		operations.confirm(preview.confirmation.value, command, {
			principal: { ...principal, id: "principal_other" },
		}),
		{ name: "StockAdjustmentConfirmationError", code: "confirmation_mismatch" },
	);
	operations.clock.value = new Date("2026-08-29T12:05:00.000Z");
	await assert.rejects(
		operations.confirm(preview.confirmation.value, command, { principal }),
		{ name: "StockAdjustmentConfirmationError", code: "confirmation_expired" },
	);
	assert.equal(
		(
			await store.readBalance({
				poolId: "pool_test",
				locationId: "location_north",
				skuId: "sku_hat",
			})
		).version,
		"1",
	);
});

test("rolls back balance, receipt, result, and confirmation binding on commit failure", async (t) => {
	const filePath = await databasePath(t, "rollback");
	const durableStore = createLocalSqliteTestStore({ filePath });
	t.after(() => durableStore.close());
	await seedStock(durableStore, filePath);
	const failingStore = {
		...durableStore,
		runTransaction: (poolId, operation) =>
			durableStore.runTransaction(poolId, (transaction) =>
				operation(
					new Proxy(transaction, {
						get(target, property) {
							if (property === "commitStockAdjustment") {
								return (input) => {
									target.commitStockAdjustment(input);
									throw new Error("injected post-persistence failure");
								};
							}
							const value = Reflect.get(target, property, target);
							return typeof value === "function" ? value.bind(target) : value;
						},
					}),
				),
			),
		readBalance: (...args) => durableStore.readBalance(...args),
	};
	const operations = boundary(failingStore);
	const input = previewInput();
	const preview = await operations.preview(input, { principal });
	const command = commandFromPreview(input, preview);
	await assert.rejects(
		operations.confirm(preview.confirmation.value, command, { principal }),
		/injected post-persistence failure/u,
	);
	assert.equal((await durableStore.readBalance({
		poolId: "pool_test",
		locationId: "location_north",
		skuId: "sku_hat",
	})).version, "1");
	assert.equal(await durableStore.readReceipt("rcpt_adjust_hat"), null);
	assert.equal(await durableStore.readCommand("cmd_adjust_hat"), null);
});

test("preview reports location, registration, and opening-history failures in order", async (t) => {
	const filePath = await databasePath(t, "preview-rejections");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const preview = createPreviewStockAdjustment({
		store,
		now: () => new Date("2026-08-29T12:00:00.000Z"),
		createConfirmation: () => "confirm_should_not_be_stored",
	});
	await assert.rejects(
		preview(
			previewInput({
				context: {
					siteId: "site_test",
					poolId: "pool_test",
					locationId: "location_unknown",
				},
			}),
			{ principal },
		),
		{ name: "StockAdjustmentPreviewError", code: "location_not_found" },
	);
	await assert.rejects(
		preview(previewInput(), { principal }),
		{ name: "StockAdjustmentPreviewError", code: "sku_not_registered" },
	);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	await assert.rejects(
		preview(previewInput(), { principal }),
		{ name: "StockAdjustmentPreviewError", code: "opening_balance_required" },
	);
});

test("direct command durably requires opening history without creating a receipt", async (t) => {
	const filePath = await databasePath(t, "opening-required");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	const adjust = createAdjustStock({
		store,
		now: () => new Date("2026-08-29T12:00:00.000Z"),
		createReceiptId: () => "rcpt_should_not_exist",
	});
	const input = previewInput();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_opening_required",
		type: input.type,
		context: input.context,
		payload: input.payload,
		reason: input.reason,
		references: input.references,
		expectedVersions: [
			{ skuId: "sku_hat", locationId: "location_north", version: "1" },
		],
	};
	const rejected = await adjust(command, { principal });
	assert.deepEqual(rejected, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_opening_required",
		code: "opening_balance_required",
		message: "Set Initial Stock before making a stock adjustment.",
	});
	assert.equal(await store.readReceipt("rcpt_should_not_exist"), null);
	assert.equal(
		JSON.stringify((await store.readCommand("cmd_opening_required")).result),
		JSON.stringify(rejected),
	);
});

test("direct commands durably reject archived locations and unit mismatches", async (t) => {
	const filePath = await databasePath(t, "direct-rejections");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store, { locationId: "location_archived" });
	await archiveFixtureLocation(store, { locationId: "location_archived" });
	await createFixtureLocation(store, { locationId: "location_active" });
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	const adjust = createAdjustStock({
		store,
		now: () => new Date("2026-08-29T12:00:00.000Z"),
		createReceiptId: () => "rcpt_should_not_exist",
	});
	const command = (commandId, locationId, unit = "each") => ({
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.adjust",
		context: { siteId: "site_test", poolId: "pool_test", locationId },
		payload: { skuId: "sku_hat", delta: { value: "1", unit } },
		reason: { note: "Count correction" },
		references: [],
		expectedVersions: [{ skuId: "sku_hat", locationId, version: "1" }],
	});
	const archived = await adjust(
		command("cmd_archived_adjust", "location_archived"),
		{ principal },
	);
	assert.equal(archived.outcome, "rejected");
	assert.equal(archived.code, "location_not_active");
	const mismatch = await adjust(
		command("cmd_unit_mismatch", "location_active", "case"),
		{ principal },
	);
	assert.equal(mismatch.outcome, "rejected");
	assert.equal(mismatch.code, "sku_unit_mismatch");
	assert.equal(await store.readReceipt("rcpt_should_not_exist"), null);
	assert.equal(
		(await store.readCommand("cmd_archived_adjust")).result.code,
		"location_not_active",
	);
	assert.equal(
		(await store.readCommand("cmd_unit_mismatch")).result.code,
		"sku_unit_mismatch",
	);
});
