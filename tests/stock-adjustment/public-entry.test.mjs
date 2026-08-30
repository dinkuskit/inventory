import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../../src/index.ts";
import * as feature from "../../src/features/stock-adjustment/index.ts";

test("the package root composes the stock-adjustment public entry", () => {
	for (const name of [
		"STOCK_ADJUSTMENT_TYPE",
		"STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA",
		"STOCK_ADJUSTMENT_PREVIEW_SCHEMA",
		"STOCK_ADJUSTMENT_CONFIRMATION_TTL_MS",
		"normalizeAdjustStockCommand",
		"normalizePreviewStockAdjustmentInput",
		"createAdjustStock",
		"createPreviewStockAdjustment",
		"createConfirmStockAdjustment",
	]) {
		assert.equal(root[name], feature[name], `${name} must use the feature entry`);
	}
});
