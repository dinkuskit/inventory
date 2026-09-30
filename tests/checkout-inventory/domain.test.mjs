import assert from "node:assert/strict";
import test from "node:test";

import {
	CHECKOUT_OPERATION_LINE_KIND,
	InvalidCheckoutInventoryRequestError,
	checkoutOperationLine,
	checkoutReleaseCommandId,
	checkoutReserveCommandId,
	digestCheckoutStockRequest,
	normalizeInventoryProviderBinding,
	normalizeStockRequest,
	reservationOrderLineKey,
} from "../../src/index.ts";

function request(overrides = {}) {
	return {
		operationId: " op_checkout_001 ",
		binding: {
			providerRef: " dinkuskit.inventory ",
			poolId: " pool_test ",
			defaultFulfillmentLocationId: " location_north ",
		},
		requirements: [
			{ skuId: " sku_shirt ", quantity: 2, allowBackorders: false },
			{ skuId: " sku_hat ", quantity: 3, allowBackorders: false },
		],
		...overrides,
	};
}

test("checkout request trims identity, sorts SKUs, and merges duplicate lines", () => {
	assert.deepEqual(normalizeStockRequest(request()), {
		operationId: "op_checkout_001",
		binding: {
			providerRef: "dinkuskit.inventory",
			poolId: "pool_test",
			defaultFulfillmentLocationId: "location_north",
		},
		requirements: [
			{ skuId: "sku_hat", quantity: "3", allowBackorders: false },
			{ skuId: "sku_shirt", quantity: "2", allowBackorders: false },
		],
	});
	assert.deepEqual(
		normalizeStockRequest(
			request({
				requirements: [
					{ skuId: "sku_hat", quantity: 2, allowBackorders: false },
					{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
				],
			}),
		).requirements,
		[{ skuId: "sku_hat", quantity: "5", allowBackorders: false }],
	);
});

test("checkout request rejects empty baskets and non-integer quantities", () => {
	assert.throws(
		() => normalizeStockRequest(request({ requirements: [] })),
		InvalidCheckoutInventoryRequestError,
	);
	assert.throws(
		() =>
			normalizeStockRequest(
				request({
					requirements: [{ skuId: "sku_hat", quantity: 1.5, allowBackorders: false }],
				}),
			),
		InvalidCheckoutInventoryRequestError,
	);
});

test("checkout command IDs and line keys stay operation-scoped", async () => {
	assert.equal(
		checkoutReserveCommandId("op_1"),
		"checkout.reserve:op_1",
	);
	assert.equal(
		checkoutReleaseCommandId("op_1"),
		"checkout.release:op_1",
	);
	assert.deepEqual(checkoutOperationLine("op_1", "sku_hat"), {
		kind: CHECKOUT_OPERATION_LINE_KIND,
		id: JSON.stringify(["op_1", "sku_hat"]),
	});
	assert.notEqual(
		checkoutOperationLine("a:b", "c").id,
		checkoutOperationLine("a", "b:c").id,
	);
	assert.notEqual(
		reservationOrderLineKey(checkoutOperationLine("a:b", "c")),
		reservationOrderLineKey(checkoutOperationLine("a", "b:c")),
	);
	const left = await digestCheckoutStockRequest(
		normalizeStockRequest(request()),
		"site_test",
	);
	const right = await digestCheckoutStockRequest(
		normalizeStockRequest(
			request({
				requirements: [
					{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
					{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
				],
			}),
		),
		"site_test",
	);
	assert.equal(left, right);
	assert.notEqual(
		left,
		await digestCheckoutStockRequest(normalizeStockRequest(request()), "site_other"),
	);
	assert.deepEqual(
		normalizeInventoryProviderBinding({
			providerRef: " configured.opaque-handle ",
			poolId: " pool_test ",
			defaultFulfillmentLocationId: " location_north ",
		}),
		{
			providerRef: "configured.opaque-handle",
			poolId: "pool_test",
			defaultFulfillmentLocationId: "location_north",
		},
	);
});
