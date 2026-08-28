import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createReadSkuStock,
	createPreviewOpeningBalance,
	createRegisterManagedSku,
	createSetOpeningBalance,
	REGISTER_MANAGED_SKU_TYPE,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_bobby",
	displayName: "Bobby",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-managed-sku-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function registerCommand({
	commandId = "cmd_register_hat",
	poolId = "pool_test",
	skuId = "HAT-BLACK",
} = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "sku.register",
		context: { siteId: "site_smokyclub", poolId },
		payload: { skuId, unit: "each" },
		references: [{ kind: "commerce_product", id: "product_hat_black" }],
	};
}

function openingBalanceCommand({
	commandId = "cmd_open_hat",
	poolId = "pool_test",
	locationId = "location_home",
	unit = "each",
} = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: { siteId: "site_smokyclub", poolId, locationId },
		payload: {
			skuId: "HAT-BLACK",
			quantity: { value: "4", unit },
		},
		reason: { code: "physical_count", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [
			{ skuId: "HAT-BLACK", locationId, version: "0" },
		],
	};
}

function register(store, { now, receiptId } = {}) {
	return createRegisterManagedSku({
		store,
		now: now ?? (() => new Date("2026-08-28T17:00:00.000Z")),
		createReceiptId: receiptId ?? (() => "rcpt_register_hat"),
	});
}

test("registers one SKU atomically, freezes the actor, and exactly replays after reopen", async (t) => {
	assert.equal(REGISTER_MANAGED_SKU_TYPE, "sku.register");
	const filePath = await databasePath(t, "replay");
	let store = createLocalSqliteTestStore({ filePath });
	let receiptIds = 0;
	const execute = register(store, {
		receiptId: () => {
			receiptIds += 1;
			return "rcpt_register_hat";
		},
	});
	const input = registerCommand();
	const first = await execute(input, { principal });
	const replay = await execute(input, { principal });

	assert.equal(first.outcome, "committed");
	assert.equal(JSON.stringify(replay), JSON.stringify(first));
	assert.equal(receiptIds, 1);
	assert.deepEqual(first.receipt, {
		schema: "dinkuskit.inventory.receipt/v2",
		receiptId: "rcpt_register_hat",
		commandId: "cmd_register_hat",
		commandDigest: first.receipt.commandDigest,
		status: "committed",
		type: "sku.register",
		committedAt: "2026-08-28T17:00:00.000Z",
		principal,
		context: { siteId: "site_smokyclub", poolId: "pool_test" },
		effect: {
			before: null,
			after: {
				poolId: "pool_test",
				skuId: "HAT-BLACK",
				unit: "each",
				version: "1",
				registeredAt: "2026-08-28T17:00:00.000Z",
			},
		},
		references: [{ kind: "commerce_product", id: "product_hat_black" }],
	});
	assert.equal(Object.hasOwn(first.receipt, "reason"), false);

	await store.close();
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	assert.deepEqual(
		await store.readManagedSku({ poolId: "pool_test", skuId: "HAT-BLACK" }),
		first.receipt.effect.after,
	);
	assert.deepEqual(await store.readReceipt("rcpt_register_hat"), first.receipt);
	assert.deepEqual(
		await store.readCommand("cmd_register_hat"),
		{
			commandId: "cmd_register_hat",
			commandDigest: first.receipt.commandDigest,
			result: first,
		},
	);
});

test("durably reports already set up and preserves command-content identity", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "conflicts"),
	});
	t.after(() => store.close());
	await register(store)(registerCommand(), { principal });

	const duplicateInput = registerCommand({ commandId: "cmd_register_again" });
	const duplicate = await register(store, {
		receiptId: () => {
			throw new Error("an already registered SKU must not mint a receipt");
		},
	})(duplicateInput, { principal });
	assert.deepEqual(duplicate, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_register_again",
		code: "sku_already_registered",
		message: "This SKU is already set up.",
	});
	assert.deepEqual(
		await register(store, {
			receiptId: () => {
				throw new Error("a rejection replay must not mint a receipt");
			},
		})(duplicateInput, { principal }),
		duplicate,
	);

	const conflict = await register(store)(
		registerCommand({
			commandId: "cmd_register_again",
			skuId: "HAT-GREEN",
		}),
		{ principal },
	);
	assert.deepEqual(conflict, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_register_again",
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	});
	assert.deepEqual((await store.readCommand("cmd_register_again")).result, duplicate);
});

