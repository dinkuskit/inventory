import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../../src/index.ts";
import * as feature from "../../src/features/stock-transfer/index.ts";

test("the package root composes the stock-transfer public entry", () => {
	for (const name of [
		"CREATE_STOCK_TRANSFER_TYPE",
		"UPDATE_STOCK_TRANSFER_TYPE",
		"CANCEL_STOCK_TRANSFER_TYPE",
		"STOCK_TRANSFER_RECORD_SCHEMA",
		"STOCK_TRANSFER_READ_RESULT_SCHEMA",
		"InvalidStockTransferCommandError",
		"normalizeStockTransferCommand",
		"normalizeStockTransferReference",
		"createExecuteStockTransferCommand",
		"createReadStockTransfer",
	]) {
		assert.equal(root[name], feature[name]);
	}
});
