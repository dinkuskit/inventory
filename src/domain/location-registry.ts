import {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	RECEIPT_SCHEMA,
	digestCanonicalValue,
	type CommandPrincipal,
	type ExactQuantity,
	type ExternalReference,
	type OpeningBalanceReceiptV2,
	type OpeningBalanceResult,
} from "./opening-balance.ts";
import type { RegisterManagedSkuResult } from "../features/managed-sku/index.ts";
import type {
	StockAdjustmentReceiptV2,
	StockAdjustmentResult,
} from "../features/stock-adjustment/index.ts";
import type {
	StockTransferReceiptV2,
	StockTransferResult,
} from "../features/stock-transfer/index.ts";

export const CREATE_LOCATION_TYPE = "location.create" as const;
export const RENAME_LOCATION_TYPE = "location.rename" as const;
export const ARCHIVE_LOCATION_TYPE = "location.archive" as const;
export const RESTORE_LOCATION_TYPE = "location.restore" as const;
export const LOCATION_LIST_RESULT_SCHEMA =
	"dinkuskit.inventory.location-list-result/v1" as const;

export type LocationStatus = "active" | "archived";

export type LocationRecord = Readonly<{
	poolId: string;
	locationId: string;
	name: string;
	nameKey: string;
	status: LocationStatus;
	version: string;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}>;

type LocationCommandBase = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	references: readonly ExternalReference[];
}>;

export type CreateLocationCommandV1 = LocationCommandBase &
	Readonly<{
		type: typeof CREATE_LOCATION_TYPE;
		context: Readonly<{ siteId: string; poolId: string }>;
		payload: Readonly<{ name: string }>;
	}>;

export type RenameLocationCommandV1 = LocationCommandBase &
	Readonly<{
		type: typeof RENAME_LOCATION_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
			locationId: string;
		}>;
		payload: Readonly<{ name: string }>;
	}>;

export type ArchiveLocationCommandV1 = LocationCommandBase &
	Readonly<{
		type: typeof ARCHIVE_LOCATION_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
			locationId: string;
		}>;
		payload: Readonly<Record<string, never>>;
	}>;

export type RestoreLocationCommandV1 = LocationCommandBase &
	Readonly<{
		type: typeof RESTORE_LOCATION_TYPE;
		context: Readonly<{
			siteId: string;
			poolId: string;
			locationId: string;
		}>;
		payload: Readonly<Record<string, never>>;
	}>;

export type LocationCommandV1 =
	| CreateLocationCommandV1
	| RenameLocationCommandV1
	| ArchiveLocationCommandV1
	| RestoreLocationCommandV1;

export type LocationBalanceBlocker = Readonly<{
	skuId: string;
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	outgoingTransferCommitted: ExactQuantity;
	expected: ExactQuantity;
	inTransit: ExactQuantity;
}>;

export type LocationReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: LocationCommandV1["type"];
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	effect: Readonly<{
		before: LocationRecord | null;
		after: LocationRecord;
	}>;
	references: readonly ExternalReference[];
}>;

export type LocationRejectionCode =
	| "command_id_conflict"
	| "location_name_conflict"
	| "location_not_found"
	| "location_already_archived"
	| "location_not_archived"
	| "location_not_empty";

export type LocationCommandResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "committed";
			commandId: string;
			receipt: LocationReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: Exclude<LocationRejectionCode, "location_not_empty">;
			message: string;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: "location_not_empty";
			message: string;
			blockers: readonly LocationBalanceBlocker[];
	  }>;

export type InventoryCommandResult =
	| OpeningBalanceResult
	| LocationCommandResult
	| RegisterManagedSkuResult
	| StockAdjustmentResult
	| StockTransferResult;
export type InventoryReceiptV2 =
	| OpeningBalanceReceiptV2
	| LocationReceiptV2
	| StockAdjustmentReceiptV2
	| StockTransferReceiptV2;

export type ListLocationsInput = Readonly<{
	poolId: string;
	status: LocationStatus;
}>;

export type LocationListResult = Readonly<{
	schema: typeof LOCATION_LIST_RESULT_SCHEMA;
	poolId: string;
	status: LocationStatus;
	locations: readonly LocationRecord[];
}>;

export class InvalidLocationCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidLocationCommandError";
	}
}

function invalid(message: string): never {
	throw new InvalidLocationCommandError(message);
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

export function normalizeLocationName(value: unknown): Readonly<{
	name: string;
	nameKey: string;
}> {
	const name = nonEmptyString(value, "payload.name").normalize("NFKC");
	return { name, nameKey: name.toLowerCase() };
}

function normalizeReferences(value: unknown): readonly ExternalReference[] {
	if (!Array.isArray(value)) {
		invalid("references must be an array.");
	}
	return value.map((reference, index) => {
		const item = record(reference, `references[${index}]`);
		return {
			kind: nonEmptyString(item.kind, `references[${index}].kind`),
			id: nonEmptyString(item.id, `references[${index}].id`),
		};
	});
}

export function normalizeLocationCommand(input: unknown): LocationCommandV1 {
	const command = record(input, "command");
	if (command.schema !== COMMAND_SCHEMA) {
		invalid(`schema must be ${COMMAND_SCHEMA}.`);
	}
	const commandId = nonEmptyString(command.commandId, "commandId");
	const context = record(command.context, "context");
	const payload = record(command.payload, "payload");
	const siteId = nonEmptyString(context.siteId, "context.siteId");
	const poolId = nonEmptyString(context.poolId, "context.poolId");
	const references = normalizeReferences(command.references);

	switch (command.type) {
		case CREATE_LOCATION_TYPE: {
			const { name } = normalizeLocationName(payload.name);
			return {
				schema: COMMAND_SCHEMA,
				commandId,
				type: CREATE_LOCATION_TYPE,
				context: { siteId, poolId },
				payload: { name },
				references,
			};
		}
		case RENAME_LOCATION_TYPE: {
			const locationId = nonEmptyString(
				context.locationId,
				"context.locationId",
			);
			const { name } = normalizeLocationName(payload.name);
			return {
				schema: COMMAND_SCHEMA,
				commandId,
				type: RENAME_LOCATION_TYPE,
				context: { siteId, poolId, locationId },
				payload: { name },
				references,
			};
		}
		case ARCHIVE_LOCATION_TYPE:
		case RESTORE_LOCATION_TYPE: {
			const locationId = nonEmptyString(
				context.locationId,
				"context.locationId",
			);
			return {
				schema: COMMAND_SCHEMA,
				commandId,
				type: command.type,
				context: { siteId, poolId, locationId },
				payload: {},
				references,
			};
		}
		default:
			invalid(
				`type must be ${CREATE_LOCATION_TYPE}, ${RENAME_LOCATION_TYPE}, ${ARCHIVE_LOCATION_TYPE}, or ${RESTORE_LOCATION_TYPE}.`,
			);
	}
}

export function normalizeListLocationsInput(input: unknown): ListLocationsInput {
	const query = record(input, "location list query");
	if (query.status !== "active" && query.status !== "archived") {
		invalid('status must be "active" or "archived".');
	}
	return {
		poolId: nonEmptyString(query.poolId, "poolId"),
		status: query.status,
	};
}

export async function digestLocationCommand(
	command: LocationCommandV1,
): Promise<string> {
	return digestCanonicalValue(command);
}
