import {
	COMMAND_RESULT_SCHEMA,
	COMMAND_SCHEMA,
	RECEIPT_SCHEMA,
	digestCanonicalValue,
	type CommandPrincipal,
	type ExternalReference,
} from "./opening-balance.ts";

export const REGISTER_MANAGED_SKU_TYPE = "sku.register" as const;
export const MANAGED_SKU_UNIT = "each" as const;

export type ManagedSkuRecord = Readonly<{
	poolId: string;
	skuId: string;
	unit: typeof MANAGED_SKU_UNIT;
	version: "1";
	registeredAt: string;
}>;

export type RegisterManagedSkuCommandV1 = Readonly<{
	schema: typeof COMMAND_SCHEMA;
	commandId: string;
	type: typeof REGISTER_MANAGED_SKU_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{
		skuId: string;
		unit: typeof MANAGED_SKU_UNIT;
	}>;
	references: readonly ExternalReference[];
}>;

export type ManagedSkuReceiptV2 = Readonly<{
	schema: typeof RECEIPT_SCHEMA;
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: typeof REGISTER_MANAGED_SKU_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	effect: Readonly<{
		before: null;
		after: ManagedSkuRecord;
	}>;
	references: readonly ExternalReference[];
}>;

export type RegisterManagedSkuRejectionCode =
	| "command_id_conflict"
	| "sku_already_registered";

export type RegisterManagedSkuResult =
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "committed";
			commandId: string;
			receipt: ManagedSkuReceiptV2;
	  }>
	| Readonly<{
			schema: typeof COMMAND_RESULT_SCHEMA;
			outcome: "rejected";
			commandId: string;
			code: RegisterManagedSkuRejectionCode;
			message: string;
	  }>;

export class InvalidManagedSkuCommandError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidManagedSkuCommandError";
	}
}

function invalid(message: string): never {
	throw new InvalidManagedSkuCommandError(message);
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

export function normalizeRegisterManagedSkuCommand(
	input: unknown,
): RegisterManagedSkuCommandV1 {
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
	if (command.type !== REGISTER_MANAGED_SKU_TYPE) {
		invalid(`type must be ${REGISTER_MANAGED_SKU_TYPE}.`);
	}

	const context = record(command.context, "context");
	exactKeys(context, "context", ["siteId", "poolId"]);
	const payload = record(command.payload, "payload");
	exactKeys(payload, "payload", ["skuId", "unit"]);
	if (payload.unit !== MANAGED_SKU_UNIT) {
		invalid(`payload.unit must be ${MANAGED_SKU_UNIT}.`);
	}

	return {
		schema: COMMAND_SCHEMA,
		commandId: nonEmptyString(command.commandId, "commandId"),
		type: REGISTER_MANAGED_SKU_TYPE,
		context: {
			siteId: nonEmptyString(context.siteId, "context.siteId"),
			poolId: nonEmptyString(context.poolId, "context.poolId"),
		},
		payload: {
			skuId: nonEmptyString(payload.skuId, "payload.skuId"),
			unit: MANAGED_SKU_UNIT,
		},
		references: normalizeReferences(command.references),
	};
}

export async function digestRegisterManagedSkuCommand(
	command: RegisterManagedSkuCommandV1,
): Promise<string> {
	return digestCanonicalValue(command);
}
