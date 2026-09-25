import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
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
		join(tmpdir(), `dinkuskit-inventory-pack-${label}-`),
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

function reserveCommand() {
	return {
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
	};
}

function packCommand(overrides = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_pack_hat",
		type: "stock.pack",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: { reservationId: "rsv_hat_001" },
		references: [],
		...overrides,
	};
}

test("pack consumes the full hold and leaves available unchanged", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "happy"),
	});
	await seedHats(store);
	await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	})(reserveCommand(), { principal });
	const packed = await createPackStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_hat",
	})(packCommand(), { principal });
	assert.equal(packed.outcome, "packed");
	assert.equal(packed.reservation.status, "packed");
	assert.equal(packed.reservation.packedAt, "2026-09-25T12:05:00.000Z");
	const read = createReadSkuLocationBalance({ store });
	const found = await read({
		poolId: "pool_test",
		locationId: "location_north",
		skuId: "sku_hat",
	});
	assert.equal(found.outcome, "found");
	assert.equal(found.balance.onHand.value, "7");
	assert.equal(found.balance.reserved.value, "0");
	assert.equal(found.balance.available.value, "7");
});

test("pack replay returns the original packed result", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "replay"),
	});
	await seedHats(store);
	await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	})(reserveCommand(), { principal });
	const pack = createPackStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_hat",
	});
	const first = await pack(packCommand(), { principal });
	const second = await pack(packCommand(), { principal });
	assert.deepEqual(second, first);
});

test("pack rejects canceled and already packed holds", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "reject"),
	});
	await seedHats(store);
	await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	})(reserveCommand(), { principal });
	await createReleaseStock({
		store,
		now: () => new Date("2026-09-25T12:01:00.000Z"),
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
	const canceled = await createPackStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_canceled",
	})(packCommand({ commandId: "cmd_pack_canceled" }), { principal });
	assert.equal(canceled.outcome, "rejected");
	assert.equal(canceled.code, "reservation_not_active");
});

test("pack rejects an already packed hold", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "already"),
	});
	await seedHats(store);
	await createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	})(reserveCommand(), { principal });
	const pack = createPackStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_pack_hat",
	});
	assert.equal((await pack(packCommand(), { principal })).outcome, "packed");
	const again = await pack(
		packCommand({ commandId: "cmd_pack_again" }),
		{ principal },
	);
	assert.equal(again.outcome, "rejected");
	assert.equal(again.code, "reservation_already_packed");
});
