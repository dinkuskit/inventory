export {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	InvalidOpeningBalanceCommandError,
	OPENING_BALANCE_PREVIEW_INPUT_SCHEMA,
	OPENING_BALANCE_PREVIEW_SCHEMA,
	OPENING_BALANCE_TYPE,
	RECEIPT_SCHEMA,
	canonicalCommandJson,
	digestCommand,
	normalizeNonNegativeDecimal,
	normalizePreviewOpeningBalanceInput,
	normalizeSetOpeningBalanceCommand,
} from "./domain/opening-balance.ts";
export type {
	BalanceRecord,
	CommandPrincipal,
	ExactQuantity,
	ExternalReference,
	OpeningBalancePreviewV1,
	OpeningBalanceReceiptV1,
	OpeningBalanceRejectionCode,
	OpeningBalanceResult,
	PreviewOpeningBalanceInputV1,
	SetOpeningBalanceCommandV1,
	SkuLocationKey,
} from "./domain/opening-balance.ts";
export {
	createSetOpeningBalance,
} from "./application/set-opening-balance.ts";
export type {
	SetOpeningBalance,
	SetOpeningBalanceDependencies,
	SetOpeningBalanceExecution,
} from "./application/set-opening-balance.ts";
export {
	OPENING_BALANCE_CONFIRMATION_TTL_MS,
	OpeningBalanceConfirmationError,
	OpeningBalancePreviewError,
	createConfirmOpeningBalance,
	createPreviewOpeningBalance,
} from "./application/preview-confirm-opening-balance.ts";
export type {
	ConfirmOpeningBalance,
	ConfirmOpeningBalanceDependencies,
	ConfirmOpeningBalanceExecution,
	OpeningBalanceConfirmationErrorCode,
	PreviewOpeningBalance,
	PreviewOpeningBalanceDependencies,
	PreviewOpeningBalanceExecution,
} from "./application/preview-confirm-opening-balance.ts";
export type {
	InventoryStore,
	InventoryTransaction,
	OpeningBalanceCommit,
	StoredOpeningBalanceConfirmation,
	StoredCommandResult,
} from "./storage/inventory-store.ts";
