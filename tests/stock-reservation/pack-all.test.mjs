import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createPackAllStock,
	createPackStock,
	createReadSkuLocationBalance,
	createReleaseStock,
	createReserveStock,
	createSetOpeningBalance,
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
		join(tmpdir(), `dinkuskit-inventory-pack-all-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function openSku(store, skuId, quantity, commandId, receiptId) {
	const opening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-29T10:00:00.000Z"),
		createReceiptId: () => receiptId,
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId,
			type: "stock.opening_balance",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: { skuId, quantity: { value: quantity, unit: "each" } },
			reason: { code: "opening_balance", note: "Set Initial Stock" },
			references: [],
			expectedVersions: [
				{ skuId, locationId: "location_north", version: "0" },
			],
		},
		{ principal },
	);
	assert.equal(opening.outcome, "committed");
}

async function seedOrder(store) {
	await createFixtureLocation(store);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	await createFixtureManagedSku(store, { skuId: "sku_shirt" });
	await openSku(store, "sku_hat", "10", "cmd_opening_hat", "rcpt_opening_hat");
	await openSku(
		store,
		"sku_shirt",
		"6",
		"cmd_opening_shirt",
		"rcpt_opening_shirt",
	);
}

function reserveCommand(skuId, quantity, lineId, commandId, reservationId) {
	return {
		command: {
			schema: "dinkuskit.inventory.command/v1",
			commandId,
			type: "stock.reserve",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: {
				skuId,
				quantity: { value: quantity, unit: "each" },
				orderLine: { kind: "commerce.order_line", id: lineId },
			},
			references: [],
		},
		reservationId,
	};
}

async function reserveLine(store, skuId, quantity, lineId, commandId, reservationId) {
	const held = await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => reservationId,
		createReceiptId: () => `rcpt_${commandId}`,
	})(reserveCommand(skuId, quantity, lineId, commandId, reservationId).command, {
		principal,
	});
	assert.equal(held.outcome, "reserved");
	return held;
}

function packAllCommand(reservationIds, commandId = "cmd_pack_all") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.pack_all",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: { reservationIds },
		references: [],
	};
}

async function readBalance(store, skuId) {
	const found = await createReadSkuLocationBalance({ store })({
		poolId: "pool_test",
		locationId: "location_north",
		skuId,
	});
	assert.equal(found.outcome, "found");
	return found.balance;
}

test("pack all consumes every named hold in one shot", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "happy"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	await reserveLine(
		store,
		"sku_shirt",
		"2",
		"OL-1842-shirt",
		"cmd_reserve_shirt",
		"rsv_shirt",
	);
	const packed = await createPackAllStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_all",
	})(packAllCommand(["rsv_hat", "rsv_shirt"]), { principal });
	assert.equal(packed.outcome, "packed_all");
	assert.equal(packed.reservations.length, 2);
	assert.equal(packed.reservations[0].status, "packed");
	assert.equal(packed.reservations[1].status, "packed");
	const hat = await readBalance(store, "sku_hat");
	const shirt = await readBalance(store, "sku_shirt");
	assert.equal(hat.onHand.value, "7");
	assert.equal(hat.reserved.value, "0");
	assert.equal(hat.available.value, "7");
	assert.equal(shirt.onHand.value, "4");
	assert.equal(shirt.reserved.value, "0");
	assert.equal(shirt.available.value, "4");
});

test("pack all accepts one ticket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "one"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	const packed = await createPackAllStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_one",
	})(packAllCommand(["rsv_hat"]), { principal });
	assert.equal(packed.outcome, "packed_all");
	assert.equal(packed.reservations.length, 1);
	const hat = await readBalance(store, "sku_hat");
	assert.equal(hat.onHand.value, "7");
	assert.equal(hat.reserved.value, "0");
});

test("pack all replay returns the original packed result", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "replay"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	await reserveLine(
		store,
		"sku_shirt",
		"2",
		"OL-1842-shirt",
		"cmd_reserve_shirt",
		"rsv_shirt",
	);
	const pack = createPackAllStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_all",
	});
	const first = await pack(packAllCommand(["rsv_hat", "rsv_shirt"]), { principal });
	const second = await pack(packAllCommand(["rsv_hat", "rsv_shirt"]), { principal });
	assert.deepEqual(second, first);
});

test("pack all stops when one ticket is not active and leaves the rest reserved", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "stop"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	await reserveLine(
		store,
		"sku_shirt",
		"2",
		"OL-1842-shirt",
		"cmd_reserve_shirt",
		"rsv_shirt",
	);
	await createReleaseStock({
		store,
		now: () => new Date("2026-09-25T12:01:00.000Z"),
		createReceiptId: () => "rcpt_release_shirt",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_release_shirt",
			type: "stock.release",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_shirt" },
			references: [],
		},
		{ principal },
	);
	const stopped = await createPackAllStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_all_stop",
	})(packAllCommand(["rsv_hat", "rsv_shirt"], "cmd_pack_all_stop"), {
		principal,
	});
	assert.equal(stopped.outcome, "rejected");
	assert.equal(stopped.code, "reservation_not_active");
	const hat = await readBalance(store, "sku_hat");
	assert.equal(hat.onHand.value, "10");
	assert.equal(hat.reserved.value, "3");
	const leftover = await createPackStock({
		store,
		now: () => new Date("2026-09-25T12:06:00.000Z"),
		createReceiptId: () => "rcpt_pack_hat_leftover",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_hat_leftover",
			type: "stock.pack",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat" },
			references: [],
		},
		{ principal },
	);
	assert.equal(leftover.outcome, "packed");
	const packedHat = await readBalance(store, "sku_hat");
	assert.equal(packedHat.onHand.value, "7");
	assert.equal(packedHat.reserved.value, "0");
});
