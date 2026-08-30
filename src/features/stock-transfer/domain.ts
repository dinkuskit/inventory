import {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	RECEIPT_SCHEMA,
	digestCanonicalValue,
	type CommandPrincipal,
	type ExactQuantity,
	type ExternalReference,
} from "../../domain/opening-balance.ts";

export const CREATE_STOCK_TRANSFER_TYPE = "transfer.create" as const;
export const UPDATE_STOCK_TRANSFER_TYPE = "transfer.update" as const;
export const CANCEL_STOCK_TRANSFER_TYPE = "transfer.cancel" as const;
export const DISPATCH_STOCK_TRANSFER_TYPE = "transfer.dispatch" as const;
export const RECEIVE_STOCK_TRANSFER_TYPE = "transfer.receive" as const;
export const REOPEN_STOCK_TRANSFER_TYPE = "transfer.reopen" as const;
export const STOCK_TRANSFER_RECORD_SCHEMA =
	"dinkuskit.inventory.stock-transfer/v1" as const;
export const STOCK_TRANSFER_READ_RESULT_SCHEMA =
	"dinkuskit.inventory.stock-transfer-read-result/v1" as const;
export const STOCK_TRANSFER_LIST_RESULT_SCHEMA =
	"dinkuskit.inventory.stock-transfer-list-result/v1" as const;
export const STOCK_TRANSFER_LIST_DEFAULT_LIMIT = 50;
export const STOCK_TRANSFER_LIST_MAX_LIMIT = 100;

const STOCK_TRANSFER_LIST_CURSOR_SCHEMA =
	"dinkuskit.inventory.stock-transfer-list-cursor/v1" as const;

export type StockTransferLine = Readonly<{
	skuId: string;
	quantity: ExactQuantity;
}>;

export type CreatedStockTransferFields = Readonly<{
	reference: string | null;
	originLocationId: string;
	destinationLocationId: string;
	lines: readonly StockTransferLine[];
	note: string | null;
	expectedDispatchDate: string;
	expectedArrivalDate: string;
}>;

export type CreateStockTransferCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof CREATE_STOCK_TRANSFER_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: CreatedStockTransferFields;
	references: readonly ExternalReference[];
	expectedVersions: readonly [];
}>;

export type UpdateStockTransferCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof UPDATE_STOCK_TRANSFER_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: CreatedStockTransferFields & Readonly<{ transferId: string }>;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		transferId: string;
		version: string;
	}>[];
}>;

export type CancelStockTransferCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof CANCEL_STOCK_TRANSFER_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{ transferId: string }>;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		transferId: string;
		version: string;
	}>[];
}>;

export type DispatchStockTransferCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof DISPATCH_STOCK_TRANSFER_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{ transferId: string }>;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		transferId: string;
		version: string;
	}>[];
}>;

export type ReceiveStockTransferCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof RECEIVE_STOCK_TRANSFER_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{ transferId: string }>;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		transferId: string;
		version: string;
	}>[];
}>;

export type ReopenStockTransferCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof REOPEN_STOCK_TRANSFER_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{ transferId: string; reason: string | null }>;
	references: readonly ExternalReference[];
	expectedVersions: readonly Readonly<{
		transferId: string;
		version: string;
	}>[];
}>;

export type StockTransferCommandV1 =
	| CreateStockTransferCommandV1
	| UpdateStockTransferCommandV1
	| CancelStockTransferCommandV1
	| DispatchStockTransferCommandV1
	| ReceiveStockTransferCommandV1
	| ReopenStockTransferCommandV1;

export type StockTransferStatus =
	| "created"
	| "in_transit"
	| "received"
	| "canceled";

export type StockTransferListView = "open" | "done";

export type StockTransferListScope =
	| Readonly<{ kind: "location"; locationId: string }>
	| Readonly<{ kind: "all_locations" }>;

export type ReadStockTransferListInput = Readonly<{
	poolId: string;
	view: StockTransferListView;
	scope: StockTransferListScope;
	limit?: number;
	cursor?: string;
}>;

export type NormalizedReadStockTransferListInput = Readonly<{
	poolId: string;
	view: StockTransferListView;
	scope: StockTransferListScope;
	limit: number;
	cursor?: string;
}>;

export type StockTransferListEndpoint = Readonly<{
	locationId: string;
	name: string;
	status: "active" | "archived";
}>;

