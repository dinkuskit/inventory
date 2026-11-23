import assert from "node:assert/strict";
import test from "node:test";

import {
	InvalidStockReservationCommandError,
	DELIVER_STOCK_TYPE,
	PACK_ALL_STOCK_TYPE,
	PACK_SOME_STOCK_TYPE,
	PACK_STOCK_TYPE,
	RESERVE_STOCK_TYPE,
	RELEASE_STOCK_TYPE,
	RESERVATION_STATE_TRANSITIONS,
	UNPACK_STOCK_TYPE,
	assertBalanceConservationInvariant,
	assertReservationTransition,
	normalizeDeliverStockCommand,
	normalizePackAllStockCommand,
	normalizePackSomeStockCommand,
	normalizePackStockCommand,
	normalizeReleaseStockCommand,
	normalizeReserveStockCommand,
	normalizeUnpackStockCommand,
	reservationOrderLineKey,
} from "../../src/index.ts";

function reserveCommand(overrides = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: " cmd_reserve_001 ",
		type: RESERVE_STOCK_TYPE,
		context: {
			siteId: " site_test ",
			poolId: " pool_test ",
			locationId: " location_north ",
		},
		payload: {
			skuId: " sku_hat ",
			quantity: { value: " 003.500 ", unit: " each " },
			orderLine: { kind: " commerce.order_line ", id: " OL-1842 " },
		},
		references: [],
		...overrides,
	};
}

test("reserve command trims identity fields and requires a positive quantity", () => {
	assert.deepEqual(normalizeReserveStockCommand(reserveCommand()), {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_reserve_001",
		type: "stock.reserve",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_north",
		},
		payload: {
			skuId: "sku_hat",
			quantity: { value: "3.5", unit: "each" },
			orderLine: { kind: "commerce.order_line", id: "OL-1842" },
		},
		references: [],
	});
	assert.throws(
		() =>
			normalizeReserveStockCommand(
				reserveCommand({
					payload: {
						skuId: "sku_hat",
						quantity: { value: "0", unit: "each" },
						orderLine: { kind: "commerce.order_line", id: "OL-1842" },
					},
				}),
			),
		InvalidStockReservationCommandError,
	);
});

test("order-line keys stay distinct when kind or id contains a separator", () => {
	assert.notEqual(
		reservationOrderLineKey({ kind: "a\u001fb", id: "c" }),
		reservationOrderLineKey({ kind: "a", id: "b\u001fc" }),
	);
});

test("pack all command trims ticket ids and requires one or more unique tickets", () => {
	assert.deepEqual(
		normalizePackAllStockCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: " cmd_pack_all_001 ",
			type: PACK_ALL_STOCK_TYPE,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: { reservationIds: [" rsv_hat ", " rsv_shirt "] },
			references: [],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_all_001",
			type: "stock.pack_all",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationIds: ["rsv_hat", "rsv_shirt"] },
			references: [],
		},
	);
	assert.throws(
		() =>
			normalizePackAllStockCommand({
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_pack_all_empty",
				type: PACK_ALL_STOCK_TYPE,
				context: { siteId: "site_test", poolId: "pool_test" },
				payload: { reservationIds: [] },
				references: [],
			}),
		InvalidStockReservationCommandError,
	);
	assert.throws(
		() =>
			normalizePackAllStockCommand({
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_pack_all_dup",
				type: PACK_ALL_STOCK_TYPE,
				context: { siteId: "site_test", poolId: "pool_test" },
				payload: { reservationIds: ["rsv_hat", "rsv_hat"] },
				references: [],
			}),
		InvalidStockReservationCommandError,
	);
});

test("deliver command trims ticket ids and requires one or more unique tickets", () => {
	assert.deepEqual(
		normalizeDeliverStockCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: " cmd_deliver_001 ",
			type: DELIVER_STOCK_TYPE,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: { reservationIds: [" rsv_hat ", " rsv_shirt "] },
			references: [],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_deliver_001",
			type: "stock.deliver",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationIds: ["rsv_hat", "rsv_shirt"] },
			references: [],
		},
	);
	assert.throws(
		() =>
			normalizeDeliverStockCommand({
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_deliver_empty",
				type: DELIVER_STOCK_TYPE,
				context: { siteId: "site_test", poolId: "pool_test" },
				payload: { reservationIds: [] },
				references: [],
			}),
		InvalidStockReservationCommandError,
	);
});

