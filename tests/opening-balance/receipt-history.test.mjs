import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as inventory from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_history",
	displayName: "History Operator",
	surface: "emdash",
});

async function databasePath(t) {
	const directory = await mkdtemp(
		join(tmpdir(), "dinkuskit-inventory-history-"),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function commit(
	store,
	{
		commandId,
		receiptId,
		committedAt,
		poolId = "pool_test",
		locationId,
		skuId,
		reason = "Set Initial Stock",
	},
) {
	const setOpeningBalance = inventory.createSetOpeningBalance({
		store,
		now: () => new Date(committedAt),
		createReceiptId: () => receiptId,
	});
	return setOpeningBalance(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId,
			type: "stock.opening_balance",
			context: { siteId: "site_test", poolId, locationId },
			payload: {
				skuId,
				quantity: { value: "1", unit: "each" },
			},
			reason: { code: "physical_count", note: reason },
			references: [],
			expectedVersions: [{ skuId, locationId, version: "0" }],
		},
		{ principal },
	);
}

test("reads one location or all locations from the same durable receipt ledger", async (t) => {
	const filePath = await databasePath(t);
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store, { locationId: "location_north" });
	await createFixtureLocation(store, { locationId: "location_south" });
	await createFixtureLocation(store, {
		poolId: "pool_other",
		locationId: "location_north",
	});
	await commit(store, {
		commandId: "cmd_north_old",
		receiptId: "rcpt_north_old",
		committedAt: "2026-08-28T12:00:00.000Z",
		locationId: "location_north",
		skuId: "sku_hat_black",
	});
	await commit(store, {
		commandId: "cmd_south",
		receiptId: "rcpt_south",
		committedAt: "2026-08-28T12:01:00.000Z",
		locationId: "location_south",
		skuId: "sku_hat_black",
	});
	await commit(store, {
		commandId: "cmd_north_new",
		receiptId: "rcpt_north_new",
		committedAt: "2026-08-28T12:02:00.000Z",
		locationId: "location_north",
		skuId: "sku_hat_green",
		reason: "Set Initial Stock - green hats",
	});
	await commit(store, {
		commandId: "cmd_north_tie",
		receiptId: "rcpt_north_tie",
		committedAt: "2026-08-28T12:02:00.000Z",
		locationId: "location_north",
		skuId: "sku_hat_blue",
	});
	await commit(store, {
		commandId: "cmd_other_pool",
		receiptId: "rcpt_other_pool",
		committedAt: "2026-08-28T12:03:00.000Z",
		poolId: "pool_other",
		locationId: "location_north",
		skuId: "sku_hat_other",
	});
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const readHistory = inventory.createReadReceiptHistory({ store });
	const north = await readHistory({
		poolId: " pool_test ",
		scope: { kind: "location", locationId: " location_north " },
		limit: 10,
	});

	assert.deepEqual(north.scope, {
		kind: "location",
		locationId: "location_north",
	});
	assert.deepEqual(
		north.receipts.map((receipt) => receipt.receiptId),
		["rcpt_north_tie", "rcpt_north_new", "rcpt_north_old"],
	);
	assert.equal(north.next, null);
	assert.deepEqual(
		north.receipts.map((receipt) => receipt.effects[0].locationId),
		["location_north", "location_north", "location_north"],
	);
	assert.equal(
		north.receipts[1].reason.note,
		"Set Initial Stock - green hats",
	);

	const firstPage = await readHistory({
		poolId: "pool_test",
		scope: { kind: "all_locations" },
		limit: 2,
	});
	assert.equal(
		firstPage.schema,
		"dinkuskit.inventory.receipt-history-read-result/v1",
	);
	assert.deepEqual(firstPage.scope, { kind: "all_locations" });
	assert.deepEqual(
		firstPage.receipts.map((receipt) => receipt.receiptId),
		["rcpt_north_tie", "rcpt_north_new"],
	);
	assert.deepEqual(firstPage.next, {
		committedAt: "2026-08-28T12:02:00.000Z",
		receiptId: "rcpt_north_new",
	});

	const secondPage = await readHistory({
		poolId: "pool_test",
		scope: { kind: "all_locations" },
		limit: 2,
		before: firstPage.next,
	});
	assert.deepEqual(
		secondPage.receipts.map((receipt) => receipt.receiptId),
		["rcpt_south", "rcpt_north_old"],
	);
	assert.equal(secondPage.next, null);
	assert.equal(
		secondPage.receipts.some(
			(receipt) => receipt.receiptId === "rcpt_other_pool",
		),
		false,
	);
});

test("rejects missing, ambiguous, and unbounded history scope", async (t) => {
	const filePath = await databasePath(t);
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const readHistory = inventory.createReadReceiptHistory({ store });

	for (const input of [
		{ poolId: "pool_test", scope: { kind: "location" } },
		{
			poolId: "pool_test",
			scope: { kind: "all_locations", locationId: "location_north" },
		},
		{ poolId: "pool_test", scope: { kind: "all" } },
		{ poolId: "pool_test", scope: { kind: "all_locations" }, limit: 0 },
		{ poolId: "pool_test", scope: { kind: "all_locations" }, limit: 101 },
		{
			poolId: "pool_test",
			scope: { kind: "all_locations" },
			before: { committedAt: "not-a-time", receiptId: "rcpt_test" },
		},
		{
			poolId: "pool_test",
			scope: { kind: "all_locations" },
			before: { committedAt: "2026-08-28T12:00:00.000Z" },
		},
	]) {
		await assert.rejects(
			() => readHistory(input),
			{ name: "InvalidInventoryReadQueryError" },
		);
	}
});
