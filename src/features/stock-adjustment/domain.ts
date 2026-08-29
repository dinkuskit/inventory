import {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	RECEIPT_SCHEMA,
	digestCanonicalValue,
	type CommandPrincipal,
	type ExactQuantity,
	type ExternalReference,
} from "../../domain/opening-balance.ts";

export const STOCK_ADJUSTMENT_TYPE = "stock.adjust" as const;
export const STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA =
	"dinkuskit.inventory.stock-adjustment-preview-input/v1" as const;
export const STOCK_ADJUSTMENT_PREVIEW_SCHEMA =
	"dinkuskit.inventory.stock-adjustment-preview/v1" as const;

export type StockAdjustmentReason = Readonly<{
	note: string;
}>;

export type PreviewStockAdjustmentInputV1 = Readonly<{
	schema: typeof STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA;
	type: typeof STOCK_ADJUSTMENT_TYPE;
	context: Readonly<{
		siteId: string;
		poolId: string;
		locationId: string;
	}>;
	payload: Readonly<{
		skuId: string;
		delta: ExactQuantity;
	}>;
	reason: StockAdjustmentReason;
	references: readonly ExternalReference[];
}>;

export type AdjustStockCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof STOCK_ADJUSTMENT_TYPE;
	context: PreviewStockAdjustmentInputV1["context"];
	payload: PreviewStockAdjustmentInputV1["payload"];
	reason: StockAdjustmentReason;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		skuId: string;
		locationId: string;
		version: string;
	}>[];
}>;

export type StockAdjustmentActionV1 = Readonly<
	PreviewStockAdjustmentInputV1 & { expectedVersion: string }
>;

type StockAdjustmentQuantities = Readonly<{
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	available: ExactQuantity;
}>;

export type StockAdjustmentPreviewV1 = Readonly<{
	schema: typeof STOCK_ADJUSTMENT_PREVIEW_SCHEMA;
	type: typeof STOCK_ADJUSTMENT_TYPE;
	context: PreviewStockAdjustmentInputV1["context"];
	effect: Readonly<{
		skuId: string;
		locationId: string;
		onHandDelta: ExactQuantity;
		reservedDelta: ExactQuantity;
		balanceBefore: StockAdjustmentQuantities & Readonly<{ version: string }>;
		balanceAfter: StockAdjustmentQuantities & Readonly<{ version: string }>;
	}>;
	reason: StockAdjustmentReason;
	references: readonly ExternalReference[];
	warnings: readonly Readonly<{
		code: "negative_available";
		reserved: ExactQuantity;
		oversoldBy: ExactQuantity;
		message: string;
	}>[];
	confirmation: Readonly<{ value: string; expiresAt: string }>;
}>;

export type StockAdjustmentReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: typeof STOCK_ADJUSTMENT_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	reason: StockAdjustmentReason;
	effects: readonly Readonly<{
		skuId: string;
		locationId: string;
		onHandDelta: ExactQuantity;
		reservedDelta: ExactQuantity;
		balanceBefore: StockAdjustmentQuantities & Readonly<{ version: string }>;
		balanceAfter: StockAdjustmentQuantities & Readonly<{ version: string }>;
	}>[];
	references: readonly ExternalReference[];
}>;

export type StockAdjustmentRejectionCode =
	| "location_not_found"
	| "location_not_active"
	| "sku_not_registered"
	| "sku_unit_mismatch"
	| "opening_balance_required"
	| "stale_version"
	| "command_id_conflict";

export type StockAdjustmentResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "committed";
			commandId: string;
			receipt: StockAdjustmentReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: StockAdjustmentRejectionCode;
			message: string;
	  }>;

export class InvalidStockAdjustmentCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidStockAdjustmentCommandError";
	}
}

function invalid(message: string): never {
	throw new InvalidStockAdjustmentCommandError(message);
}

