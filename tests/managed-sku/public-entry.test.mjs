import assert from "node:assert/strict";
import test from "node:test";

import * as inventory from "../../src/index.ts";
import * as managedSku from "../../src/features/managed-sku/index.ts";

test("the package root and managed-SKU feature entry expose the same runtime contract", () => {
	for (const name of [
		"MANAGED_SKU_UNIT",
		"REGISTER_MANAGED_SKU_TYPE",
		"InvalidManagedSkuCommandError",
		"digestRegisterManagedSkuCommand",
		"normalizeRegisterManagedSkuCommand",
		"createRegisterManagedSku",
	]) {
		assert.equal(managedSku[name], inventory[name], name);
	}
});
