export const COMMAND_SCHEMA = "dinkuskit.inventory.command/v1" as const;
export const COMMAND_RESULT_SCHEMA =
	"dinkuskit.inventory.command-result/v1" as const;
export const RECEIPT_SCHEMA = "dinkuskit.inventory.receipt/v2" as const;
export const OPENING_BALANCE_PREVIEW_INPUT_SCHEMA =
	"dinkuskit.inventory.opening-balance-preview-input/v1" as const;
export const OPENING_BALANCE_PREVIEW_SCHEMA =
	"dinkuskit.inventory.opening-balance-preview/v1" as const;
export const OPENING_BALANCE_TYPE = "stock.opening_balance" as const;
export const DEFAULT_OPENING_BALANCE_REASON_NOTE = "Set Initial Stock" as const;

export type ExactQuantity = Readonly<{
	value: string;
	unit: string;
}>;

export type ExternalReference = Readonly<{
	kind: string;
	id: string;
}>;

export type SetOpeningBalanceCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof OPENING_BALANCE_TYPE;
	context: Readonly<{
		siteId: string;
		poolId: string;
		locationId: string;
	}>;
	payload: Readonly<{
		skuId: string;
		quantity: ExactQuantity;
	}>;
	reason: Readonly<{
		code: string;
		note: string;
	}>;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		skuId: string;
		locationId: string;
		version: string;
	}>[];
}>;

export type PreviewOpeningBalanceInputV1 = Readonly<{
	schema: typeof OPENING_BALANCE_PREVIEW_INPUT_SCHEMA;
	type: typeof OPENING_BALANCE_TYPE;
	context: Readonly<{
		siteId: string;
		poolId: string;
		locationId: string;
	}>;
	payload: Readonly<{
		skuId: string;
		quantity: ExactQuantity;
	}>;
	reason: Readonly<{
		code: string;
		note: string;
	}>;
	references: readonly ExternalReference[];
}>;

export type HumanCommandPrincipal = Readonly<{
	kind: "human";
	id: string;
	displayName: string;
	surface: string;
}>;

export type SystemCommandPrincipal = Readonly<{
	kind: "system";
	id: string;
	surface: string;
}>;

export type CommandPrincipal =
	| HumanCommandPrincipal
	| SystemCommandPrincipal;

export type SkuLocationKey = Readonly<{
	poolId: string;
	locationId: string;
	skuId: string;
}>;

export type BalanceRecord = Readonly<
	SkuLocationKey & {
		onHand: ExactQuantity;
		reserved: ExactQuantity;
		outgoingTransferCommitted: ExactQuantity;
		available: ExactQuantity;
		expected: ExactQuantity;
		inTransit: ExactQuantity;
		version: string;
		hasStockHistory: boolean;
	}
>;

export type OpeningBalancePreviewV1 = Readonly<{
	schema: typeof OPENING_BALANCE_PREVIEW_SCHEMA;
	type: typeof OPENING_BALANCE_TYPE;
	context: PreviewOpeningBalanceInputV1["context"];
	effect: Readonly<{
		skuId: string;
		locationId: string;
		onHandDelta: ExactQuantity;
		reservedDelta: ExactQuantity;
		balanceBefore: Readonly<{
			onHand: ExactQuantity;
			reserved: ExactQuantity;
			outgoingTransferCommitted: ExactQuantity;
			available: ExactQuantity;
			expected: ExactQuantity;
			inTransit: ExactQuantity;
			version: string;
		}>;
		balanceAfter: Readonly<{
			onHand: ExactQuantity;
			reserved: ExactQuantity;
			outgoingTransferCommitted: ExactQuantity;
			available: ExactQuantity;
			expected: ExactQuantity;
			inTransit: ExactQuantity;
			version: string;
		}>;
	}>;
	reason: PreviewOpeningBalanceInputV1["reason"];
	references: readonly ExternalReference[];
	warning: string;
	confirmation: Readonly<{
		value: string;
		expiresAt: string;
	}>;
}>;

