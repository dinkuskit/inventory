import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createReadSkuStock,
	createRegisterManagedSku,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_operator",
	displayName: "Inventory Operator",
	surface: "emdash",
});

async function storeFor(t, label) {
	const directory = await mkdtemp(join(tmpdir(), `inventory-register-return-${label}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = createLocalSqliteTestStore({
		filePath: join(directory, "inventory.sqlite"),
	});
	t.after(() => store.close());
	return store;
}

function command({
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

test("new registration mints a hidden identity and stores setup audit without a stock receipt", async (t) => {
	const store = await storeFor(t, "new");
	let ids = 0;
	const execute = createRegisterManagedSku({
		store,
		now: () => new Date("2026-08-28T22:30:00.000Z"),
		createInventorySkuId: () => {
			ids += 1;
			return "inventory_sku_hidden_1";
		},
	});

	const first = await execute(command(), { principal });
	const replay = await execute(command(), { principal });

	assert.deepEqual(first, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "registered",
		commandId: "cmd_register_hat",
		inventorySku: {
			inventorySkuId: "inventory_sku_hidden_1",
			sku: "HAT-BLACK",
			displayName: "Black Logo Hat",
		},
	});
	assert.deepEqual(replay, first);
	assert.equal(ids, 1);
	assert.equal("receipt" in first, false);
	assert.deepEqual(
		await store.readManagedSku({
			poolId: "pool_test",
			skuId: "inventory_sku_hidden_1",
		}),
		{
			poolId: "pool_test",
			inventorySkuId: "inventory_sku_hidden_1",
			sku: "HAT-BLACK",
			displayName: "Black Logo Hat",
			unit: "each",
			version: "1",
			registeredAt: "2026-08-28T22:30:00.000Z",
			registeredBy: principal,
		},
	);
	assert.equal(await store.readReceipt("inventory_sku_hidden_1"), null);
});

test("existing visible SKU atomically returns its original record for Commerce review", async (t) => {
	const store = await storeFor(t, "existing");
	let ids = 0;
	const execute = createRegisterManagedSku({
		store,
		now: () => new Date("2026-08-28T22:31:00.000Z"),
		createInventorySkuId: () => {
			ids += 1;
			return `inventory_sku_hidden_${ids}`;
		},
	});
	await execute(command(), { principal });

	const existingCommand = command({
		commandId: "cmd_register_hat_again",
		displayNameIfNew: "A different storefront title",
	});
	const existing = await execute(existingCommand, { principal });
	const replay = await execute(existingCommand, { principal });

	assert.deepEqual(existing, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "existing",
		commandId: "cmd_register_hat_again",
		inventorySku: {
			inventorySkuId: "inventory_sku_hidden_1",
			sku: "HAT-BLACK",
			displayName: "Black Logo Hat",
		},
	});
	assert.deepEqual(replay, existing);
	assert.equal(ids, 1);
	assert.equal("receipt" in existing, false);
	assert.deepEqual((await store.readCommand("cmd_register_hat_again")).result, existing);
});

test("stock APIs resolve only the permanent Inventory identity", async (t) => {
	const store = await storeFor(t, "identity");
	await createFixtureLocation(store, {
		locationId: "location_home",
		name: "Home",
	});
	await createRegisterManagedSku({
		store,
		now: () => new Date("2026-08-28T22:32:00.000Z"),
		createInventorySkuId: () => "inventory_sku_hidden_1",
	})(command(), { principal });

	const read = createReadSkuStock({ store });
	assert.equal(
		(await read({
			poolId: "pool_test",
			skuId: "HAT-BLACK",
			scope: { kind: "all_locations" },
		})).outcome,
		"not_found",
	);
	assert.deepEqual(
		await read({
			poolId: "pool_test",
			skuId: "inventory_sku_hidden_1",
			scope: { kind: "all_locations" },
		}),
		{
			schema: "dinkuskit.inventory.sku-stock-read-result/v1",
			outcome: "found",
			poolId: "pool_test",
			skuId: "inventory_sku_hidden_1",
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
			],
		},
	);
});
