import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createReadSkuStock,
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
	id: "emdash_user_aggregate",
	displayName: "Bobby",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-aggregate-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function openingBalanceCommand({ commandId, locationId, value }) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId,
		},
		payload: {
			skuId: "sku_hat",
			quantity: { value, unit: "each" },
		},
		reason: {
			code: "physical_count",
			note: "Set Initial Stock",
		},
		references: [],
		expectedVersions: [
			{ skuId: "sku_hat", locationId, version: "0" },
		],
	};
}

async function setOpeningBalance(store, input, receiptId) {
	return createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T12:00:00.000Z"),
		createReceiptId: () => receiptId,
	})(input, { principal });
}

function location(locationId, name) {
	return {
		poolId: "pool_test",
		locationId,
		name,
		nameKey: name.toLocaleLowerCase("en-US"),
		status: "active",
		version: "1",
		createdAt: "2026-08-28T10:00:00.000Z",
		updatedAt: "2026-08-28T10:00:00.000Z",
		archivedAt: null,
	};
}

function balance(locationId, onHand, reserved, unit = "each") {
	return {
		poolId: "pool_test",
		locationId,
		skuId: "sku_hat",
		onHand: { value: onHand, unit },
		reserved: { value: reserved, unit },
		available: { value: "999", unit },
		version: "3",
		hasStockHistory: true,
	};
}

test("reads one location or all active locations from durable SQLite", async (t) => {
	const filePath = await databasePath(t, "local");
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store, {
		locationId: "location_home",
		name: "Home",
	});
	await createFixtureLocation(store, {
		locationId: "location_overflow",
		name: "Overflow",
	});
	await createFixtureLocation(store, {
		locationId: "location_warehouse",
		name: "Warehouse",
	});
	await createFixtureLocation(store, {
		locationId: "location_archived",
		name: "Archived",
	});
	await archiveFixtureLocation(store, {
		locationId: "location_archived",
		name: "Archived",
	});
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	await setOpeningBalance(
		store,
		openingBalanceCommand({
			commandId: "cmd_home",
			locationId: "location_home",
			value: "5.25",
		}),
		"rcpt_home",
	);
	await setOpeningBalance(
		store,
		openingBalanceCommand({
			commandId: "cmd_warehouse",
			locationId: "location_warehouse",
			value: "7.5",
		}),
		"rcpt_warehouse",
	);
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const read = createReadSkuStock({ store });
	const all = await read({
		poolId: " pool_test ",
		skuId: " sku_hat ",
		scope: { kind: "all_locations" },
	});

	assert.deepEqual(all, {
		schema: "dinkuskit.inventory.sku-stock-read-result/v1",
		outcome: "found",
		poolId: "pool_test",
		skuId: "sku_hat",
		scope: { kind: "all_locations" },
		stock: {
			onHand: { value: "12.75", unit: "each" },
			reserved: { value: "0", unit: "each" },
			available: { value: "12.75", unit: "each" },
		},
		locations: [
			{
				locationId: "location_home",
				name: "Home",
				stock: {
					onHand: { value: "5.25", unit: "each" },
					reserved: { value: "0", unit: "each" },
					available: { value: "5.25", unit: "each" },
				},
			},
			{
				locationId: "location_overflow",
				name: "Overflow",
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
					onHand: { value: "7.5", unit: "each" },
					reserved: { value: "0", unit: "each" },
					available: { value: "7.5", unit: "each" },
				},
			},
		],
	});

	assert.deepEqual(
		await read({
			poolId: "pool_test",
			skuId: "sku_hat",
			scope: { kind: "location", locationId: " location_overflow " },
		}),
		{
			schema: "dinkuskit.inventory.sku-stock-read-result/v1",
			outcome: "found",
			poolId: "pool_test",
			skuId: "sku_hat",
			scope: { kind: "location", locationId: "location_overflow" },
			stock: {
				onHand: { value: "0", unit: "each" },
				reserved: { value: "0", unit: "each" },
				available: { value: "0", unit: "each" },
			},
			locations: [all.locations[1]],
		},
	);

	for (const [skuId, scope] of [
		["sku_missing", { kind: "all_locations" }],
		["sku_hat", { kind: "location", locationId: "location_archived" }],
		["sku_hat", { kind: "location", locationId: "location_missing" }],
	]) {
		assert.equal(
			(await read({ poolId: "pool_test", skuId, scope })).outcome,
			"not_found",
		);
	}
});

test("normalizes only an explicit location or all-locations scope", async () => {
	const read = createReadSkuStock({
		store: { readSkuActiveLocationSnapshot: async () => [] },
	});
	for (const input of [
		{},
		{ poolId: "pool_test", skuId: "sku_hat", scope: {} },
		{
			poolId: "pool_test",
			skuId: "sku_hat",
			scope: { kind: "location", locationId: "" },
		},
		{
			poolId: "pool_test",
			skuId: "sku_hat",
			scope: { kind: "all_locations", locationId: "location_home" },
		},
	]) {
		await assert.rejects(() => read(input), {
			name: "InvalidInventoryReadQueryError",
		});
	}
});

test("sums signed exact decimals, derives available, and fails closed on mixed units", async () => {
	const snapshots = [
		{
			location: location("location_a", "A"),
			balance: balance("location_a", "-2.5", "0.5"),
		},
		{
			location: location("location_b", "B"),
			balance: balance("location_b", "5.75", "1.25"),
		},
	];
	const read = createReadSkuStock({
		store: {
			readManagedSku: async () => ({
				poolId: "pool_test",
				skuId: "sku_hat",
				unit: "each",
				version: "1",
				registeredAt: "2026-08-28T09:00:00.000Z",
			}),
			readSkuActiveLocationSnapshot: async () => snapshots,
		},
	});
	const result = await read({
		poolId: "pool_test",
		skuId: "sku_hat",
		scope: { kind: "all_locations" },
	});
	assert.equal(result.outcome, "found");
	assert.deepEqual(result.stock, {
		onHand: { value: "3.25", unit: "each" },
		reserved: { value: "1.75", unit: "each" },
		available: { value: "1.5", unit: "each" },
	});
	assert.deepEqual(
		result.locations.map(({ stock }) => stock.available.value),
		["-3", "4.5"],
	);

	const mixed = createReadSkuStock({
		store: {
			readManagedSku: async () => ({
				poolId: "pool_test",
				skuId: "sku_hat",
				unit: "each",
				version: "1",
				registeredAt: "2026-08-28T09:00:00.000Z",
			}),
			readSkuActiveLocationSnapshot: async () => [
				snapshots[0],
				{
					location: location("location_b", "B"),
					balance: balance("location_b", "5.75", "0", "gram"),
				},
			],
		},
	});
	await assert.rejects(
		() =>
			mixed({
				poolId: "pool_test",
				skuId: "sku_hat",
				scope: { kind: "all_locations" },
			}),
		{ name: "InconsistentSkuStockUnitError" },
	);
});