export type OpeningBalanceReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: typeof OPENING_BALANCE_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{
		siteId: string;
		poolId: string;
	}>;
	reason: Readonly<{
		code: string;
		note: string;
	}>;
	effects: readonly Readonly<{
		skuId: string;
		locationId: string;
		onHandDelta: ExactQuantity;
		reservedDelta: ExactQuantity;
		balanceAfter: Readonly<{
			onHand: ExactQuantity;
			reserved: ExactQuantity;
			outgoingTransferCommitted: ExactQuantity;
			available: ExactQuantity;
			expected: ExactQuantity;
			inTransit: ExactQuantity;
			version: string;
		}>;
	}>[];
	references: readonly ExternalReference[];
}>;

export type OpeningBalanceRejectionCode =
	| "location_not_found"
	| "location_not_active"
	| "sku_not_registered"
	| "sku_unit_mismatch"
	| "stale_version"
	| "opening_balance_already_set"
	| "command_id_conflict";

export type OpeningBalanceResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "committed";
			commandId: string;
			receipt: OpeningBalanceReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: OpeningBalanceRejectionCode;
			message: string;
	  }>;

export class InvalidOpeningBalanceCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidOpeningBalanceCommandError";
	}
}

function invalid(message: string): never {
	throw new InvalidOpeningBalanceCommandError(message);
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

function nonNegativeVersion(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
		invalid(`${field} must be a non-negative integer string.`);
	}
	return value.trim().replace(/^0+(?=\d)/u, "");
}

export function normalizeNonNegativeDecimal(
	value: unknown,
	field = "quantity.value",
): string {
	if (typeof value !== "string") {
		invalid(`${field} must be an exact decimal string.`);
	}
	const candidate = value.trim();
	if (!/^\d+(?:\.\d+)?$/u.test(candidate)) {
		invalid(`${field} must be a non-negative decimal string.`);
	}
	const [rawWhole, rawFraction] = candidate.split(".");
	const whole = rawWhole.replace(/^0+(?=\d)/u, "");
	const fraction = rawFraction?.replace(/0+$/u, "") ?? "";
	return fraction.length > 0 ? `${whole}.${fraction}` : whole;
}

export function normalizeSetOpeningBalanceCommand(
	input: unknown,
): SetOpeningBalanceCommandV1 {
	const command = record(input, "command");
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== OPENING_BALANCE_TYPE) {
		invalid(`type must be ${OPENING_BALANCE_TYPE}.`);
	}

	const context = record(command.context, "context");
	const payload = record(command.payload, "payload");
	const quantity = record(payload.quantity, "payload.quantity");
	const reason = record(command.reason, "reason");
	const commandId = nonEmptyString(command.commandId, "commandId");
	const siteId = nonEmptyString(context.siteId, "context.siteId");
	const poolId = nonEmptyString(context.poolId, "context.poolId");
	const locationId = nonEmptyString(
		context.locationId,
		"context.locationId",
	);
	const skuId = nonEmptyString(payload.skuId, "payload.skuId");
	const unit = nonEmptyString(quantity.unit, "payload.quantity.unit");
	const value = normalizeNonNegativeDecimal(quantity.value);
	const reasonCode = nonEmptyString(reason.code, "reason.code");
	const reasonNote = nonEmptyString(reason.note, "reason.note");

	if (!Array.isArray(command.references)) {
		invalid("references must be an array.");
	}
	const references = command.references.map((reference, index) => {
		const item = record(reference, `references[${index}]`);
		return {
			kind: nonEmptyString(item.kind, `references[${index}].kind`),
			id: nonEmptyString(item.id, `references[${index}].id`),
		};
	});

	if (!Array.isArray(command.expectedVersions)) {
		invalid("expectedVersions must be an array.");
	}
	if (command.expectedVersions.length !== 1) {
		invalid("expectedVersions must contain exactly one entry.");
	}
	const expectedVersion = record(
		command.expectedVersions[0],
		"expectedVersions[0]",
	);
	if (
		nonEmptyString(expectedVersion.skuId, "expectedVersions[0].skuId") !==
			skuId ||
		nonEmptyString(
			expectedVersion.locationId,
			"expectedVersions[0].locationId",
		) !== locationId ||
		typeof expectedVersion.version !== "string"
	) {
		invalid(
			"expectedVersions must name the command SKU-location.",
		);
	}
	const version = nonNegativeVersion(
		expectedVersion.version,
		"expectedVersions[0].version",
	);

	return {
		schema: COMMAND_SCHEMA,
		commandId,
		type: OPENING_BALANCE_TYPE,
		context: { siteId, poolId, locationId },
		payload: { skuId, quantity: { value, unit } },
		reason: { code: reasonCode, note: reasonNote },
		references,
		expectedVersions: [{ skuId, locationId, version }],
	};
}