type StockTransferListRowBase = Readonly<{
	transferId: string;
	reference: string;
	status: StockTransferStatus;
	origin: StockTransferListEndpoint;
	destination: StockTransferListEndpoint;
	productLineCount: number;
}>;

export type StockTransferListRow =
	| (StockTransferListRowBase &
			Readonly<{
				status: "created" | "in_transit";
				createdAt: string;
				expectedDispatchDate: string;
				expectedArrivalDate: string;
			}>)
	| (StockTransferListRowBase &
			Readonly<{
				status: "received";
				dispatchedDate: string;
				receivedDate: string;
			}>)
	| (StockTransferListRowBase &
			Readonly<{
				status: "canceled";
				createdAt: string;
				canceledAt: string;
			}>);

export type StockTransferListResult =
	| Readonly<{
			schema: typeof STOCK_TRANSFER_LIST_RESULT_SCHEMA;
			outcome: "listed";
			poolId: string;
			view: StockTransferListView;
			scope: StockTransferListScope;
			transfers: readonly StockTransferListRow[];
			next: string | null;
	  }>
	| Readonly<{
			schema: typeof STOCK_TRANSFER_LIST_RESULT_SCHEMA;
			outcome: "location_not_found" | "location_not_active";
			poolId: string;
			view: StockTransferListView;
			scope: Readonly<{ kind: "location"; locationId: string }>;
	  }>;

export type StockTransferRecord = Readonly<{
	schema: typeof STOCK_TRANSFER_RECORD_SCHEMA;
	poolId: string;
	transferId: string;
	reference: string;
	status: StockTransferStatus;
	originLocationId: string;
	destinationLocationId: string;
	lines: readonly StockTransferLine[];
	note: string | null;
	createdAt: string;
	createdBy: CommandPrincipal;
	updatedAt: string;
	version: string;
	expectedDispatchDate: string;
	expectedArrivalDate: string;
	dispatchedDate: string | null;
	receivedDate: string | null;
	canceledAt: string | null;
}>;

export type StockTransferBalanceSnapshot = Readonly<{
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	outgoingTransferCommitted: ExactQuantity;
	available: ExactQuantity;
	expected: ExactQuantity;
	inTransit: ExactQuantity;
	version: string;
}>;

export type StockTransferBalanceEffect = Readonly<{
	skuId: string;
	locationId: string;
	onHandDelta: ExactQuantity;
	reservedDelta: ExactQuantity;
	outgoingTransferCommittedDelta: ExactQuantity;
	expectedDelta: ExactQuantity;
	inTransitDelta: ExactQuantity;
	balanceBefore: StockTransferBalanceSnapshot | null;
	balanceAfter: StockTransferBalanceSnapshot;
}>;

export type StockTransferReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: StockTransferCommandV1["type"];
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	transfer: Readonly<{
		before: StockTransferRecord | null;
		after: StockTransferRecord;
	}>;
	effects: readonly StockTransferBalanceEffect[];
	reason?: string | null;
	references: readonly ExternalReference[];
}>;

export type StockTransferWarning = Readonly<{
	code: "negative_available";
	skuId: string;
	locationId: string;
	reservedForOrders: ExactQuantity;
	outgoingTransferCommitted: ExactQuantity;
	oversoldBy: ExactQuantity;
	message: string;
}>;

export type StockTransferLineStock = Readonly<{
	skuId: string;
	originMovable: ExactQuantity;
	quantityToMove: ExactQuantity;
	destinationOnHand: ExactQuantity;
	projectedOriginAvailable: ExactQuantity;
	reservedForOrders: ExactQuantity;
	availability: "available" | "not_available";
}>;

export type StockTransferRejectionCode =
	| "command_id_conflict"
	| "transfer_not_found"
	| "transfer_not_created"
	| "transfer_not_in_transit"
	| "positive_transfer_quantity_required"
	| "transfer_reference_conflict"
	| "stale_version"
	| "location_not_found"
	| "location_not_active"
	| "sku_not_registered"
	| "sku_unit_mismatch"
	| "opening_balance_required";

export type StockTransferResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "committed";
			commandId: string;
			transfer: StockTransferRecord;
			receipt: StockTransferReceiptV2;
			warnings: readonly StockTransferWarning[];
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: StockTransferRejectionCode;
			message: string;
	  }>;

