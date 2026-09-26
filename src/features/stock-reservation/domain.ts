import {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	RECEIPT_SCHEMA,
	digestCanonicalValue,
	type CommandPrincipal,
	type ExactQuantity,
	type ExternalReference,
} from "../../domain/opening-balance.ts";

export const RESERVE_STOCK_TYPE = "stock.reserve" as const;
export const RELEASE_STOCK_TYPE = "stock.release" as const;
export const PACK_STOCK_TYPE = "stock.pack" as const;
export const PACK_ALL_STOCK_TYPE = "stock.pack_all" as const;
export const PACK_SOME_STOCK_TYPE = "stock.pack_some" as const;
export const UNPACK_STOCK_TYPE = "stock.unpack" as const;
export const RESERVATION_RECORD_SCHEMA =
	"dinkuskit.inventory.reservation/v1" as const;

export type ReservationStatus =
	| "not_shipped"
	| "partially_packed"
	| "canceled"
	| "packed";

export function holdIsOpen(status: ReservationStatus): boolean {
	return status === "not_shipped" || status === "partially_packed";
}

export type ReservationOrderLine = ExternalReference;

export type ReservationRecord = Readonly<{
	schema: typeof RESERVATION_RECORD_SCHEMA;
	reservationId: string;
	poolId: string;
	locationId: string;
	skuId: string;
	quantity: ExactQuantity;
	originalQuantity: ExactQuantity;
	orderLine: ReservationOrderLine;
	status: ReservationStatus;
	version: string;
	createdAt: string;
	canceledAt: string | null;
	packedAt: string | null;
	createdBy: CommandPrincipal;
	canceledBy: CommandPrincipal | null;
	packedBy: CommandPrincipal | null;
}>;

type ReservationCommandBase = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	references: readonly ExternalReference[];
}>;

export type ReserveStockCommandV1 = ReservationCommandBase &
	Readonly<{
		type: typeof RESERVE_STOCK_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
			locationId: string;
		}>;
		payload: Readonly<{
			skuId: string;
			quantity: ExactQuantity;
			orderLine: ReservationOrderLine;
		}>;
	}>;

export type ReleaseStockCommandV1 = ReservationCommandBase &
	Readonly<{
		type: typeof RELEASE_STOCK_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
		}>;
		payload: Readonly<{
			reservationId: string;
		}>;
	}>;

export type PackStockCommandV1 = ReservationCommandBase &
	Readonly<{
		type: typeof PACK_STOCK_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
		}>;
		payload: Readonly<{
			reservationId: string;
		}>;
	}>;

export type PackAllStockCommandV1 = ReservationCommandBase &
	Readonly<{
		type: typeof PACK_ALL_STOCK_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
		}>;
		payload: Readonly<{
			reservationIds: readonly string[];
		}>;
	}>;

export type PackSomeStockCommandV1 = ReservationCommandBase &
	Readonly<{
		type: typeof PACK_SOME_STOCK_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
		}>;
		payload: Readonly<{
			reservationId: string;
			quantity: ExactQuantity;
		}>;
	}>;

export type UnpackStockCommandV1 = ReservationCommandBase &
	Readonly<{
		type: typeof UNPACK_STOCK_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
		}>;
		payload: Readonly<{
			reservationId: string;
		}>;
	}>;

export type StockReservationCommandV1 =
	| ReserveStockCommandV1
	| ReleaseStockCommandV1
	| PackStockCommandV1
	| PackAllStockCommandV1
	| PackSomeStockCommandV1
	| UnpackStockCommandV1;

export type StockReservationBalanceQuantities = Readonly<{
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	outgoingTransferCommitted: ExactQuantity;
	available: ExactQuantity;
	version: string;
}>;

export type StockReservationBalanceEffect = Readonly<{
	skuId: string;
	locationId: string;
	onHandDelta: ExactQuantity;
	reservedDelta: ExactQuantity;
	balanceBefore: StockReservationBalanceQuantities;
	balanceAfter: StockReservationBalanceQuantities;
}>;

