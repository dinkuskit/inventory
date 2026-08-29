export {
	InvalidStockAdjustmentCommandError,
	STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA,
	STOCK_ADJUSTMENT_PREVIEW_SCHEMA,
	STOCK_ADJUSTMENT_TYPE,
	digestAdjustStockCommand,
	digestStockAdjustmentAction,
	normalizeAdjustStockCommand,
	normalizePreviewStockAdjustmentInput,
	normalizeSignedNonZeroDecimal,
	stockAdjustmentActionFromCommand,
} from "./domain.ts";
export type {
	AdjustStockCommandV1,
	PreviewStockAdjustmentInputV1,
	StockAdjustmentActionV1,
	StockAdjustmentPreviewV1,
	StockAdjustmentReceiptV2,
	StockAdjustmentRejectionCode,
	StockAdjustmentResult,
	StockAdjustmentReason,
} from "./domain.ts";
export {
	addExactDecimal,
	createAdjustStock,
	subtractExactDecimal,
} from "./adjust.ts";
export type {
	AdjustStock,
	AdjustStockDependencies,
	AdjustStockExecution,
} from "./adjust.ts";
export {
	STOCK_ADJUSTMENT_CONFIRMATION_TTL_MS,
	StockAdjustmentConfirmationError,
	StockAdjustmentPreviewError,
	createConfirmStockAdjustment,
	createPreviewStockAdjustment,
} from "./preview-confirm.ts";
export type {
	ConfirmStockAdjustment,
	ConfirmStockAdjustmentDependencies,
	ConfirmStockAdjustmentExecution,
	PreviewStockAdjustment,
	PreviewStockAdjustmentDependencies,
	PreviewStockAdjustmentExecution,
	StockAdjustmentConfirmationErrorCode,
	StockAdjustmentPreviewErrorCode,
} from "./preview-confirm.ts";