export type ReadStockTransferInput = Readonly<{
	poolId: string;
	transferId: string;
}>;

export type StockTransferReadResult =
	| Readonly<{
			schema: typeof STOCK_TRANSFER_READ_RESULT_SCHEMA;
			outcome: "found";
			transfer: StockTransferRecord;
			lineStock: readonly StockTransferLineStock[];
	  }>
	| Readonly<{
			schema: typeof STOCK_TRANSFER_READ_RESULT_SCHEMA;
			outcome: "not_found";
			poolId: string;
			transferId: string;
	  }>;

export class InvalidStockTransferCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidStockTransferCommandError";
	}
}

export class InvalidStockTransferListQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidStockTransferListQueryError";
	}
}

function invalid(message: string): never {
	throw new InvalidStockTransferCommandError(message);
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
	if (typeof value !== "string") invalid(`${field} must be a string.`);
	const normalized = value.trim();
	if (normalized.length === 0) invalid(`${field} must not be empty.`);
	return normalized;
}

function optionalNote(value: unknown): string | null {
	if (value === null) return null;
	if (typeof value !== "string") invalid("payload.note must be a string or null.");
	const normalized = value.trim();
	return normalized.length === 0 ? null : normalized;
}

function optionalReason(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") {
		invalid("payload.reason must be a string or null.");
	}
	const normalized = value.trim();
	return normalized.length === 0 ? null : normalized;
}

function nonNegativeDecimal(value: unknown, field: string): string {
	if (typeof value !== "string") {
		invalid(`${field} must be an exact non-negative decimal string.`);
	}
	const candidate = value.trim();
	if (!/^\d+(?:\.\d+)?$/u.test(candidate)) {
		invalid(`${field} must be an exact non-negative decimal string.`);
	}
	const [rawWhole, rawFraction] = candidate.split(".");
	const whole = rawWhole.replace(/^0+(?=\d)/u, "");
	const fraction = rawFraction?.replace(/0+$/u, "") ?? "";
	return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

function positiveVersion(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
		invalid(`${field} must be a positive integer string.`);
	}
	const normalized = value.trim().replace(/^0+(?=\d)/u, "");
	if (normalized === "0") invalid(`${field} must be greater than zero.`);
	return normalized;
}