export type StockReservationReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: StockReservationCommandV1["type"];
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	reservation: Readonly<{
		before: ReservationRecord | null;
		after: ReservationRecord;
	}>;
	holds?: readonly Readonly<{
		before: ReservationRecord;
		after: ReservationRecord;
	}>[];
	effects: readonly StockReservationBalanceEffect[];
	references: readonly ExternalReference[];
}>;

export type StockReservationRejectionCode =
	| "command_id_conflict"
	| "location_not_found"
	| "location_not_active"
	| "sku_not_registered"
	| "sku_unit_mismatch"
	| "insufficient_available"
	| "order_line_conflict"
	| "reservation_not_found"
	| "reservation_not_active"
	| "reservation_already_packed"
	| "reservation_quantity_exceeds_hold"
	| "reservation_not_packed";

export type StockReservationResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "reserved" | "released" | "packed" | "packed_some" | "unpacked";
			commandId: string;
			reservation: ReservationRecord;
			receipt: StockReservationReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "packed_all";
			commandId: string;
			reservations: readonly ReservationRecord[];
			receipt: StockReservationReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "existing";
			commandId: string;
			reservation: ReservationRecord;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: StockReservationRejectionCode;
			message: string;
	  }>;

export class InvalidStockReservationCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidStockReservationCommandError";
	}
}

function invalid(message: string): never {
	throw new InvalidStockReservationCommandError(message);
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

function normalizeOrderLine(value: unknown, field: string): ReservationOrderLine {
	const item = record(value, field);
	exactKeys(item, field, ["kind", "id"]);
	return {
		kind: nonEmptyString(item.kind, `${field}.kind`),
		id: nonEmptyString(item.id, `${field}.id`),
	};
}

function normalizePositiveDecimal(value: unknown, field: string): string {
	if (typeof value !== "string") {
		invalid(`${field} must be an exact decimal string.`);
	}
	const candidate = value.trim();
	if (!/^\d+(?:\.\d+)?$/u.test(candidate)) {
		invalid(`${field} must be a positive decimal string.`);
	}
	const [rawWhole, rawFraction] = candidate.split(".");
	const whole = rawWhole.replace(/^0+(?=\d)/u, "");
	const fraction = rawFraction?.replace(/0+$/u, "") ?? "";
	const normalized = fraction.length > 0 ? `${whole}.${fraction}` : whole;
	if (normalized === "0") {
		invalid(`${field} must be a positive decimal string.`);
	}
	return normalized;
}

export function reservationOrderLineKey(orderLine: ReservationOrderLine): string {
	return JSON.stringify([orderLine.kind, orderLine.id]);
}

export function normalizeReserveStockCommand(
	input: unknown,
): ReserveStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== RESERVE_STOCK_TYPE) {
		invalid(`type must be ${RESERVE_STOCK_TYPE}.`);
	}
	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId", "locationId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["skuId", "quantity", "orderLine"]);
	const quantity = record(payload.quantity, "payload.quantity");
	exactKeys(quantity, "payload.quantity", ["value", "unit"]);
	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: RESERVE_STOCK_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
			locationId: nonEmptyString(context.locationId, "context.locationId"),
		},
		payload: {
			skuId: nonEmptyString(payload.skuId, "payload.skuId"),
			quantity: {
				value: normalizePositiveDecimal(
					quantity.value,
					"payload.quantity.value",
				),
				unit: nonEmptyString(quantity.unit, "payload.quantity.unit"),
			},
			orderLine: normalizeOrderLine(payload.orderLine, "payload.orderLine"),
		},
		references: normalizeReferences(command.references),
	};
}

export function normalizeReleaseStockCommand(
	input: unknown,
): ReleaseStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== RELEASE_STOCK_TYPE) {
		invalid(`type must be ${RELEASE_STOCK_TYPE}.`);
	}
	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["reservationId"]);
	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: RELEASE_STOCK_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
		},
		payload: {
			reservationId: nonEmptyString(
				payload.reservationId,
				"payload.reservationId",
			),
		},
		references: normalizeReferences(command.references),
	};
}

function reservationIds(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.length === 0) {
		invalid("payload.reservationIds must name one or more tickets.");
	}
	const ids = value.map((id, index) =>
		nonEmptyString(id, `payload.reservationIds[${index}]`),
	);
	if (new Set(ids).size !== ids.length) {
		invalid("payload.reservationIds must not contain duplicates.");
	}
	return ids;
}

