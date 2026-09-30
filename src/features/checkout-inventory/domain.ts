import {
	COMMAND_RESULT_SCHEMA,
	RECEIPT_SCHEMA,
	digestCanonicalValue,
	type CommandPrincipal,
	type ExternalReference,
} from "../../domain/opening-balance.ts";
import type {
	ReservationRecord,
	StockReservationBalanceEffect,
} from "../stock-reservation/index.ts";

export const CHECKOUT_INVENTORY_FEATURE_ID = "dinkus.checkout-inventory";
export const CHECKOUT_RESERVE_TYPE = "checkout.reserve" as const;
export const CHECKOUT_RELEASE_TYPE = "checkout.release" as const;
export const CHECKOUT_OPERATION_LINE_KIND = "checkout.operation_line" as const;

export interface InventoryProviderBinding {
	providerRef: string;
	poolId: string;
	defaultFulfillmentLocationId: string;
}

export interface StockRequirement {
	skuId: string;
	quantity: number;
	allowBackorders: boolean;
}

export interface StockRequest {
	operationId: string;
	binding: InventoryProviderBinding;
	requirements: StockRequirement[];
}

/** Durable whole-basket operation. Never substitute a local stock ledger. */
export interface CheckoutInventoryPort {
	/** Same operation/request forever; terminal rejection has no holds and cannot later succeed. */
	reserve(request: StockRequest): Promise<"reserved" | "rejected" | "unknown">;
	/** Idempotent terminal fence, including an in-flight reserve. No subsequent reacquisition. */
	release(request: StockRequest): Promise<"released" | "unknown">;
}

export type NormalizedStockRequirement = Readonly<{
	skuId: string;
	quantity: string;
	allowBackorders: boolean;
}>;

export type NormalizedStockRequest = Readonly<{
	operationId: string;
	binding: Readonly<InventoryProviderBinding>;
	requirements: readonly NormalizedStockRequirement[];
}>;

export type CheckoutInventoryRejectionCode =
	| "command_id_conflict"
	| "unsupported_backorder_policy"
	| "insufficient_available"
	| "location_not_found"
	| "location_not_active"
	| "sku_not_registered"
	| "sku_unit_mismatch"
	| "checkout_released"
	| "invalid_request";

export type CheckoutInventoryReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: typeof CHECKOUT_RESERVE_TYPE | typeof CHECKOUT_RELEASE_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	operationId: string;
	binding: InventoryProviderBinding;
	holds: readonly Readonly<{
		before: ReservationRecord | null;
		after: ReservationRecord;
	}>[];
	effects: readonly StockReservationBalanceEffect[];
	references: readonly ExternalReference[];
}>;

export type CheckoutInventoryResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "reserved";
			commandId: string;
			reservations: readonly ReservationRecord[];
			receipt: CheckoutInventoryReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "released";
			commandId: string;
			reservations: readonly ReservationRecord[];
			receipt: CheckoutInventoryReceiptV2 | null;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: CheckoutInventoryRejectionCode;
			message: string;
	  }>;

export class InvalidCheckoutInventoryRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidCheckoutInventoryRequestError";
	}
}

function invalid(message: string): never {
	throw new InvalidCheckoutInventoryRequestError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (!isRecord(value)) {
		invalid(`${field} must be an object.`);
	}
	return value;
}

function exactKeys(
	value: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) {
		invalid(`${field} contains unsupported fields.`);
	}
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

function positiveIntegerQuantity(value: unknown, field: string): string {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		invalid(`${field} must be a positive safe integer.`);
	}
	return String(value);
}

export function checkoutReserveCommandId(operationId: string): string {
	return `${CHECKOUT_RESERVE_TYPE}:${operationId}`;
}

export function checkoutReleaseCommandId(operationId: string): string {
	return `${CHECKOUT_RELEASE_TYPE}:${operationId}`;
}

export function checkoutOperationLine(operationId: string, skuId: string): ExternalReference {
	return {
		kind: CHECKOUT_OPERATION_LINE_KIND,
		id: JSON.stringify([operationId, skuId]),
	};
}

export function normalizeInventoryProviderBinding(
	input: unknown,
	field = "binding",
): InventoryProviderBinding {
	const binding = record(input, field);
	exactKeys(binding, field, [
		"providerRef",
		"poolId",
		"defaultFulfillmentLocationId",
	]);
	return {
		providerRef: nonEmptyString(binding.providerRef, `${field}.providerRef`),
		poolId: nonEmptyString(binding.poolId, `${field}.poolId`),
		defaultFulfillmentLocationId: nonEmptyString(
			binding.defaultFulfillmentLocationId,
			`${field}.defaultFulfillmentLocationId`,
		),
	};
}

export function sameInventoryProviderBinding(
	left: InventoryProviderBinding,
	right: InventoryProviderBinding,
): boolean {
	return (
		left.providerRef === right.providerRef &&
		left.poolId === right.poolId &&
		left.defaultFulfillmentLocationId === right.defaultFulfillmentLocationId
	);
}

export function normalizeStockRequest(input: unknown): NormalizedStockRequest {
	const request = record(input, "request");
	exactKeys(request, "request", ["operationId", "binding", "requirements"]);
	if (!Array.isArray(request.requirements) || request.requirements.length === 0) {
		invalid("requirements must name one or more basket lines.");
	}
	const merged = new Map<string, NormalizedStockRequirement>();
	for (const [index, raw] of request.requirements.entries()) {
		const item = record(raw, `requirements[${index}]`);
		exactKeys(item, `requirements[${index}]`, [
			"skuId",
			"quantity",
			"allowBackorders",
		]);
		if (typeof item.allowBackorders !== "boolean") {
			invalid(`requirements[${index}].allowBackorders must be a boolean.`);
		}
		const skuId = nonEmptyString(item.skuId, `requirements[${index}].skuId`);
		const quantity = positiveIntegerQuantity(
			item.quantity,
			`requirements[${index}].quantity`,
		);
		const existing = merged.get(skuId);
		if (existing === undefined) {
			merged.set(skuId, {
				skuId,
				quantity,
				allowBackorders: item.allowBackorders,
			});
			continue;
		}
		merged.set(skuId, {
			skuId,
			quantity: String(BigInt(existing.quantity) + BigInt(quantity)),
			allowBackorders: existing.allowBackorders || item.allowBackorders,
		});
	}
	return {
		operationId: nonEmptyString(request.operationId, "operationId"),
		binding: normalizeInventoryProviderBinding(request.binding, "binding"),
		requirements: [...merged.values()].sort((left, right) =>
			left.skuId < right.skuId ? -1 : left.skuId > right.skuId ? 1 : 0,
		),
	};
}

export async function digestCheckoutStockRequest(
	request: NormalizedStockRequest,
	siteId: string,
): Promise<string> {
	return digestCanonicalValue({
		siteId: nonEmptyString(siteId, "siteId"),
		operationId: request.operationId,
		binding: request.binding,
		requirements: request.requirements,
	});
}