export function normalizePreviewOpeningBalanceInput(
	input: unknown,
): PreviewOpeningBalanceInputV1 {
	const preview = record(input, "preview");
	if (preview.schema !== OPENING_BALANCE_PREVIEW_INPUT_SCHEMA) {
		invalid(`schema must be ${OPENING_BALANCE_PREVIEW_INPUT_SCHEMA}.`);
	}
	if (preview.type !== OPENING_BALANCE_TYPE) {
		invalid(`type must be ${OPENING_BALANCE_TYPE}.`);
	}

	const context = record(preview.context, "context");
	const payload = record(preview.payload, "payload");
	const quantity = record(payload.quantity, "payload.quantity");
	const reason = record(preview.reason, "reason");
	const siteId = nonEmptyString(context.siteId, "context.siteId");
	const poolId = nonEmptyString(context.poolId, "context.poolId");
	const locationId = nonEmptyString(
		context.locationId,
		"context.locationId",
	);
	const skuId = nonEmptyString(payload.skuId, "payload.skuId");
	const unit = nonEmptyString(quantity.unit, "payload.quantity.unit");
	const value = normalizeNonNegativeDecimal(quantity.value);
	const reasonCode = nonEmptyString(reason.code, "reason.code");
	const reasonNote = nonEmptyString(reason.note, "reason.note");

	if (!Array.isArray(preview.references)) {
		invalid("references must be an array.");
	}
	const references = preview.references.map((reference, index) => {
		const item = record(reference, `references[${index}]`);
		return {
			kind: nonEmptyString(item.kind, `references[${index}].kind`),
			id: nonEmptyString(item.id, `references[${index}].id`),
		};
	});

	return {
		schema: OPENING_BALANCE_PREVIEW_INPUT_SCHEMA,
		type: OPENING_BALANCE_TYPE,
		context: { siteId, poolId, locationId },
		payload: { skuId, quantity: { value, unit } },
		reason: { code: reasonCode, note: reasonNote },
		references,
	};
}

export function openingBalanceActionFromCommand(
	command: SetOpeningBalanceCommandV1,
): PreviewOpeningBalanceInputV1 {
	return {
		schema: OPENING_BALANCE_PREVIEW_INPUT_SCHEMA,
		type: OPENING_BALANCE_TYPE,
		context: command.context,
		payload: command.payload,
		reason: command.reason,
		references: command.references,
	};
}

export function normalizeCommandPrincipal(input: unknown): CommandPrincipal {
	const principal = record(input, "principal");
	if (principal.kind !== "human" && principal.kind !== "system") {
		invalid('principal.kind must be "human" or "system".');
	}
	const id = nonEmptyString(principal.id, "principal.id");
	const surface = nonEmptyString(principal.surface, "principal.surface");
	return principal.kind === "human"
		? {
				kind: "human",
				id,
				displayName: nonEmptyString(
					principal.displayName,
					"principal.displayName",
				),
				surface,
			}
		: { kind: "system", id, surface };
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (isRecord(value)) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonicalize(value[key])]),
		);
	}
	return value;
}

export function canonicalCommandJson(
	command: SetOpeningBalanceCommandV1,
): string {
	return JSON.stringify(canonicalize(command));
}

export async function digestCommand(
	command: SetOpeningBalanceCommandV1,
): Promise<string> {
	return digestCanonicalValue(command);
}

export async function digestOpeningBalanceAction(
	action: PreviewOpeningBalanceInputV1,
): Promise<string> {
	return digestCanonicalValue(action);
}

export async function digestCommandPrincipal(
	principal: CommandPrincipal,
): Promise<string> {
	return digestCanonicalValue({
		kind: principal.kind,
		id: principal.id,
		surface: principal.surface,
	});
}

export async function digestOpaqueConfirmation(value: string): Promise<string> {
	return digestCanonicalValue(value);
}

export async function digestCanonicalValue(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(
		JSON.stringify(canonicalize(value)),
	);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `sha256:${hex}`;
}
