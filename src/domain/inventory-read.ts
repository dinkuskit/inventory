import type {
	BalanceRecord,
	ExactQuantity,
	OpeningBalanceReceiptV2,
	SkuLocationKey,
} from "./opening-balance.ts";
import type { InventoryCommandResult } from "./location-registry.ts";
import type { StockAdjustmentReceiptV2 } from "../features/stock-adjustment/index.ts";
import type { StockTransferReceiptV2 } from "../features/stock-transfer/index.ts";

export type InventoryStockReceiptV2 =
	| OpeningBalanceReceiptV2
	| StockAdjustmentReceiptV2
	| StockTransferReceiptV2;

export const BALANCE_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.balance-read-result/v1" as const;
export const MUTATION_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.mutation-read-result/v1" as const;
export const RECEIPT_HISTORY_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.receipt-history-read-result/v1" as const;
export const SKU_STOCK_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.sku-stock-read-result/v1" as const;
export const RECEIPT_HISTORY_DEFAULT_LIMIT = 50 as const;
export const RECEIPT_HISTORY_MAX_LIMIT = 100 as const;

export type ReadSkuLocationBalanceInput = SkuLocationKey;

export type SkuLocationBalanceReadResult =
	| Readonly<{
			schema: typeof BALANCE_READ_RESULT_SCHEMA;
			outcome: "found";
			key: SkuLocationKey;
			balance: BalanceRecord;
	  }>
	| Readonly<{
			schema: typeof BALANCE_READ_RESULT_SCHEMA;
			outcome: "not_found";
			key: SkuLocationKey;
	  }>;

export type InventoryMutationLookup =
	| Readonly<{ receiptId: string; commandId?: never }>
	| Readonly<{ commandId: string; receiptId?: never }>;

export type NormalizedInventoryMutationLookup =
	| Readonly<{ receiptId: string }>
	| Readonly<{ commandId: string }>;

export type InventoryMutationReadResult =
	| Readonly<{
			schema: typeof MUTATION_READ_RESULT_SCHEMA;
			outcome: "found";
			lookup: NormalizedInventoryMutationLookup;
			result: InventoryCommandResult;
	  }>
	| Readonly<{
			schema: typeof MUTATION_READ_RESULT_SCHEMA;
			outcome: "not_found";
			lookup: NormalizedInventoryMutationLookup;
	  }>;

export type ReceiptHistoryScope =
	| Readonly<{ kind: "location"; locationId: string }>
	| Readonly<{ kind: "all_locations" }>;

export type ReceiptHistoryCursor = Readonly<{
	committedAt: string;
	receiptId: string;
}>;

export type ReadReceiptHistoryInput = Readonly<{
	poolId: string;
	scope: ReceiptHistoryScope;
	limit?: number;
	before?: ReceiptHistoryCursor;
}>;

export type NormalizedReadReceiptHistoryInput = Readonly<{
	poolId: string;
	scope: ReceiptHistoryScope;
	limit: number;
	before?: ReceiptHistoryCursor;
}>;

export type ReceiptHistoryReadResult = Readonly<{
	schema: typeof RECEIPT_HISTORY_READ_RESULT_SCHEMA;
	poolId: string;
	scope: ReceiptHistoryScope;
	receipts: readonly InventoryStockReceiptV2[];
	next: ReceiptHistoryCursor | null;
}>;

export type SkuStockScope = ReceiptHistoryScope;

export type ReadSkuStockInput = Readonly<{
	poolId: string;
	skuId: string;
	scope: SkuStockScope;
}>;

export type NormalizedReadSkuStockInput = ReadSkuStockInput;

export type StockQuantities = Readonly<{
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	outgoingTransferCommitted: ExactQuantity;
	available: ExactQuantity;
	expected: ExactQuantity;
	inTransit: ExactQuantity;
}>;

export type SkuStockLocation = Readonly<{
	locationId: string;
	name: string;
	stock: StockQuantities;
}>;

export type SkuStockReadResult =
	| Readonly<{
			schema: typeof SKU_STOCK_READ_RESULT_SCHEMA;
			outcome: "found";
			poolId: string;
			skuId: string;
			scope: SkuStockScope;
			stock: StockQuantities;
			locations: readonly SkuStockLocation[];
	  }>
	| Readonly<{
			schema: typeof SKU_STOCK_READ_RESULT_SCHEMA;
			outcome: "not_found";
			poolId: string;
			skuId: string;
			scope: SkuStockScope;
	  }>;

