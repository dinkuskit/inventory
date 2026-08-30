import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createConfirmOpeningBalance,
	createPreviewOpeningBalance,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import {
	archiveFixtureLocation,
	createFixtureLocation as createRawFixtureLocation,
	restoreFixtureLocation,
} from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "principal_test_operator",
	displayName: "Test Operator",
	surface: "test",
});

async function createFixtureLocation(store, options = {}) {
	await createRawFixtureLocation(store, options);
	await createFixtureManagedSku(store, {
		poolId: options.poolId ?? "pool_test",
		skuId: "sku_keychain",
	});
}

function previewInput({
	siteId = "site_test",
	poolId = "pool_test",
	locationId = "location_north",
	skuId = "sku_keychain",
	value = "5",
	unit = "each",
	reasonCode = "physical_count",
	reasonNote = "Reviewed opening count",
} = {}) {
	return {
		schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
		type: "stock.opening_balance",
		context: { siteId, poolId, locationId },
		payload: { skuId, quantity: { value, unit } },
		reason: { code: reasonCode, note: reasonNote },
		references: [],
	};
}

function commandFromPreview(input, { commandId = "cmd_opening_001" } = {}) {
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
				version: "0",
			},
		],
	};
}

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-confirm-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function boundary(
	store,
	{
		clock = { value: new Date("2026-08-28T12:00:00.000Z") },
		confirmations = ["confirm_opening_001"],
		receiptIds = ["rcpt_opening_001"],
	} = {},
) {
	let confirmationIndex = 0;
	let receiptIndex = 0;
	const now = () => new Date(clock.value);
	return {
		clock,
		preview: createPreviewOpeningBalance({
			store,
			now,
			createConfirmation: () => {
				const confirmation = confirmations[confirmationIndex++];
				if (confirmation === undefined) {
					throw new Error("test confirmation sequence exhausted");
				}
				return confirmation;
			},
		}),
		confirm: createConfirmOpeningBalance({
			store,
			now,
			createReceiptId: () => {
				const receiptId = receiptIds[receiptIndex++];
				if (receiptId === undefined) {
					throw new Error("test receipt ID sequence exhausted");
				}
				return receiptId;
			},
		}),
	};
}

test("confirmed opening balance durably rejects an archived location", async (t) => {
	const filePath = await databasePath(t, "archived-location");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store, { locationId: "location_archived" });
	await archiveFixtureLocation(store, { locationId: "location_archived" });
	const operations = boundary(store, {
		confirmations: ["confirm_archived_location"],
		receiptIds: ["rcpt_archived_should_not_exist"],
	});
	const input = previewInput({ locationId: "location_archived" });
	const proposed = await operations.preview(input, { principal });
	const command = commandFromPreview(input, {
		commandId: "cmd_confirm_archived_location",
	});
	const rejected = await operations.confirm(
		proposed.confirmation.value,
		command,
		{ principal },
	);

	assert.deepEqual(rejected, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_confirm_archived_location",
		code: "location_not_active",
		message: "The location is archived and cannot receive stock.",
	});
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_archived",
			skuId: "sku_keychain",
		}),
		null,
	);
	assert.equal(await store.readReceipt("rcpt_archived_should_not_exist"), null);

	await restoreFixtureLocation(store, { locationId: "location_archived" });
	const replay = await operations.confirm(
		proposed.confirmation.value,
		command,
		{ principal },
	);
	assert.equal(JSON.stringify(replay), JSON.stringify(rejected));
});

test("previews the exact normalized effect for five minutes without mutating stock", async (t) => {
	const filePath = await databasePath(t, "shape");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureManagedSku(store);
	const { preview } = boundary(store);

	const result = await preview(previewInput({ value: "005.000" }), {
		principal,
	});

	assert.deepEqual(result, {
		schema: "dinkuskit.inventory.opening-balance-preview/v1",
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_north",
		},
		effect: {
			skuId: "sku_keychain",
			locationId: "location_north",
			onHandDelta: { value: "5", unit: "each" },
			reservedDelta: { value: "0", unit: "each" },
			balanceBefore: {
				onHand: { value: "0", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				available: { value: "0", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
				version: "0",
			},
			balanceAfter: {
				onHand: { value: "5", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				available: { value: "5", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
				version: "1",
			},
		},
		reason: {
			code: "physical_count",
			note: "Reviewed opening count",
		},
		references: [],
		warning: "This opening balance permanently starts stock history for this SKU-location.",
		confirmation: {
			value: "confirm_opening_001",
			expiresAt: "2026-08-28T12:05:00.000Z",
		},
	});
	assert.equal("commandId" in result, false);
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
		}),
		null,
	);
	assert.equal(await store.readReceipt("rcpt_opening_001"), null);
});