function calendarDate(value: unknown, field: string): string {
	const normalized = nonEmptyString(value, field);
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
		invalid(`${field} must be a YYYY-MM-DD date.`);
	}
	const parsed = new Date(`${normalized}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
		invalid(`${field} must be a valid calendar date.`);
	}
	return normalized;
}

export function normalizeStockTransferReference(value: unknown): Readonly<{
	reference: string;
	referenceKey: string;
}> {
	const reference = nonEmptyString(value, "payload.reference")
		.normalize("NFKC")
		.replace(/\s+/gu, " ");
	return { reference, referenceKey: reference.toLocaleLowerCase("en-US") };
}

function normalizeReferences(value: unknown): readonly ExternalReference[] {
	if (!Array.isArray(value)) invalid("references must be an array.");
	return value.map((item, index) => {
		const reference = record(item, `references[${index}]`);
		exactKeys(reference, `references[${index}]`, ["kind", "id"]);
		return {
			kind: nonEmptyString(reference.kind, `references[${index}].kind`),
			id: nonEmptyString(reference.id, `references[${index}].id`),
		};
	});
}

function normalizeCreatedFields(
	value: unknown,
	options: Readonly<{ includeTransferId: boolean }>,
): CreatedStockTransferFields & Readonly<{ transferId?: string }> {
	const payload = record(value, "payload");
	const keys = [
		...(options.includeTransferId ? ["transferId"] : []),
		"reference",
		"originLocationId",
		"destinationLocationId",
		"lines",
		"note",
		"expectedDispatchDate",
		"expectedArrivalDate",
	];
	exactKeys(payload, "payload", keys);
	const originLocationId = nonEmptyString(
		payload.originLocationId,
		"payload.originLocationId",
	);
	const destinationLocationId = nonEmptyString(
		payload.destinationLocationId,
		"payload.destinationLocationId",
	);
	if (originLocationId === destinationLocationId) {
		invalid("Origin and destination locations must be different.");
	}
	if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
		invalid("payload.lines must contain at least one item.");
	}
	const seenSkuIds = new Set<string>();
	const lines = payload.lines.map((item, index) => {
		const line = record(item, `payload.lines[${index}]`);
		exactKeys(line, `payload.lines[${index}]`, ["skuId", "quantity"]);
		const quantity = record(
			line.quantity,
			`payload.lines[${index}].quantity`,
		);
		exactKeys(quantity, `payload.lines[${index}].quantity`, ["value", "unit"]);
		const skuId = nonEmptyString(line.skuId, `payload.lines[${index}].skuId`);
		if (seenSkuIds.has(skuId)) invalid("A transfer cannot contain the same SKU twice.");
		seenSkuIds.add(skuId);
		const unit = nonEmptyString(quantity.unit, `payload.lines[${index}].quantity.unit`);
		if (unit !== "each") invalid("Stock transfer quantities must use each.");
		return {
			skuId,
			quantity: {
				value: nonNegativeDecimal(
					quantity.value,
					`payload.lines[${index}].quantity.value`,
				),
				unit,
			},
		};
	});
	const expectedDispatchDate = calendarDate(
		payload.expectedDispatchDate,
		"payload.expectedDispatchDate",
	);
	const expectedArrivalDate = calendarDate(
		payload.expectedArrivalDate,
		"payload.expectedArrivalDate",
	);
	if (expectedArrivalDate < expectedDispatchDate) {
		invalid("Expected arrival cannot precede expected dispatch.");
	}
	let reference: string | null;
	if (payload.reference === null && !options.includeTransferId) {
		reference = null;
	} else {
		reference = normalizeStockTransferReference(payload.reference).reference;
	}
	const result = {
		reference,
		originLocationId,
		destinationLocationId,
		lines,
		note: optionalNote(payload.note),
		expectedDispatchDate,
		expectedArrivalDate,
	};
	return options.includeTransferId
		? {
				transferId: nonEmptyString(payload.transferId, "payload.transferId"),
				...result,
			}
		: result;
}

function normalizeContext(value: unknown): Readonly<{ siteId: string; poolId: string }> {
	const context = record(value, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	return {
		siteId: nonEmptyString(context.siteId, "context.siteId"),
		poolId: nonEmptyString(context.poolId, "context.poolId"),
	};
}

function normalizeExpectedTransferVersion(
	value: unknown,
	transferId: string,
): readonly Readonly<{ transferId: string; version: string }>[] {
	if (!Array.isArray(value) || value.length !== 1) {
		invalid("expectedVersions must contain exactly one transfer version.");
	}
	const expected = record(value[0], "expectedVersions[0]");
	exactKeys(expected, "expectedVersions[0]", ["transferId", "version"]);
	const expectedTransferId = nonEmptyString(
		expected.transferId,
		"expectedVersions[0].transferId",
	);
	if (expectedTransferId !== transferId) {
		invalid("expectedVersions must name the command transfer.");
	}
	return [
		{
			transferId,
			version: positiveVersion(expected.version, "expectedVersions[0].version"),
		},
	];
}

export function normalizeStockTransferCommand(
	input: unknown,
): StockTransferCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
		"expectedVersions",
	]);
	if (command.schema !== COMMAND_SCHEMA) invalid(`schema must be ${COMMAND_SCHEMA}.`);
	const type = command.type as StockTransferCommandV1["type"];
	if (![
		CREATE_STOCK_TRANSFER_TYPE,
		UPDATE_STOCK_TRANSFER_TYPE,
		CANCEL_STOCK_TRANSFER_TYPE,
		DISPATCH_STOCK_TRANSFER_TYPE,
		RECEIVE_STOCK_TRANSFER_TYPE,
		REOPEN_STOCK_TRANSFER_TYPE,
	].includes(type)) {
		invalid("type must be a supported stock transfer command.");
	}
	const base = {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		context: normalizeContext(command.context),
		references: normalizeReferences(command.references),
	};
	if (type === CREATE_STOCK_TRANSFER_TYPE) {
		if (!Array.isArray(command.expectedVersions) || command.expectedVersions.length !== 0) {
			invalid("transfer.create expectedVersions must be empty.");
		}
		return {
			...base,
			type: CREATE_STOCK_TRANSFER_TYPE,
			payload: normalizeCreatedFields(command.payload, { includeTransferId: false }),
			expectedVersions: [],
		};
	}
	if (type === UPDATE_STOCK_TRANSFER_TYPE) {
		const payload = normalizeCreatedFields(command.payload, { includeTransferId: true }) as UpdateStockTransferCommandV1["payload"];
		return {
			...base,
			type: UPDATE_STOCK_TRANSFER_TYPE,
			payload,
			expectedVersions: normalizeExpectedTransferVersion(
				command.expectedVersions,
				payload.transferId,
			),
		};
	}
	const payload = record(command.payload, "payload");
	exactKeys(
		payload,
		"payload",
		type === REOPEN_STOCK_TRANSFER_TYPE
			? ["transferId", "reason"]
			: ["transferId"],
	);
	const transferId = nonEmptyString(payload.transferId, "payload.transferId");
	const expectedVersions = normalizeExpectedTransferVersion(
		command.expectedVersions,
		transferId,
	);
	if (type === REOPEN_STOCK_TRANSFER_TYPE) {
		return {
			...base,
			type: REOPEN_STOCK_TRANSFER_TYPE,
			payload: { transferId, reason: optionalReason(payload.reason) },
			expectedVersions,
		};
	}
	if (type === DISPATCH_STOCK_TRANSFER_TYPE) {
		return {
			...base,
			type: DISPATCH_STOCK_TRANSFER_TYPE,
			payload: { transferId },
			expectedVersions,
		};
	}
	if (type === RECEIVE_STOCK_TRANSFER_TYPE) {
		return {
			...base,
			type: RECEIVE_STOCK_TRANSFER_TYPE,
			payload: { transferId },
			expectedVersions,
		};
	}
	return {
		...base,
		type: CANCEL_STOCK_TRANSFER_TYPE,
		payload: { transferId },
		expectedVersions,
	};
}

export function normalizeReadStockTransferInput(
	input: unknown,
): ReadStockTransferInput {
	const query = record(input, "stock transfer query");
	exactKeys(query, "stock transfer query", ["poolId", "transferId"]);
	return {
		poolId: nonEmptyString(query.poolId, "poolId"),
		transferId: nonEmptyString(query.transferId, "transferId"),
	};
}

function invalidListQuery(message: string): never {
	throw new InvalidStockTransferListQueryError(message);
}

function listQueryRecord(
	value: unknown,
	field: string,
): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalidListQuery(`${field} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function listQueryExactKeys(
	value: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
): void {
	const actual = Object.keys(value);
	if (
		actual.length !== allowed.length ||
		actual.some((key) => !allowed.includes(key))
	) {
		invalidListQuery(`${field} must contain exactly ${allowed.join(", ")}.`);
	}
}

function listQueryAllowedKeys(
	value: Record<string, unknown>,
	field: string,
	allowed: readonly string[],
): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) {
		invalidListQuery(`${field} contains unsupported fields.`);
	}
}

function listQueryNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string") {
		invalidListQuery(`${field} must be a string.`);
	}
	const normalized = value.trim();
	if (normalized.length === 0) {
		invalidListQuery(`${field} must not be empty.`);
	}
	return normalized;
}

function normalizeStockTransferListScope(
	value: unknown,
): StockTransferListScope {
	const scope = listQueryRecord(value, "scope");
	if (scope.kind === "location") {
		listQueryExactKeys(scope, "scope", ["kind", "locationId"]);
		return {
			kind: "location",
			locationId: listQueryNonEmptyString(
				scope.locationId,
				"scope.locationId",
			),
		};
	}
	if (scope.kind === "all_locations") {
		listQueryExactKeys(scope, "scope", ["kind"]);
		return { kind: "all_locations" };
	}
	invalidListQuery('scope.kind must be "location" or "all_locations".');
}

export function normalizeReadStockTransferListInput(
	input: unknown,
): NormalizedReadStockTransferListInput {
	const query = listQueryRecord(input, "stock transfer list query");
	listQueryAllowedKeys(query, "stock transfer list query", [
		"poolId",
		"view",
		"scope",
		"limit",
		"cursor",
	]);
	const view = query.view;
	if (view !== "open" && view !== "done") {
		invalidListQuery('view must be "open" or "done".');
	}
	const limit = query.limit === undefined
		? STOCK_TRANSFER_LIST_DEFAULT_LIMIT
		: query.limit;
	if (
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > STOCK_TRANSFER_LIST_MAX_LIMIT
	) {
		invalidListQuery(
			`limit must be an integer from 1 through ${STOCK_TRANSFER_LIST_MAX_LIMIT}.`,
		);
	}
	const normalized: NormalizedReadStockTransferListInput = {
		poolId: listQueryNonEmptyString(query.poolId, "poolId"),
		view,
		scope: normalizeStockTransferListScope(query.scope),
		limit,
	};
	return query.cursor === undefined
		? normalized
		: {
				...normalized,
				cursor: listQueryNonEmptyString(query.cursor, "cursor"),
			};
}

