import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createPackSomeStock,
	createPackStock,
	createReadSkuLocationBalance,
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
		join(tmpdir(), `dinkuskit-inventory-pack-some-${label}-`),
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
}

function packSomeCommand(quantity, commandId = "cmd_pack_some_hat") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.pack_some",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: {
			reservationId: "rsv_hat_001",
			quantity: { value: quantity, unit: "each" },
		},
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

test("pack some of a hold leaves the leftover reserved on the same ticket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "partial"),
	});
	await seedHats(store);
	await reserveThree(store);
	const packed = await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some",
	})(packSomeCommand("1"), { principal });
	assert.equal(packed.outcome, "packed_some");
	assert.equal(packed.reservation.reservationId, "rsv_hat_001");
	assert.equal(packed.reservation.status, "partially_packed");
	assert.equal(packed.reservation.quantity.value, "2");
	assert.equal(packed.reservation.packedAt, null);
	const hat = await readHat(store);
	assert.equal(hat.onHand.value, "9");
	assert.equal(hat.reserved.value, "2");
	assert.equal(hat.available.value, "7");
});

test("packing the last remaining bags finishes the ticket as packed", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "finish"),
	});
	await seedHats(store);
	await reserveThree(store);
	await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some_first",
	})(packSomeCommand("1", "cmd_pack_some_first"), { principal });
	const finished = await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:06:00.000Z"),
		createReceiptId: () => "rcpt_pack_some_last",
	})(packSomeCommand("2", "cmd_pack_some_last"), { principal });
	assert.equal(finished.outcome, "packed");
	assert.equal(finished.reservation.status, "packed");
	assert.equal(finished.reservation.quantity.value, "0");
	const hat = await readHat(store);
	assert.equal(hat.onHand.value, "7");
	assert.equal(hat.reserved.value, "0");
	assert.equal(hat.available.value, "7");
});

test("packing the full remaining quantity skips partial and packs", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "full"),
	});
	await seedHats(store);
	await reserveThree(store);
	const packed = await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some_all",
	})(packSomeCommand("3"), { principal });
	assert.equal(packed.outcome, "packed");
	assert.equal(packed.reservation.status, "packed");
	assert.equal(packed.reservation.quantity.value, "0");
});

test("asking for more hats than the ticket has packs none", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "over"),
	});
	await seedHats(store);
	await reserveThree(store);
	const stopped = await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some_over",
	})(packSomeCommand("4", "cmd_pack_some_over"), { principal });
	assert.equal(stopped.outcome, "rejected");
	assert.equal(stopped.code, "reservation_quantity_exceeds_hold");
	const leftover = await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:06:00.000Z"),
		createReceiptId: () => "rcpt_pack_some_one",
	})(packSomeCommand("1", "cmd_pack_some_one"), { principal });
	assert.equal(leftover.outcome, "packed_some");
	assert.equal(leftover.reservation.quantity.value, "2");
	const hat = await readHat(store);
	assert.equal(hat.onHand.value, "9");
	assert.equal(hat.reserved.value, "2");
});

test("pack some replay returns the original result", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "replay"),
	});
	await seedHats(store);
	await reserveThree(store);
	const pack = createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some",
	});
	const first = await pack(packSomeCommand("1"), { principal });
	const second = await pack(packSomeCommand("1"), { principal });
	assert.deepEqual(second, first);
});

test("one-hold pack can finish a partially packed ticket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "pack-rest"),
	});
	await seedHats(store);
	await reserveThree(store);
	await createPackSomeStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_some",
	})(packSomeCommand("1"), { principal });
	const packed = await createPackStock({
		store,
		now: () => new Date("2026-09-25T12:06:00.000Z"),
		createReceiptId: () => "rcpt_pack_rest",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_rest",
			type: "stock.pack",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
		{ principal },
	);
	assert.equal(packed.outcome, "packed");
	assert.equal(packed.reservation.status, "packed");
	const hat = await readHat(store);
	assert.equal(hat.onHand.value, "7");
	assert.equal(hat.reserved.value, "0");
});
