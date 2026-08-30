import assert from "node:assert/strict";
import test from "node:test";

import * as root from "../../src/index.ts";
import * as feature from "../../src/features/stock-transfer/index.ts";

test("the package root composes the stock-transfer public entry", () => {
	assert.equal(feature.RECEIVE_STOCK_TRANSFER_TYPE, "transfer.receive");
	for (const name of [
		"CREATE_STOCK_TRANSFER_TYPE",
		"UPDATE_STOCK_TRANSFER_TYPE",
		"CANCEL_STOCK_TRANSFER_TYPE",
		"DISPATCH_STOCK_TRANSFER_TYPE",
		"RECEIVE_STOCK_TRANSFER_TYPE",
		"REOPEN_STOCK_TRANSFER_TYPE",
		"STOCK_TRANSFER_RECORD_SCHEMA",
		"STOCK_TRANSFER_READ_RESULT_SCHEMA",
		"STOCK_TRANSFER_LIST_RESULT_SCHEMA",
		"STOCK_TRANSFER_LIST_DEFAULT_LIMIT",
		"STOCK_TRANSFER_LIST_MAX_LIMIT",
		"InvalidStockTransferCommandError",
		"InvalidStockTransferListQueryError",
		"normalizeStockTransferCommand",
		"normalizeStockTransferReference",
		"normalizeReadStockTransferListInput",
		"createExecuteStockTransferCommand",
		"createReadStockTransfer",
		"createReadStockTransferList",
	]) {
		assert.equal(root[name], feature[name]);
	}
});
