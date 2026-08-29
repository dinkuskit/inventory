import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createPreviewOpeningBalance,
	createReadSkuStock,
	createRegisterManagedSku,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_operator",
	displayName: "Inventory Operator",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(join(tmpdir(), `dinkuskit-inventory-managed-sku-${label}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function registerCommand({
	commandId = "cmd_register_hat",
	poolId = "pool_test",
	sku = "HAT-BLACK",
	displayNameIfNew = "Black Logo Hat",
} = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "sku.register",
		context: { siteId: "site_test", poolId },
		payload: { sku, displayNameIfNew, unit: "each" },
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
		context: { siteId: "site_test", poolId, locationId },
		payload: {
			skuId: "inventory_hat_black",
			quantity: { value: "4", unit },
		},
		reason: { code: "physical_count", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [
			{ skuId: "inventory_hat_black", locationId, version: "0" },
		],
	};
}

function register(store, createInventorySkuId = () => "inventory_hat_black") {
	return createRegisterManagedSku({
		store,
		now: () => new Date("2026-08-28T17:00:00.000Z"),
		createInventorySkuId,
	});
}

test("preserves command identity and rejects unsupported registration contents", async (t) => {
	const store = createLocalSqliteTestStore({ filePath: await databasePath(t, "validation") });
	t.after(() => store.close());
	const execute = register(store);
	const first = await execute(registerCommand(), { principal });

	assert.deepEqual(
		await execute(
			registerCommand({ commandId: "cmd_register_hat", sku: "HAT-GREEN" }),
			{ principal },
		),
		{
			schema: "dinkuskit.inventory.command-result/v1",
			outcome: "rejected",
			commandId: "cmd_register_hat",
			code: "command_id_conflict",
			message: "The command ID is already bound to different contents.",
		},
	);
	assert.deepEqual((await store.readCommand("cmd_register_hat")).result, first);

	for (const input of [
		registerCommand({ sku: " " }),
		registerCommand({ displayNameIfNew: " " }),
		{
			...registerCommand(),
			payload: { sku: "HAT-BLACK", displayNameIfNew: "Hat", unit: "case" },
		},
		{
			...registerCommand(),
			payload: {
				sku: "HAT-BLACK",
				displayNameIfNew: "Hat",
				unit: "each",
				price: "19.99",
			},
		},
		{ ...registerCommand(), reason: { note: "setup" } },
	]) {
		await assert.rejects(() => execute(input, { principal }), {
			name: "InvalidManagedSkuCommandError",
		});
	}
});

test("rolls back the new command when a generated Inventory identity collides", async (t) => {
	const store = createLocalSqliteTestStore({ filePath: await databasePath(t, "rollback") });
	t.after(() => store.close());
	await register(store)(registerCommand(), { principal });

	await assert.rejects(() =>
		register(store)(
			registerCommand({ commandId: "cmd_register_green", sku: "HAT-GREEN" }),
			{ principal },
		),
	);
	assert.equal(await store.readCommand("cmd_register_green"), null);
	assert.equal(
		(await store.readManagedSku({
			poolId: "pool_test",
			skuId: "inventory_hat_black",
		})).sku,
		"HAT-BLACK",
	);
});

test("uses registered hidden identity for logical zero and opening admission", async (t) => {
	const store = createLocalSqliteTestStore({ filePath: await databasePath(t, "zero") });
	t.after(() => store.close());
	await createFixtureLocation(store, { locationId: "location_home", name: "Home" });
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
	assert.equal((await setOpeningBalance(openingInput, { principal })).code, "sku_not_registered");

	await register(store)(registerCommand(), { principal });
	assert.equal(
		(await createReadSkuStock({ store })({
			poolId: "pool_test",
			skuId: "HAT-BLACK",
			scope: { kind: "all_locations" },
		})).outcome,
		"not_found",
	);
	const found = await createReadSkuStock({ store })({
		poolId: "pool_test",
		skuId: "inventory_hat_black",
		scope: { kind: "all_locations" },
	});
	assert.equal(found.outcome, "found");
	assert.equal(found.locations.length, 2);
	assert.deepEqual(found.stock.onHand, { value: "0", unit: "each" });
});

test("blocks opening preview before registration and rejects a mismatched unit", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "opening-admission"),
	});
	t.after(() => store.close());
	await createFixtureLocation(store, { locationId: "location_home", name: "Home" });
	const previewInput = {
		schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
		type: "stock.opening_balance",
		context: { siteId: "site_test", poolId: "pool_test", locationId: "location_home" },
		payload: {
			skuId: "inventory_hat_black",
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
		(error) => error?.code === "sku_not_registered",
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
	assert.equal(mismatch.code, "sku_unit_mismatch");
});
