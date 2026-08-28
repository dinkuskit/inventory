import {
	COMMAND_RESULT_SCHEMA,
	RECEIPT_SCHEMA,
	normalizeCommandPrincipal,
	type CommandPrincipal,
} from "../domain/opening-balance.ts";
import {
	MANAGED_SKU_UNIT,
	REGISTER_MANAGED_SKU_TYPE,
	digestRegisterManagedSkuCommand,
	normalizeRegisterManagedSkuCommand,
	type ManagedSkuReceiptV2,
	type ManagedSkuRecord,
	type RegisterManagedSkuCommandV1,
	type RegisterManagedSkuResult,
} from "../domain/managed-sku.ts";
import type { InventoryStore } from "../storage/inventory-store.ts";

export type RegisterManagedSkuExecution = Readonly<{
	principal: CommandPrincipal;
}>;

export type RegisterManagedSku = (
	command: RegisterManagedSkuCommandV1,
	execution: RegisterManagedSkuExecution,
) => Promise<RegisterManagedSkuResult>;

export type RegisterManagedSkuDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReceiptId: () => string;
}>;

function conflict(commandId: string): RegisterManagedSkuResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	};
}

function alreadyRegistered(commandId: string): RegisterManagedSkuResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "sku_already_registered",
		message: "This SKU is already set up.",
	};
}

function receiptIdFrom(createReceiptId: () => string): string {
	const receiptId = createReceiptId();
	if (typeof receiptId !== "string" || receiptId.trim().length === 0) {
		throw new TypeError("createReceiptId must return a non-empty string.");
	}
	return receiptId.trim();
}

function committedAtFrom(now: () => Date): string {
	const current = now();
	if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
		throw new TypeError("now must return a valid Date.");
	}
	return current.toISOString();
}

export function createRegisterManagedSku(
	dependencies: RegisterManagedSkuDependencies,
): RegisterManagedSku {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	if (typeof dependencies.now !== "function") {
		throw new TypeError("now is required.");
	}
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}

	return async function registerManagedSku(
		commandInput: RegisterManagedSkuCommandV1,
		executionInput: RegisterManagedSkuExecution,
	): Promise<RegisterManagedSkuResult> {
		const command = normalizeRegisterManagedSkuCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestRegisterManagedSkuCommand(command);

		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) => {
				const existing = transaction.getCommand<RegisterManagedSkuResult>(
					command.commandId,
				);
				if (existing !== null) {
					return existing.commandDigest === commandDigest
						? existing.result
						: conflict(command.commandId);
				}

				if (transaction.getManagedSku(command.payload.skuId) !== null) {
					const result = alreadyRegistered(command.commandId);
					transaction.storeRejection({
						commandId: command.commandId,
						commandDigest,
						result,
					});
					return result;
				}

				const committedAt = committedAtFrom(dependencies.now);
				const sku: ManagedSkuRecord = {
					poolId: command.context.poolId,
					skuId: command.payload.skuId,
					unit: MANAGED_SKU_UNIT,
					version: "1",
					registeredAt: committedAt,
				};
				const receipt: ManagedSkuReceiptV2 = {
					schema: RECEIPT_SCHEMA,
					receiptId: receiptIdFrom(dependencies.createReceiptId),
					commandId: command.commandId,
					commandDigest,
					status: "committed",
					type: REGISTER_MANAGED_SKU_TYPE,
					committedAt,
					principal,
					context: command.context,
					effect: { before: null, after: sku },
					references: command.references,
				};
				const result: RegisterManagedSkuResult = {
					schema: COMMAND_RESULT_SCHEMA,
					outcome: "committed",
					commandId: command.commandId,
					receipt,
				};
				transaction.commitManagedSku({
					commandId: command.commandId,
					commandDigest,
					sku,
					receipt,
					result,
				});
				return result;
			},
		);
	};
}