test("pack some command trims the ticket and requires a positive quantity", () => {
	assert.deepEqual(
		normalizePackSomeStockCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: " cmd_pack_some_001 ",
			type: PACK_SOME_STOCK_TYPE,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: {
				reservationId: " rsv_hat ",
				quantity: { value: "1", unit: " each " },
			},
			references: [],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_some_001",
			type: "stock.pack_some",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: {
				reservationId: "rsv_hat",
				quantity: { value: "1", unit: "each" },
			},
			references: [],
		},
	);
	assert.throws(
		() =>
			normalizePackSomeStockCommand({
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_pack_some_zero",
				type: PACK_SOME_STOCK_TYPE,
				context: { siteId: "site_test", poolId: "pool_test" },
				payload: {
					reservationId: "rsv_hat",
					quantity: { value: "0", unit: "each" },
				},
				references: [],
			}),
		InvalidStockReservationCommandError,
	);
});

test("unpack command trims the reservation id", () => {
	assert.deepEqual(
		normalizeUnpackStockCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: " cmd_unpack_001 ",
			type: UNPACK_STOCK_TYPE,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: { reservationId: " rsv_hat_001 " },
			references: [],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_unpack_001",
			type: "stock.unpack",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
	);
});

test("pack command trims the reservation id", () => {
	assert.deepEqual(
		normalizePackStockCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: " cmd_pack_001 ",
			type: PACK_STOCK_TYPE,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: { reservationId: " rsv_hat_001 " },
			references: [],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_pack_001",
			type: "stock.pack",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
	);
});

test("release command trims the reservation id", () => {
	assert.deepEqual(
		normalizeReleaseStockCommand({
			schema: "dinkuskit.inventory.command/v1",
			commandId: " cmd_release_001 ",
			type: RELEASE_STOCK_TYPE,
			context: { siteId: " site_test ", poolId: " pool_test " },
			payload: { reservationId: " rsv_hat_001 " },
			references: [],
		}),
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_release_001",
			type: "stock.release",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_hat_001" },
			references: [],
		},
	);
});

test("explicit RESERVATION_STATE_TRANSITIONS matrix enforces legal transitions and terminal canceled state", () => {
	const states = ["not_shipped", "partially_packed", "packed", "delivered", "canceled"];
	for (const from of states) {
		for (const to of states) {
			if (RESERVATION_STATE_TRANSITIONS[from].includes(to)) {
				assert.doesNotThrow(() => assertReservationTransition(from, to), `${from} -> ${to}`);
			} else {
				assert.throws(
					() => assertReservationTransition(from, to),
					/Illegal reservation state transition/,
					`${from} -> ${to}`,
				);
			}
		}
	}
	assert.deepEqual(RESERVATION_STATE_TRANSITIONS.canceled, []);
});

test("assertBalanceConservationInvariant verifies exact decimal conservation and non-negative commitments", () => {
	const base = {
		poolId: "pool_test",
		locationId: "loc_1",
		skuId: "sku_hat",
		onHand: { value: "10", unit: "each" },
		reserved: { value: "3", unit: "each" },
		outgoingTransferCommitted: { value: "2", unit: "each" },
		available: { value: "5", unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "0", unit: "each" },
		version: "1",
		hasStockHistory: true,
	};
	assert.doesNotThrow(() => assertBalanceConservationInvariant(base));
	// Physical shrink / oversell with exact negative available still satisfies conservation.
	assert.doesNotThrow(() =>
		assertBalanceConservationInvariant({
			...base,
			onHand: { value: "2", unit: "each" },
			reserved: { value: "3", unit: "each" },
			outgoingTransferCommitted: { value: "0", unit: "each" },
			available: { value: "-1", unit: "each" },
		}),
	);
	// Drift in available violates conservation.
	assert.throws(
		() => assertBalanceConservationInvariant({ ...base, available: { value: "6", unit: "each" } }),
		/Balance conservation invariant violated/,
	);
	// Negative reserved, outgoingTransferCommitted, expected, or inTransit violates conservation.
	for (const field of ["reserved", "outgoingTransferCommitted", "expected", "inTransit"]) {
		assert.throws(
			() => assertBalanceConservationInvariant({ ...base, [field]: { value: "-1", unit: "each" } }),
			/Balance conservation invariant violated/,
			field,
		);
	}
	// Mismatched units violate conservation.
	assert.throws(
		() => assertBalanceConservationInvariant({ ...base, reserved: { value: "3", unit: "box" } }),
		/mismatched units/,
	);
});