export class InvalidInventoryReadQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidInventoryReadQueryError";
	}
}

export class InconsistentSkuStockUnitError extends Error {
	constructor() {
		super("A SKU must use one quantity unit across all active locations.");
		this.name = "InconsistentSkuStockUnitError";
	}
}

function invalid(message: string): never {
	throw new InvalidInventoryReadQueryError(message);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		invalid(`${field} must be a string.`);
	}
	const normalized = value.trim();
	if (normalized.length === 0) {
		invalid(`${field} must not be empty.`);
	}
	return normalized;
}

function normalizedLimit(value: unknown): number {
	if (value === undefined) {
		return RECEIPT_HISTORY_DEFAULT_LIMIT;
	}
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > RECEIPT_HISTORY_MAX_LIMIT
	) {
		invalid(
			`limit must be an integer from 1 through ${RECEIPT_HISTORY_MAX_LIMIT}.`,
		);
	}
	return value;
}

function normalizedCursor(value: unknown): ReceiptHistoryCursor | undefined {
	if (value === undefined) {
		return undefined;
	}
	const cursor = record(value, "before");
	const committedAt = nonEmptyString(cursor.committedAt, "before.committedAt");
	const timestamp = Date.parse(committedAt);
	if (Number.isNaN(timestamp)) {
		invalid("before.committedAt must be a valid timestamp.");
	}
	return {
		committedAt: new Date(timestamp).toISOString(),
		receiptId: nonEmptyString(cursor.receiptId, "before.receiptId"),
	};
}

export function normalizeReadSkuLocationBalanceInput(
	input: unknown,
): ReadSkuLocationBalanceInput {
	const query = record(input, "balance query");
	return {
		poolId: nonEmptyString(query.poolId, "poolId"),
		locationId: nonEmptyString(query.locationId, "locationId"),
		skuId: nonEmptyString(query.skuId, "skuId"),
	};
}

export function normalizeInventoryMutationLookup(
	input: unknown,
): NormalizedInventoryMutationLookup {
	const lookup = record(input, "mutation lookup");
	const hasReceiptId = lookup.receiptId !== undefined;
	const hasCommandId = lookup.commandId !== undefined;
	if (hasReceiptId === hasCommandId) {
		invalid("Mutation lookup requires exactly one receiptId or commandId.");
	}
	return hasReceiptId
		? { receiptId: nonEmptyString(lookup.receiptId, "receiptId") }
		: { commandId: nonEmptyString(lookup.commandId, "commandId") };
}

export function normalizeReadReceiptHistoryInput(
	input: unknown,
): NormalizedReadReceiptHistoryInput {
	const query = record(input, "receipt history query");
	const scopeInput = record(query.scope, "scope");
	let scope: ReceiptHistoryScope;
	if (scopeInput.kind === "location") {
		scope = {
			kind: "location",
			locationId: nonEmptyString(scopeInput.locationId, "scope.locationId"),
		};
	} else if (scopeInput.kind === "all_locations") {
		if (Object.prototype.hasOwnProperty.call(scopeInput, "locationId")) {
			invalid("All-locations scope cannot include a locationId.");
		}
		scope = { kind: "all_locations" };
	} else {
		invalid('scope.kind must be "location" or "all_locations".');
	}

	const before = normalizedCursor(query.before);
	const normalized = {
		poolId: nonEmptyString(query.poolId, "poolId"),
		scope,
		limit: normalizedLimit(query.limit),
	};
	return before === undefined ? normalized : { ...normalized, before };
}

export function normalizeReadSkuStockInput(
	input: unknown,
): NormalizedReadSkuStockInput {
	const query = record(input, "SKU stock query");
	const scopeInput = record(query.scope, "scope");
	let scope: SkuStockScope;
	if (scopeInput.kind === "location") {
		scope = {
			kind: "location",
			locationId: nonEmptyString(scopeInput.locationId, "scope.locationId"),
		};
	} else if (scopeInput.kind === "all_locations") {
		if (Object.prototype.hasOwnProperty.call(scopeInput, "locationId")) {
			invalid("All-locations scope cannot include a locationId.");
		}
		scope = { kind: "all_locations" };
	} else {
		invalid('scope.kind must be "location" or "all_locations".');
	}
	return {
		poolId: nonEmptyString(query.poolId, "poolId"),
		skuId: nonEmptyString(query.skuId, "skuId"),
		scope,
	};
}
