import assert from "node:assert/strict";
import test from "node:test";

import {
	InvalidStockReservationCommandError,
	PACK_ALL_STOCK_TYPE,
	PACK_STOCK_TYPE,
	RESERVE_STOCK_TYPE,
	RELEASE_STOCK_TYPE,
	normalizePackAllStockCommand,
	normalizePackStockCommand,
	normalizeReleaseStockCommand,
	normalizeReserveStockCommand,
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
