import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createExecuteStockTransferCommand,
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
		join(tmpdir(), `dinkuskit-inventory-reserve-${label}-`),
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

function reserveCommand(overrides = {}) {
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
		...overrides,
	};
}

test("reserve holds available stock and release returns it", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "happy"),
	});
	await seedHats(store);
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	});
	const result = await reserve(reserveCommand(), { principal });
	assert.equal(result.outcome, "reserved");
	assert.equal(result.reservation.reservationId, "rsv_hat_001");
	assert.equal(result.reservation.status, "active");
	const read = createReadSkuLocationBalance({ store });
	assert.deepEqual(
		(await read({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
		})).balance,
		{
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
			onHand: { value: "10", unit: "each" },
			reserved: { value: "3", unit: "each" },
			outgoingTransferCommitted: { value: "0", unit: "each" },
			available: { value: "7", unit: "each" },
			expected: { value: "0", unit: "each" },
			inTransit: { value: "0", unit: "each" },
			version: "2",
			hasStockHistory: true,
		},
	);
	assert.equal(
		(await reserve(reserveCommand(), { principal })).outcome,
		"reserved",
	);

	const release = createReleaseStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_release_hat",
	});
	const released = await release(
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
	assert.equal(released.outcome, "released");
	assert.equal(released.reservation.status, "canceled");
	assert.equal(
		(await read({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
		})).balance.available.value,
		"10",
	);
	assert.equal(
		(await read({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_hat",
		})).balance.reserved.value,
		"0",
	);
});

test("reserve fails closed when available is short", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "short"),
	});
	await seedHats(store);
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_too_much",
		createReceiptId: () => "rcpt_too_much",
	});
	const result = await reserve(
		reserveCommand({
			commandId: "cmd_reserve_too_much",
			payload: {
				skuId: "sku_hat",
				quantity: { value: "11", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-9" },
			},
		}),
		{ principal },
	);
	assert.equal(result.outcome, "rejected");
	assert.equal(result.code, "insufficient_available");
});

test("the same order line returns the original hold or conflicts", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "unique"),
	});
	await seedHats(store);
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_hat_001",
		createReceiptId: () => "rcpt_reserve_hat",
	});
	const first = await reserve(reserveCommand(), { principal });
	assert.equal(first.outcome, "reserved");
	const existing = await reserve(
		reserveCommand({ commandId: "cmd_reserve_hat_retry" }),
		{ principal },
	);
	assert.equal(existing.outcome, "existing");
	assert.equal(existing.reservation.reservationId, "rsv_hat_001");
	const conflict = await reserve(
		reserveCommand({
			commandId: "cmd_reserve_hat_conflict",
			payload: {
				skuId: "sku_hat",
				quantity: { value: "4", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-1842" },
			},
		}),
		{ principal },
	);
	assert.equal(conflict.outcome, "rejected");
	assert.equal(conflict.code, "order_line_conflict");
});

test("a canceled order line can be reserved again with a new id", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "again"),
	});
	await seedHats(store);
	let nextId = "rsv_hat_001";
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => nextId,
		createReceiptId: () => `rcpt_${nextId}`,
	});
	assert.equal((await reserve(reserveCommand(), { principal })).outcome, "reserved");
	const release = createReleaseStock({
		store,
		now: () => new Date("2026-09-25T12:05:00.000Z"),
		createReceiptId: () => "rcpt_release_hat",
	});
	assert.equal(
		(
			await release(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_release_hat",
					type: "stock.release",
					context: { siteId: "site_test", poolId: "pool_test" },
					payload: { reservationId: "rsv_hat_001" },
					references: [],
				},
				{ principal },
			)
		).outcome,
		"released",
	);
	nextId = "rsv_hat_002";
	const again = await reserve(
		reserveCommand({ commandId: "cmd_reserve_hat_again" }),
		{ principal },
	);
	assert.equal(again.outcome, "reserved");
	assert.equal(again.reservation.reservationId, "rsv_hat_002");
});

test("distinct order lines with a separator keep separate holds", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "separator"),
	});
	await seedHats(store);
	let nextId = "rsv_sep_1";
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => nextId,
		createReceiptId: () => `rcpt_${nextId}`,
	});
	const first = await reserve(
		reserveCommand({
			commandId: "cmd_sep_1",
			payload: {
				skuId: "sku_hat",
				quantity: { value: "3", unit: "each" },
				orderLine: { kind: "a\u001fb", id: "c" },
			},
		}),
		{ principal },
	);
	assert.equal(first.outcome, "reserved");
	nextId = "rsv_sep_2";
	const second = await reserve(
		reserveCommand({
			commandId: "cmd_sep_2",
			payload: {
				skuId: "sku_hat",
				quantity: { value: "3", unit: "each" },
				orderLine: { kind: "a", id: "b\u001fc" },
			},
		}),
		{ principal },
	);
	assert.equal(second.outcome, "reserved");
	assert.equal(second.reservation.reservationId, "rsv_sep_2");
});

test("outgoing transfer commitments reduce reservable stock", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "transfer"),
	});
	await seedHats(store);
	await createFixtureLocation(store, {
		locationId: "location_south",
		name: "South",
	});
	const transfer = await createExecuteStockTransferCommand({
		store,
		now: () => new Date("2026-09-25T11:00:00.000Z"),
		createTransferId: () => "trn_hats",
		createTransferReference: () => "ST-1",
		createReceiptId: () => "rcpt_transfer_hats",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_create_transfer",
			type: "transfer.create",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: {
				reference: null,
				originLocationId: "location_north",
				destinationLocationId: "location_south",
				expectedDispatchDate: "2026-09-26",
				expectedArrivalDate: "2026-09-27",
				note: null,
				lines: [{ skuId: "sku_hat", quantity: { value: "8", unit: "each" } }],
			},
			references: [],
			expectedVersions: [],
		},
		{ principal },
	);
	assert.equal(transfer.outcome, "committed");
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-25T12:00:00.000Z"),
		createReservationId: () => "rsv_after_transfer",
		createReceiptId: () => "rcpt_after_transfer",
	});
	const result = await reserve(
		reserveCommand({
			commandId: "cmd_reserve_after_transfer",
			payload: {
				skuId: "sku_hat",
				quantity: { value: "3", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-1" },
			},
		}),
		{ principal },
	);
	assert.equal(result.outcome, "rejected");
	assert.equal(result.code, "insufficient_available");
});
