import type {
	BalanceRecord,
	OpeningBalanceResult,
	SkuLocationKey,
} from "./opening-balance.ts";

export const BALANCE_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.balance-read-result/v1" as const;
export const MUTATION_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.mutation-read-result/v1" as const;

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
			result: OpeningBalanceResult;
	  }>
	| Readonly<{
			schema: typeof MUTATION_READ_RESULT_SCHEMA;
			outcome: "not_found";
			lookup: NormalizedInventoryMutationLookup;
	  }>;

export class InvalidInventoryReadQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidInventoryReadQueryError";
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
