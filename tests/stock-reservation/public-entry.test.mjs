import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../../src/index.ts";
import * as feature from "../../src/features/stock-reservation/index.ts";

test("the package root composes the stock-reservation public entry", () => {
	for (const name of [
		"RESERVE_STOCK_TYPE",
		"RELEASE_STOCK_TYPE",
		"RESERVATION_RECORD_SCHEMA",
		"normalizeReserveStockCommand",
		"normalizeReleaseStockCommand",
		"createReserveStock",
		"createReleaseStock",
	]) {
		assert.equal(root[name], feature[name], `${name} must use the feature entry`);
	}
});
