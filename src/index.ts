export {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	DEFAULT_OPENING_BALANCE_REASON_NOTE,
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
export {
	ARCHIVE_LOCATION_TYPE,
	CREATE_LOCATION_TYPE,
	InvalidLocationCommandError,
	LOCATION_LIST_RESULT_SCHEMA,
	RENAME_LOCATION_TYPE,
	RESTORE_LOCATION_TYPE,
	digestLocationCommand,
	normalizeListLocationsInput,
	normalizeLocationCommand,
	normalizeLocationName,
} from "./domain/location-registry.ts";
export type {
	ArchiveLocationCommandV1,
	CreateLocationCommandV1,
	InventoryCommandResult,
	InventoryReceiptV2,
	ListLocationsInput,
	LocationBalanceBlocker,
	LocationCommandResult,
	LocationCommandV1,
	LocationListResult,
	LocationReceiptV2,
	LocationRecord,
	LocationRejectionCode,
	LocationStatus,
	RenameLocationCommandV1,
	RestoreLocationCommandV1,
} from "./domain/location-registry.ts";
export type {
	BalanceRecord,
	CommandPrincipal,
	ExactQuantity,
	ExternalReference,
	HumanCommandPrincipal,
	OpeningBalancePreviewV1,
	OpeningBalanceReceiptV2,
	OpeningBalanceRejectionCode,
	OpeningBalanceResult,
	PreviewOpeningBalanceInputV1,
	SetOpeningBalanceCommandV1,
	SkuLocationKey,
	SystemCommandPrincipal,
} from "./domain/opening-balance.ts";
export {
	BALANCE_READ_RESULT_SCHEMA,
	InvalidInventoryReadQueryError,
	MUTATION_READ_RESULT_SCHEMA,
	RECEIPT_HISTORY_DEFAULT_LIMIT,
	RECEIPT_HISTORY_MAX_LIMIT,
	RECEIPT_HISTORY_READ_RESULT_SCHEMA,
	SKU_STOCK_READ_RESULT_SCHEMA,
	InconsistentSkuStockUnitError,
	normalizeInventoryMutationLookup,
	normalizeReadReceiptHistoryInput,
	normalizeReadSkuLocationBalanceInput,
	normalizeReadSkuStockInput,
} from "./domain/inventory-read.ts";
export type {
	InventoryMutationLookup,
	InventoryMutationReadResult,
	NormalizedInventoryMutationLookup,
	NormalizedReadReceiptHistoryInput,
	ReadReceiptHistoryInput,
	ReadSkuLocationBalanceInput,
	ReceiptHistoryCursor,
	ReceiptHistoryReadResult,
	ReceiptHistoryScope,
	ReadSkuStockInput,
	NormalizedReadSkuStockInput,
	SkuStockLocation,
	SkuStockReadResult,
	SkuStockScope,
	StockQuantities,
	SkuLocationBalanceReadResult,
} from "./domain/inventory-read.ts";
export {
	createSetOpeningBalance,
} from "./application/set-opening-balance.ts";
export {
	createExecuteLocationCommand,
	createListLocations,
} from "./application/location-registry.ts";
export type {
	ExecuteLocationCommand,
	ExecuteLocationCommandDependencies,
	ExecuteLocationCommandExecution,
	ListLocations,
	ListLocationsDependencies,
} from "./application/location-registry.ts";
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
export {
	createReadInventoryMutation,
	createReadReceiptHistory,
	createReadSkuLocationBalance,
	createReadSkuStock,
} from "./application/read-inventory.ts";
export type {
	ReadInventoryDependencies,
	ReadInventoryMutation,
	ReadReceiptHistory,
	ReadSkuLocationBalance,
	ReadSkuStock,
} from "./application/read-inventory.ts";
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
	ActiveLocationBalanceSnapshot,
	ListLocationsQuery,
	ListReceiptsQuery,
	ReadSkuActiveLocationSnapshotQuery,
	LocationCommit,
	OpeningBalanceCommit,
	ReceiptListCursor,
	StoredOpeningBalanceConfirmation,
	StoredCommandResult,
} from "./storage/inventory-store.ts";
