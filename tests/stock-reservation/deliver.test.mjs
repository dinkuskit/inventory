import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createDeliverStock,
	createUndoDeliverStock,
	createPackAllStock,
	createPackSomeStock,
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
		join(tmpdir(), `dinkuskit-inventory-deliver-${label}-`),
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

async function reserveLine(store, skuId, quantity, lineId, commandId, reservationId) {
	const held = await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => reservationId,
		createReceiptId: () => `rcpt_${commandId}`,
	})(
		{
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
		{ principal },
	);
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

function deliverCommand(reservationIds, commandId = "cmd_deliver") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.deliver",
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

async function packTickets(store, reservationIds) {
	const packed = await createPackAllStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_all",
	})(packAllCommand(reservationIds), { principal });
	assert.equal(packed.outcome, "packed_all");
	return packed;
}

test("deliver marks every named packed ticket Delivered without moving counts", async (t) => {
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
	await packTickets(store, ["rsv_hat", "rsv_shirt"]);
	const hatBefore = await readBalance(store, "sku_hat");
	const shirtBefore = await readBalance(store, "sku_shirt");
	const delivered = await createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:10:00.000Z"),
		createReceiptId: () => "rcpt_deliver",
	})(deliverCommand(["rsv_hat", "rsv_shirt"]), { principal });
	assert.equal(delivered.outcome, "delivered");
	assert.equal(delivered.reservations.length, 2);
	assert.equal(delivered.reservations[0].status, "delivered");
	assert.equal(delivered.reservations[1].status, "delivered");
	assert.equal(delivered.receipt.effects.length, 0);
	const hat = await readBalance(store, "sku_hat");
	const shirt = await readBalance(store, "sku_shirt");
	assert.equal(hat.onHand.value, hatBefore.onHand.value);
	assert.equal(hat.reserved.value, hatBefore.reserved.value);
	assert.equal(hat.available.value, hatBefore.available.value);
	assert.equal(shirt.onHand.value, shirtBefore.onHand.value);
	assert.equal(shirt.reserved.value, shirtBefore.reserved.value);
	assert.equal(shirt.available.value, shirtBefore.available.value);
	assert.equal(hat.onHand.value, "7");
	assert.equal(hat.reserved.value, "0");
	assert.equal(hat.available.value, "7");
});

test("undo Delivered returns one ticket to Packed without moving counts and replays exactly", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "undo-deliver"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	await packTickets(store, ["rsv_hat"]);
	const delivered = await createDeliverStock({
		store, now: () => new Date("2026-09-26T12:10:00.000Z"), createReceiptId: () => "rcpt_deliver",
	})(deliverCommand(["rsv_hat"]), { principal });
	assert.equal(delivered.outcome, "delivered");
	const before = await readBalance(store, "sku_hat");
	const undo = createUndoDeliverStock({
		store, now: () => new Date("2026-09-26T12:11:00.000Z"), createReceiptId: () => "rcpt_undo_deliver",
	});
	const command = {
		schema: "dinkuskit.inventory.command/v1", commandId: "cmd_undo_deliver", type: "stock.undo_deliver",
		context: { siteId: "site_test", poolId: "pool_test" }, payload: { reservationId: "rsv_hat" }, references: [],
	};
	const first = await undo(command, { principal });
	assert.equal(first.outcome, "undelivered");
	assert.equal(first.reservation.status, "packed");
	assert.equal(first.receipt.effects.length, 0);
	assert.deepEqual(await readBalance(store, "sku_hat"), before);
	assert.deepEqual(await undo(command, { principal }), first);
	const again = await undo({ ...command, commandId: "cmd_undo_deliver_again" }, { principal });
	assert.equal(again.outcome, "rejected");
	assert.equal(again.code, "reservation_not_delivered");
});

test("deliver accepts one packed ticket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "one"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	await packTickets(store, ["rsv_hat"]);
	const delivered = await createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:10:00.000Z"),
		createReceiptId: () => "rcpt_deliver_one",
	})(deliverCommand(["rsv_hat"]), { principal });
	assert.equal(delivered.outcome, "delivered");
	assert.equal(delivered.reservations.length, 1);
	assert.equal(delivered.reservations[0].status, "delivered");
});