export type StockTransferListCursorPosition = Readonly<{
	sortDate: string;
	updatedAt: string;
	transferId: string;
}>;

type StockTransferListCursorPayload = StockTransferListCursorPosition &
	Readonly<{
		schema: typeof STOCK_TRANSFER_LIST_CURSOR_SCHEMA;
		poolId: string;
		view: StockTransferListView;
		scope: StockTransferListScope;
	}>;

function encodeBase64Url(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/gu, "-")
		.replace(/\//gu, "_")
		.replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): string {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
		invalidListQuery("cursor must be a valid opaque transfer-list cursor.");
	}
	const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
	const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
	const binary = atob(padded);
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function validCursorDate(value: unknown, field: string): string {
	const normalized = listQueryNonEmptyString(value, field);
	if (Number.isNaN(Date.parse(normalized))) {
		invalidListQuery(`${field} must be a valid date or timestamp.`);
	}
	return normalized;
}

function sameStockTransferListScope(
	left: StockTransferListScope,
	right: StockTransferListScope,
): boolean {
	return left.kind === right.kind &&
		(left.kind === "all_locations" ||
			(right.kind === "location" && left.locationId === right.locationId));
}

export function encodeStockTransferListCursor(
	query: Pick<NormalizedReadStockTransferListInput, "poolId" | "view" | "scope">,
	position: StockTransferListCursorPosition,
): string {
	return encodeBase64Url(JSON.stringify({
		schema: STOCK_TRANSFER_LIST_CURSOR_SCHEMA,
		poolId: query.poolId,
		view: query.view,
		scope: query.scope,
		sortDate: position.sortDate,
		updatedAt: position.updatedAt,
		transferId: position.transferId,
	} satisfies StockTransferListCursorPayload));
}

export function decodeStockTransferListCursor(
	cursor: string,
	query: Pick<NormalizedReadStockTransferListInput, "poolId" | "view" | "scope">,
): StockTransferListCursorPosition {
	try {
		const payload = listQueryRecord(
			JSON.parse(decodeBase64Url(cursor)),
			"cursor payload",
		);
		listQueryExactKeys(payload, "cursor payload", [
			"schema",
			"poolId",
			"view",
			"scope",
			"sortDate",
			"updatedAt",
			"transferId",
		]);
		if (payload.schema !== STOCK_TRANSFER_LIST_CURSOR_SCHEMA) {
			invalidListQuery("cursor schema is not supported.");
		}
		const poolId = listQueryNonEmptyString(payload.poolId, "cursor.poolId");
		const view = payload.view;
		if (view !== "open" && view !== "done") {
			invalidListQuery("cursor.view is invalid.");
		}
		const scope = normalizeStockTransferListScope(payload.scope);
		if (
			poolId !== query.poolId ||
			view !== query.view ||
			!sameStockTransferListScope(scope, query.scope)
		) {
			invalidListQuery("cursor does not belong to this transfer-list query.");
		}
		return {
			sortDate: validCursorDate(payload.sortDate, "cursor.sortDate"),
			updatedAt: validCursorDate(payload.updatedAt, "cursor.updatedAt"),
			transferId: listQueryNonEmptyString(
				payload.transferId,
				"cursor.transferId",
			),
		};
	} catch (error) {
		if (error instanceof InvalidStockTransferListQueryError) throw error;
		invalidListQuery("cursor must be a valid opaque transfer-list cursor.");
	}
}

export async function digestStockTransferCommand(
	command: StockTransferCommandV1,
): Promise<string> {
	return digestCanonicalValue(command);
}