export function normalizePackAllStockCommand(
	input: unknown,
): PackAllStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== PACK_ALL_STOCK_TYPE) {
		invalid(`type must be ${PACK_ALL_STOCK_TYPE}.`);
	}
	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["reservationIds"]);
	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: PACK_ALL_STOCK_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
		},
		payload: {
			reservationIds: reservationIds(payload.reservationIds),
		},
		references: normalizeReferences(command.references),
	};
}

export function normalizePackSomeStockCommand(
	input: unknown,
): PackSomeStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== PACK_SOME_STOCK_TYPE) {
		invalid(`type must be ${PACK_SOME_STOCK_TYPE}.`);
	}
	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["reservationId", "quantity"]);
	const quantity = record(payload.quantity, "payload.quantity");
	exactKeys(quantity, "payload.quantity", ["value", "unit"]);
	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: PACK_SOME_STOCK_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
		},
		payload: {
			reservationId: nonEmptyString(
				payload.reservationId,
				"payload.reservationId",
			),
			quantity: {
				value: normalizePositiveDecimal(
					quantity.value,
					"payload.quantity.value",
				),
				unit: nonEmptyString(quantity.unit, "payload.quantity.unit"),
			},
		},
		references: normalizeReferences(command.references),
	};
}

export function normalizeUnpackStockCommand(
	input: unknown,
): UnpackStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== UNPACK_STOCK_TYPE) {
		invalid(`type must be ${UNPACK_STOCK_TYPE}.`);
	}
	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["reservationId"]);
	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: UNPACK_STOCK_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
		},
		payload: {
			reservationId: nonEmptyString(
				payload.reservationId,
				"payload.reservationId",
			),
		},
		references: normalizeReferences(command.references),
	};
}

export function normalizePackStockCommand(
	input: unknown,
): PackStockCommandV1 {
	const command = record(input, "command");
	exactKeys(command, "command", [
		"schema",
		"commandId",
		"type",
		"context",
		"payload",
		"references",
	]);
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	if (command.type !== PACK_STOCK_TYPE) {
		invalid(`type must be ${PACK_STOCK_TYPE}.`);
	}
	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["reservationId"]);
	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: PACK_STOCK_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
		},
		payload: {
			reservationId: nonEmptyString(
				payload.reservationId,
				"payload.reservationId",
			),
		},
		references: normalizeReferences(command.references),
	};
}

export function normalizeStockReservationCommand(
	input: unknown,
): StockReservationCommandV1 {
	const command = record(input, "command");
	if (command.type === RESERVE_STOCK_TYPE) {
		return normalizeReserveStockCommand(input);
	}
	if (command.type === RELEASE_STOCK_TYPE) {
		return normalizeReleaseStockCommand(input);
	}
	if (command.type === PACK_STOCK_TYPE) {
		return normalizePackStockCommand(input);
	}
	if (command.type === PACK_ALL_STOCK_TYPE) {
		return normalizePackAllStockCommand(input);
	}
	if (command.type === PACK_SOME_STOCK_TYPE) {
		return normalizePackSomeStockCommand(input);
	}
	if (command.type === UNPACK_STOCK_TYPE) {
		return normalizeUnpackStockCommand(input);
	}
	invalid(
		"type must be stock.reserve, stock.release, stock.pack, stock.pack_all, stock.pack_some, or stock.unpack.",
	);
}

export async function digestStockReservationCommand(
	command: StockReservationCommandV1,
): Promise<string> {
	return digestCanonicalValue(command);
}

export function sameReservationContents(
	reservation: ReservationRecord,
	command: ReserveStockCommandV1,
): boolean {
	return (
		reservation.locationId === command.context.locationId &&
		reservation.skuId === command.payload.skuId &&
		reservation.originalQuantity.value === command.payload.quantity.value &&
		reservation.originalQuantity.unit === command.payload.quantity.unit &&
		reservation.orderLine.kind === command.payload.orderLine.kind &&
		reservation.orderLine.id === command.payload.orderLine.id
	);
}
