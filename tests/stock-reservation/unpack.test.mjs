import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createPackSomeStock,
	createPackStock,
	createReadSkuLocationBalance,
	createReleaseStock,
	createReserveStock,
	createSetOpeningBalance,
	createUnpackStock,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "principal_test_operator",
	displayName: "Test Operator",
	surface: "test",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-unpack-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function seedHats(store) {
	await createFixtureLocation(store);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	const opening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-29T10:00:00.000Z"),
		createReceiptId: () => "rcpt_opening_hat",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_opening_hat",
			type: "stock.opening_balance",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
			reason: { code: "opening_balance", note: "Set Initial Stock" },
			references: [],
			expectedVersions: [
				{ skuId: "sku_hat", locationId: "location_north", version: "0" },
			],
		},
		{ principal },
	);
	assert.equal(opening.outcome, "committed");
}

async function reserveThree(store) {
	const held = await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_reserve_hat",
			type: "stock.reserve",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: {
				skuId: "sku_hat",
				quantity: { value: "3", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-1842" },
			},
			references: [],
		},
		{ principal },
	);
	assert.equal(held.outcome, "reserved");
	return held;
}

function unpackCommand(commandId = "cmd_unpack_hat") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.unpack",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: { reservationId: "rsv_hat_001" },
		references: [],
	};
}

async function readHat(store) {
	const found = await createReadSkuLocationBalance({ store })({
		poolId: "pool_test",
		locationId: "location_north",
		skuId: "sku_hat",
	});
	assert.equal(found.outcome, "found");
	return found.balance;
}

test("unpack restores a packed ticket to not shipped on the same ticket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "packed"),
	});
	await seedHats(store);
	await reserveThree(store);
	await createPackStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_hat",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_hat",
			type: "stock.pack",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
		{ principal },
	);
	const unpacked = await createUnpackStock({
		store,
		now: () => new Date("2026-09-25T12:10:00.000Z"),
		createReceiptId: () => "rcpt_unpack_hat",
	})(unpackCommand(), { principal });
	assert.equal(unpacked.outcome, "unpacked");
	assert.equal(unpacked.reservation.reservationId, "rsv_hat_001");
	assert.equal(unpacked.reservation.status, "not_shipped");
	assert.equal(unpacked.reservation.quantity.value, "3");
	assert.equal(unpacked.reservation.originalQuantity.value, "3");
	assert.equal(unpacked.reservation.packedAt, null);
	const hat = await readHat(store);
	assert.equal(hat.onHand.value, "10");
	assert.equal(hat.reserved.value, "3");
	assert.equal(hat.available.value, "7");
});

test("unpack of pack-some remainder joins leftover on the same not-shipped ticket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "partial"),
	});
	await seedHats(store);
	await reserveThree(store);
	await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_some_hat",
			type: "stock.pack_some",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: {
				reservationId: "rsv_hat_001",
				quantity: { value: "1", unit: "each" },
			},
			references: [],
		},
		{ principal },
	);
	const unpacked = await createUnpackStock({
		store,
		now: () => new Date("2026-09-25T12:10:00.000Z"),
		createReceiptId: () => "rcpt_unpack_hat",
	})(unpackCommand(), { principal });
	assert.equal(unpacked.outcome, "unpacked");
	assert.equal(unpacked.reservation.status, "not_shipped");
	assert.equal(unpacked.reservation.quantity.value, "3");
	const hat = await readHat(store);
	assert.equal(hat.onHand.value, "10");
	assert.equal(hat.reserved.value, "3");
	assert.equal(hat.available.value, "7");
	const again = await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:11:00.000Z"),
		createReservationId: () => "must_not_mint",
		createReceiptId: () => "must_not_write",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_reserve_hat_retry",
			type: "stock.reserve",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: {
				skuId: "sku_hat",
				quantity: { value: "3", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-1842" },
			},
			references: [],
		},
		{ principal },
	);
	assert.equal(again.outcome, "existing");
	assert.equal(again.reservation.reservationId, "rsv_hat_001");
	assert.equal(again.reservation.quantity.value, "3");
});

test("unpack replay returns the original unpacked result", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "replay"),
	});
	await seedHats(store);
	await reserveThree(store);
	await createPackStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_hat",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_hat",
			type: "stock.pack",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
		{ principal },
	);
	const unpack = createUnpackStock({
		store,
		now: () => new Date("2026-09-25T12:10:00.000Z"),
		createReceiptId: () => "rcpt_unpack_hat",
	});
	const first = await unpack(unpackCommand(), { principal });
	const second = await unpack(unpackCommand(), { principal });
	assert.deepEqual(second, first);
});

test("unpack rejects not-shipped and canceled tickets", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "reject"),
	});
	await seedHats(store);
	await reserveThree(store);
	const unpack = createUnpackStock({
		store,
		now: () => new Date("2026-09-25T12:10:00.000Z"),
		createReceiptId: () => "rcpt_unpack_hat",
	});
	const notPacked = await unpack(unpackCommand("cmd_unpack_open"), {
		principal,
	});
	assert.equal(notPacked.outcome, "rejected");
	assert.equal(notPacked.code, "reservation_not_packed");
	await createReleaseStock({
		store,
		now: () => new Date("2026-09-25T12:11:00.000Z"),
		createReceiptId: () => "rcpt_release_hat",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_release_hat",
			type: "stock.release",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
		{ principal },
	);
	const canceled = await unpack(unpackCommand("cmd_unpack_canceled"), {
		principal,
	});
	assert.equal(canceled.outcome, "rejected");
	assert.equal(canceled.code, "reservation_not_active");
});