function record(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
): void {
	const actual = Object.keys(value);
	if (
		actual.length !== allowed.length ||
		actual.some((key) => !allowed.includes(key))
	) {
		invalid(`${field} must contain exactly ${allowed.join(", ")}.`);
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

export function normalizeSignedNonZeroDecimal(
	value: unknown,
	field = "payload.delta.value",
): string {
	if (typeof value !== "string") {
		invalid(`${field} must be an exact signed decimal string.`);
	}
	const candidate = value.trim();
	if (!/^[+-]?\d+(?:\.\d+)?$/u.test(candidate)) {
		invalid(`${field} must be an exact signed decimal string.`);
	}

	const negative = candidate.startsWith("-");
	const unsigned = candidate.replace(/^[+-]/u, "");
	const [rawWhole, rawFraction] = unsigned.split(".");
	const whole = rawWhole.replace(/^0+(?=\d)/u, "");
	const fraction = rawFraction?.replace(/0+$/u, "") ?? "";
	const magnitude = fraction.length > 0 ? `${whole}.${fraction}` : whole;
	if (magnitude === "0") {
		invalid(`${field} must not be zero.`);
	}
	return negative ? `-${magnitude}` : magnitude;
}

function normalizePositiveVersion(value: unknown, field: string): string {
	if (typeof value !== "string") {
		invalid(`${field} must be a positive integer string.`);
	}
	const candidate = value.trim();
	if (!/^\d+$/u.test(candidate)) {
		invalid(`${field} must be a positive integer string.`);
	}
	const normalized = candidate.replace(/^0+(?=\d)/u, "");
	if (normalized === "0") {
		invalid(`${field} must be greater than zero.`);
	}
	return normalized;
}

function normalizeReferences(value: unknown): readonly ExternalReference[] {
	if (!Array.isArray(value)) {
		invalid("references must be an array.");
	}
	return value.map((reference, index) => {
		const item = record(reference, `references[${index}]`);
		exactKeys(item, `references[${index}]`, ["kind", "id"]);
		return {
			kind: nonEmptyString(item.kind, `references[${index}].kind`),
			id: nonEmptyString(item.id, `references[${index}].id`),
		};
	});
}

function normalizeActionFields(
	input: Record<string, unknown>,
): Omit<PreviewStockAdjustmentInputV1, "schema" | "type"> {
	const context = record(input.context, "context");
	exactKeys(context, "context", ["siteId", "poolId", "locationId"]);
	const payload = record(input.payload, "payload");
	exactKeys(payload, "payload", ["skuId", "delta"]);
	const delta = record(payload.delta, "payload.delta");
	exactKeys(delta, "payload.delta", ["value", "unit"]);
	const reason = record(input.reason, "reason");
	exactKeys(reason, "reason", ["note"]);

	return {
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
			locationId: nonEmptyString(context.locationId, "context.locationId"),
		},
		payload: {
			skuId: nonEmptyString(payload.skuId, "payload.skuId"),
			delta: {
				value: normalizeSignedNonZeroDecimal(delta.value),
				unit: nonEmptyString(delta.unit, "payload.delta.unit"),
			},
		},
		reason: { note: nonEmptyString(reason.note, "reason.note") },
		references: normalizeReferences(input.references),
	};
}

export function normalizePreviewStockAdjustmentInput(
	input: unknown,
): PreviewStockAdjustmentInputV1 {
	const preview = record(input, "preview");
	exactKeys(preview, "preview", [
		"schema",
		"type",
		"context",
		"payload",
		"reason",
		"references",
	]);
	if (preview.schema !== STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA) {
		invalid(`schema must be ${STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA}.`);
	}
	if (preview.type !== STOCK_ADJUSTMENT_TYPE) {
		invalid(`type must be ${STOCK_ADJUSTMENT_TYPE}.`);
	}
	return {
		schema: STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA,
		type: STOCK_ADJUSTMENT_TYPE,
		...normalizeActionFields(preview),
	};
}

export function normalizeAdjustStockCommand(
	input: unknown,
): AdjustStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"reason",
		"references",
		"expectedVersions",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== STOCK_ADJUSTMENT_TYPE) {
		invalid(`type must be ${STOCK_ADJUSTMENT_TYPE}.`);
	}

	const action = normalizeActionFields(command);
	if (!Array.isArray(command.expectedVersions)) {
		invalid("expectedVersions must be an array.");
	}
	if (command.expectedVersions.length !== 1) {
		invalid("expectedVersions must contain exactly one entry.");
	}
	const expected = record(command.expectedVersions[0], "expectedVersions[0]");
	exactKeys(expected, "expectedVersions[0]", [
		"skuId",
		"locationId",
		"version",
	]);
	const skuId = nonEmptyString(expected.skuId, "expectedVersions[0].skuId");
	const locationId = nonEmptyString(
		expected.locationId,
		"expectedVersions[0].locationId",
	);
	if (
		skuId !== action.payload.skuId ||
		locationId !== action.context.locationId
	) {
		invalid("expectedVersions must name the command SKU-location.");
	}
	const version = normalizePositiveVersion(
		expected.version,
		"expectedVersions[0].version",
	);

	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: STOCK_ADJUSTMENT_TYPE,
		...action,
		expectedVersions: [{ skuId, locationId, version }],
	};
}

export function stockAdjustmentActionFromCommand(
	command: AdjustStockCommandV1,
): StockAdjustmentActionV1 {
	return {
		schema: STOCK_ADJUSTMENT_PREVIEW_INPUT_SCHEMA,
		type: STOCK_ADJUSTMENT_TYPE,
		context: command.context,
		payload: command.payload,
		reason: command.reason,
		references: command.references,
		expectedVersion: command.expectedVersions[0].version,
	};
}

export async function digestAdjustStockCommand(
	command: AdjustStockCommandV1,
): Promise<string> {
	return digestCanonicalValue(command);
}

export async function digestStockAdjustmentAction(
	action: StockAdjustmentActionV1,
): Promise<string> {
	return digestCanonicalValue(action);
}