test("requires the editable reason before issuing a preview", async (t) => {
	const filePath = await databasePath(t, "reason-required");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const { preview } = boundary(store);
	const input = previewInput();
	delete input.reason.note;

	await assert.rejects(
		() => preview(input, { principal }),
		{ name: "InvalidOpeningBalanceCommandError" },
	);
});

test("binds the edited reason into confirmation", async (t) => {
	const filePath = await databasePath(t, "reason-binding");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const operations = boundary(store);
	const input = previewInput({ reasonNote: "Set Initial Stock" });
	const proposed = await operations.preview(input, { principal });
	const changed = previewInput({
		reasonNote: "Set Initial Stock - recounted shelf",
	});

	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				commandFromPreview(changed),
				{ principal },
			),
		{ name: "OpeningBalanceConfirmationError", code: "confirmation_mismatch" },
	);
	const committed = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input),
		{ principal },
	);
	assert.equal(committed.outcome, "committed");
	assert.equal(committed.receipt.reason.note, "Set Initial Stock");
});

test("confirms immediately and commits the balance and immutable receipt together", async (t) => {
	const filePath = await databasePath(t, "immediate");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const { preview, confirm } = boundary(store);
	const input = previewInput();
	const proposed = await preview(input, { principal });

	const result = await confirm(
		proposed.confirmation.value,
		commandFromPreview(input),
		{ principal },
	);

	assert.equal(result.outcome, "committed");
	assert.equal(result.commandId, "cmd_opening_001");
	assert.deepEqual(await store.readReceipt("rcpt_opening_001"), result.receipt);
	assert.equal(
		(
			await store.readBalance({
				poolId: "pool_test",
				locationId: "location_north",
				skuId: "sku_keychain",
			})
		).onHand.value,
		"5",
	);
});

test("persists an unconfirmed preview across database close and reopen", async (t) => {
	const filePath = await databasePath(t, "preview-reopen");
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store);
	const clock = { value: new Date("2026-08-28T12:00:00.000Z") };
	const input = previewInput();
	let operations = boundary(store, { clock });
	const proposed = await operations.preview(input, { principal });
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	operations = boundary(store, { clock, confirmations: [], receiptIds: ["rcpt_reopen"] });
	const result = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input),
		{ principal },
	);

	assert.equal(result.outcome, "committed");
	assert.equal(result.receipt.receiptId, "rcpt_reopen");
});

test("rejects an unconfirmed preview at the exact five-minute boundary", async (t) => {
	const filePath = await databasePath(t, "expired");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureManagedSku(store);
	const operations = boundary(store);
	const input = previewInput();
	const proposed = await operations.preview(input, { principal });
	operations.clock.value = new Date("2026-08-28T12:05:00.000Z");

	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				commandFromPreview(input),
				{ principal },
			),
		{ name: "OpeningBalanceConfirmationError", code: "confirmation_expired" },
	);
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
		}),
		null,
	);
});

test("returns the exact original terminal result when a confirmed request retries after expiry", async (t) => {
	const filePath = await databasePath(t, "retry-after-expiry");
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store);
	const clock = { value: new Date("2026-08-28T12:00:00.000Z") };
	const input = previewInput();
	const command = commandFromPreview(input);
	let operations = boundary(store, { clock });
	const proposed = await operations.preview(input, { principal });
	const first = await operations.confirm(
		proposed.confirmation.value,
		command,
		{ principal },
	);
	await store.close();

	clock.value = new Date("2026-08-28T12:30:00.000Z");
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	operations = boundary(store, { clock, confirmations: [], receiptIds: [] });
	const replay = await operations.confirm(
		proposed.confirmation.value,
		command,
		{ principal },
	);

	assert.equal(JSON.stringify(replay), JSON.stringify(first));
});