test("accepts only the small SKU-only each-unit command", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "validation"),
	});
	t.after(() => store.close());
	const execute = register(store);

	for (const input of [
		registerCommand({ skuId: " " }),
		{
			...registerCommand(),
			payload: { skuId: "HAT-BLACK", unit: "case" },
		},
		{
			...registerCommand(),
			payload: {
				skuId: "HAT-BLACK",
				unit: "each",
				name: "Black Logo Hat",
			},
		},
		{
			...registerCommand(),
			reason: { code: "setup", note: "Manage stock enabled" },
		},
	]) {
		await assert.rejects(() => execute(input, { principal }), {
			name: "InvalidManagedSkuCommandError",
		});
	}
});

test("rolls back the SKU and command when its immutable receipt conflicts", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "rollback"),
	});
	t.after(() => store.close());
	await register(store)(registerCommand(), { principal });

	await assert.rejects(
		() =>
			register(store, { receiptId: () => "rcpt_register_hat" })(
				registerCommand({
					commandId: "cmd_register_green",
					skuId: "HAT-GREEN",
				}),
				{ principal },
			),
	);
	assert.equal(
		await store.readManagedSku({ poolId: "pool_test", skuId: "HAT-GREEN" }),
		null,
	);
	assert.equal(await store.readCommand("cmd_register_green"), null);
});

test("makes registered stock visible at zero and rejects unregistered opening stock durably", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "zero"),
	});
	t.after(() => store.close());
	await createFixtureLocation(store, {
		locationId: "location_home",
		name: "Home",
	});
	await createFixtureLocation(store, {
		locationId: "location_warehouse",
		name: "Warehouse",
	});

	const openingInput = openingBalanceCommand();
	const setOpeningBalance = createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T17:05:00.000Z"),
		createReceiptId: () => {
			throw new Error("unregistered stock must not mint a receipt");
		},
	});
	const rejected = await setOpeningBalance(openingInput, { principal });
	assert.deepEqual(rejected, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_open_hat",
		code: "sku_not_registered",
		message: "This SKU is not set up for inventory.",
	});

	await register(store)(registerCommand(), { principal });
	assert.deepEqual(
		await createReadSkuStock({ store })({
			poolId: "pool_test",
			skuId: "HAT-BLACK",
			scope: { kind: "all_locations" },
		}),
		{
			schema: "dinkuskit.inventory.sku-stock-read-result/v1",
			outcome: "found",
			poolId: "pool_test",
			skuId: "HAT-BLACK",
			scope: { kind: "all_locations" },
			stock: {
				onHand: { value: "0", unit: "each" },
				reserved: { value: "0", unit: "each" },
				available: { value: "0", unit: "each" },
			},
			locations: [
				{
					locationId: "location_home",
					name: "Home",
					stock: {
						onHand: { value: "0", unit: "each" },
						reserved: { value: "0", unit: "each" },
						available: { value: "0", unit: "each" },
					},
				},
				{
					locationId: "location_warehouse",
					name: "Warehouse",
					stock: {
						onHand: { value: "0", unit: "each" },
						reserved: { value: "0", unit: "each" },
						available: { value: "0", unit: "each" },
					},
				},
			],
		},
	);
	assert.deepEqual(
		await createSetOpeningBalance({
			store,
			now: () => new Date("2026-08-28T18:00:00.000Z"),
			createReceiptId: () => {
				throw new Error("a durable rejection replay must not mint a receipt");
			},
		})(openingInput, { principal }),
		rejected,
	);
});

test("blocks opening previews before registration and durably rejects a mismatched unit", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "opening-admission"),
	});
	t.after(() => store.close());
	await createFixtureLocation(store, {
		locationId: "location_home",
		name: "Home",
	});
	const previewInput = {
		schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
		type: "stock.opening_balance",
		context: {
			siteId: "site_smokyclub",
			poolId: "pool_test",
			locationId: "location_home",
		},
		payload: {
			skuId: "HAT-BLACK",
			quantity: { value: "4", unit: "each" },
		},
		reason: { code: "physical_count", note: "Set Initial Stock" },
		references: [],
	};
	await assert.rejects(
		() =>
			createPreviewOpeningBalance({
				store,
				now: () => new Date("2026-08-28T17:00:00.000Z"),
				createConfirmation: () => "confirm_unregistered",
			})(previewInput, { principal }),
		(error) =>
			error?.name === "OpeningBalancePreviewError" &&
			error?.code === "sku_not_registered",
	);

	await register(store)(registerCommand(), { principal });
	const mismatch = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T17:05:00.000Z"),
		createReceiptId: () => {
			throw new Error("a unit mismatch must not mint a receipt");
		},
	})(openingBalanceCommand({ commandId: "cmd_open_case", unit: "case" }), {
		principal,
	});
	assert.deepEqual(mismatch, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_open_case",
		code: "sku_unit_mismatch",
		message: "The stock quantity unit does not match this SKU.",
	});
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_home",
			skuId: "HAT-BLACK",
		}),
		null,
	);
});