test("deliver replay returns the original delivered result", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "replay"),
	});
	await seedOrder(store);
	await reserveLine(store, "sku_hat", "3", "OL-1842-hat", "cmd_reserve_hat", "rsv_hat");
	await packTickets(store, ["rsv_hat"]);
	const deliver = createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:10:00.000Z"),
		createReceiptId: () => "rcpt_deliver",
	});
	const first = await deliver(deliverCommand(["rsv_hat"]), { principal });
	const second = await deliver(deliverCommand(["rsv_hat"]), { principal });
	assert.deepEqual(second, first);
});

test("deliver stops when one ticket is not fully packed and leaves the rest Packed", async (t) => {
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
	await packTickets(store, ["rsv_hat"]);
	const stopped = await createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:10:00.000Z"),
		createReceiptId: () => "rcpt_deliver_stop",
	})(deliverCommand(["rsv_hat", "rsv_shirt"], "cmd_deliver_stop"), { principal });
	assert.equal(stopped.outcome, "rejected");
	assert.equal(stopped.code, "reservation_not_packed");
	const leftover = await createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:11:00.000Z"),
		createReceiptId: () => "rcpt_deliver_hat_leftover",
	})(deliverCommand(["rsv_hat"], "cmd_deliver_hat_leftover"), { principal });
	assert.equal(leftover.outcome, "delivered");
});

test("deliver rejects not shipped, partially packed, canceled, missing, and already Delivered tickets", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "rejects"),
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
	const deliver = createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:10:00.000Z"),
		createReceiptId: () => "rcpt_deliver_reject",
	});
	const notShipped = await deliver(
		deliverCommand(["rsv_hat"], "cmd_deliver_not_shipped"),
		{ principal },
	);
	assert.equal(notShipped.outcome, "rejected");
	assert.equal(notShipped.code, "reservation_not_packed");

	await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:04:00.000Z"),
		createReceiptId: () => "rcpt_pack_some_hat",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_some_hat",
			type: "stock.pack_some",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: {
				reservationId: "rsv_hat",
				quantity: { value: "1", unit: "each" },
			},
			references: [],
		},
		{ principal },
	);
	const partial = await deliver(
		deliverCommand(["rsv_hat"], "cmd_deliver_partial"),
		{ principal },
	);
	assert.equal(partial.outcome, "rejected");
	assert.equal(partial.code, "reservation_not_packed");

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
	const canceled = await deliver(
		deliverCommand(["rsv_shirt"], "cmd_deliver_canceled"),
		{ principal },
	);
	assert.equal(canceled.outcome, "rejected");
	assert.equal(canceled.code, "reservation_not_active");

	const missing = await deliver(
		deliverCommand(["rsv_missing"], "cmd_deliver_missing"),
		{ principal },
	);
	assert.equal(missing.outcome, "rejected");
	assert.equal(missing.code, "reservation_not_found");

	await reserveLine(
		store,
		"sku_shirt",
		"2",
		"OL-1842-shirt-2",
		"cmd_reserve_shirt_2",
		"rsv_shirt_2",
	);
	await packTickets(store, ["rsv_shirt_2"]);
	const first = await createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:12:00.000Z"),
		createReceiptId: () => "rcpt_deliver_shirt_2",
	})(deliverCommand(["rsv_shirt_2"], "cmd_deliver_shirt_2"), { principal });
	assert.equal(first.outcome, "delivered");
	const already = await createDeliverStock({
		store,
		now: () => new Date("2026-09-26T12:13:00.000Z"),
		createReceiptId: () => "rcpt_deliver_again",
	})(deliverCommand(["rsv_shirt_2"], "cmd_deliver_again"), { principal });
	assert.equal(already.outcome, "rejected");
	assert.equal(already.code, "reservation_already_delivered");
});
