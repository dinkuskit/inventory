import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../../src/index.ts";
import * as feature from "../../src/features/checkout-inventory/index.ts";

test("the package root composes the checkout-inventory public entry", () => {
	for (const name of [
		"CHECKOUT_INVENTORY_FEATURE_ID",
		"CHECKOUT_RESERVE_TYPE",
		"CHECKOUT_RELEASE_TYPE",
		"CHECKOUT_OPERATION_LINE_KIND",
		"normalizeStockRequest",
		"digestCheckoutStockRequest",
		"normalizeInventoryProviderBinding",
		"sameInventoryProviderBinding",
		"checkoutReserveCommandId",
		"checkoutReleaseCommandId",
		"createReserveCheckoutBasket",
		"createReleaseCheckoutBasket",
		"createCheckoutInventoryPort",
	]) {
		assert.equal(root[name], feature[name], `${name} must use the feature entry`);
	}
});
