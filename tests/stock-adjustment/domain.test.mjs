import assert from "node:assert/strict";
import test from "node:test";

import {
	InvalidStockAdjustmentCommandError,
	STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA,
	STOCK_ADJUSTMENT_TYPE,
	addExactDecimal,
	normalizeAdjustStockCommand,
	normalizePreviewStockAdjustmentInput,
	subtractExactDecimal,
} from "../../src/index.ts";

function previewInput(overrides = {}) {
	return {
		schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1",
		type: "stock.adjust",
		context: {
			siteId: " site_test ",
			poolId: " pool_test ",
			locationId: " location_north ",
		},
		payload: {
			skuId: " sku_hat ",
			delta: { value: " -003.500 ", unit: " each " },
		},
		reason: { note: " Two hats damaged " },
		references: [{ kind: " corrects_receipt ", id: " rcpt_prior " }],
		...overrides,
	};
}

function command(overrides = {}) {
	const preview = previewInput();
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: " cmd_adjust_001 ",
		type: preview.type,
		context: preview.context,
		payload: preview.payload,
		reason: preview.reason,
		references: preview.references,
		expectedVersions: [
			{
				skuId: " sku_hat ",
				locationId: " location_north ",
				version: " 0007 ",
			},
		],
		...overrides,
	};
}

test("normalizes a non-zero signed delta, one typed reason, and observed version", () => {
	assert.equal(STOCK_ADJUSTMENT_TYPE, "stock.adjust");
	assert.equal(
		STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA,
		"dinkuskit.inventory.stock-adjustment-preview-input/v1",
	);
	assert.deepEqual(normalizePreviewStockAdjustmentInput(previewInput()), {
		schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1",
		type: "stock.adjust",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_north",
		},
		payload: {
			skuId: "sku_hat",
			delta: { value: "-3.5", unit: "each" },
		},
		reason: { note: "Two hats damaged" },
		references: [{ kind: "corrects_receipt", id: "rcpt_prior" }],
	});
	assert.deepEqual(normalizeAdjustStockCommand(command()), {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_adjust_001",
		type: "stock.adjust",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_north",
		},
		payload: {
			skuId: "sku_hat",
			delta: { value: "-3.5", unit: "each" },
		},
		reason: { note: "Two hats damaged" },
		references: [{ kind: "corrects_receipt", id: "rcpt_prior" }],
		expectedVersions: [
			{ skuId: "sku_hat", locationId: "location_north", version: "7" },
		],
	});
});

test("uses exact signed decimal arithmetic beyond binary floating-point range", () => {
	assert.equal(addExactDecimal("9007199254740993.1", "0.2"), "9007199254740993.3");
	assert.equal(addExactDecimal("-5.75", "2.5"), "-3.25");
	assert.equal(subtractExactDecimal("0.1", "0.2"), "-0.1");
	assert.equal(subtractExactDecimal("10", "-0.125"), "10.125");
});

test("rejects zero, a blank reason, and a reason category", () => {
	for (const value of ["0", "-0", "+0.000", "000.00"]) {
		assert.throws(
			() =>
				normalizePreviewStockAdjustmentInput(
					previewInput({
						payload: { skuId: "sku_hat", delta: { value, unit: "each" } },
					}),
				),
			{ name: "InvalidStockAdjustmentCommandError" },
		);
	}
	assert.throws(
		() =>
			normalizePreviewStockAdjustmentInput(
				previewInput({ reason: { note: "   " } }),
			),
		InvalidStockAdjustmentCommandError,
	);
	assert.throws(
		() =>
			normalizePreviewStockAdjustmentInput(
				previewInput({
					reason: { code: "damage", note: "Two hats damaged" },
				}),
			),
		InvalidStockAdjustmentCommandError,
	);
});

test("requires exactly the command SKU-location and one positive observed version", () => {
	for (const expectedVersions of [
		[],
		[
			{ skuId: "sku_other", locationId: "location_north", version: "7" },
		],
		[{ skuId: "sku_hat", locationId: "location_other", version: "7" }],
		[{ skuId: "sku_hat", locationId: "location_north", version: "0" }],
		[{ skuId: "sku_hat", locationId: "location_north", version: "1.5" }],
	]) {
		assert.throws(
			() => normalizeAdjustStockCommand(command({ expectedVersions })),
			InvalidStockAdjustmentCommandError,
		);
	}
});