test("rejects a changed action without consuming the confirmation", async (t) => {
	const filePath = await databasePath(t, "action-mismatch");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const operations = boundary(store);
	const input = previewInput();
	const proposed = await operations.preview(input, { principal });

	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				commandFromPreview(previewInput({ value: "6" })),
				{ principal },
			),
		{ name: "OpeningBalanceConfirmationError", code: "confirmation_mismatch" },
	);
	const wrongVersion = commandFromPreview(input);
	wrongVersion.expectedVersions[0].version = "1";
	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				wrongVersion,
				{ principal },
			),
		{ name: "OpeningBalanceConfirmationError", code: "confirmation_mismatch" },
	);
	const result = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input),
		{ principal },
	);
	assert.equal(result.outcome, "committed");
});

test("rejects another principal without consuming the confirmation", async (t) => {
	const filePath = await databasePath(t, "principal-mismatch");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const operations = boundary(store);
	const input = previewInput();
	const proposed = await operations.preview(input, { principal });
	const otherPrincipal = { ...principal, id: "principal_someone_else" };

	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				commandFromPreview(input),
				{ principal: otherPrincipal },
			),
		{ name: "OpeningBalanceConfirmationError", code: "confirmation_mismatch" },
	);
	const result = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input),
		{ principal },
	);
	assert.equal(result.outcome, "committed");
});

test("binds a consumed confirmation to exactly one command ID", async (t) => {
	const filePath = await databasePath(t, "command-binding");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const operations = boundary(store);
	const input = previewInput();
	const proposed = await operations.preview(input, { principal });
	const original = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input, { commandId: "cmd_original" }),
		{ principal },
	);

	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				commandFromPreview(input, { commandId: "cmd_other" }),
				{ principal },
			),
		{
			name: "OpeningBalanceConfirmationError",
			code: "confirmation_already_used",
		},
	);
	const replay = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input, { commandId: "cmd_original" }),
		{ principal },
	);
	assert.equal(JSON.stringify(replay), JSON.stringify(original));
});

test("rolls back confirmation consumption when atomic receipt persistence fails", async (t) => {
	const filePath = await databasePath(t, "confirmation-rollback");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	await createFixtureLocation(store, { locationId: "location_south" });
	const input = previewInput();
	let operations = boundary(store, { receiptIds: ["rcpt_duplicate"] });
	const proposed = await operations.preview(input, { principal });
	const directSet = createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T12:00:00.000Z"),
		createReceiptId: () => "rcpt_duplicate",
	});
	await directSet(
		commandFromPreview(
			previewInput({ locationId: "location_south", value: "2" }),
			{ commandId: "cmd_south" },
		),
		{ principal },
	);

	await assert.rejects(
		() =>
			operations.confirm(
				proposed.confirmation.value,
				commandFromPreview(input),
				{ principal },
			),
		/UNIQUE|constraint/iu,
	);
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
		}),
		null,
	);

	operations = boundary(store, {
		confirmations: [],
		receiptIds: ["rcpt_retry"],
	});
	const retry = await operations.confirm(
		proposed.confirmation.value,
		commandFromPreview(input),
		{ principal },
	);
	assert.equal(retry.outcome, "committed");
	assert.equal(retry.receipt.receiptId, "rcpt_retry");
});

test("stores and replays a business rejection after a valid confirmation", async (t) => {
	const filePath = await databasePath(t, "business-rejection");
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store);
	const clock = { value: new Date("2026-08-28T12:00:00.000Z") };
	const proposedInput = previewInput({ value: "7" });
	let operations = boundary(store, {
		clock,
		receiptIds: ["rcpt_unexpected"],
	});
	const proposed = await operations.preview(proposedInput, { principal });
	const directSet = createSetOpeningBalance({
		store,
		now: () => new Date(clock.value),
		createReceiptId: () => "rcpt_first",
	});
	await directSet(
		commandFromPreview(previewInput({ value: "5" }), {
			commandId: "cmd_first",
		}),
		{ principal },
	);
	const rejectedCommand = commandFromPreview(proposedInput, {
		commandId: "cmd_rejected",
	});
	const rejected = await operations.confirm(
		proposed.confirmation.value,
		rejectedCommand,
		{ principal },
	);
	assert.deepEqual(rejected, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_rejected",
		code: "opening_balance_already_set",
		message: "This SKU-location already has committed stock history.",
	});
	await store.close();

	clock.value = new Date("2026-08-28T12:30:00.000Z");
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	operations = boundary(store, { clock, confirmations: [], receiptIds: [] });
	const replay = await operations.confirm(
		proposed.confirmation.value,
		rejectedCommand,
		{ principal },
	);
	assert.equal(JSON.stringify(replay), JSON.stringify(rejected));
});
