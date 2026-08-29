import {
	COMMAND_RESULT_SCHEMA,
	normalizeCommandPrincipal,
	type CommandPrincipal,
} from "../domain/opening-balance.ts";
import {
	MANAGED_SKU_UNIT,
	digestRegisterManagedSkuCommand,
	normalizeRegisterManagedSkuCommand,
	type InventorySkuIdentity,
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
	createInventorySkuId: () => string;
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

function identityFrom(sku: ManagedSkuRecord): InventorySkuIdentity {
	return {
		inventorySkuId: sku.inventorySkuId,
		sku: sku.sku,
		displayName: sku.displayName,
	};
}

function inventorySkuIdFrom(createInventorySkuId: () => string): string {
	const inventorySkuId = createInventorySkuId();
	if (
		typeof inventorySkuId !== "string" ||
		inventorySkuId.trim().length === 0
	) {
		throw new TypeError(
			"createInventorySkuId must return a non-empty string.",
		);
	}
	return inventorySkuId.trim();
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
	if (typeof dependencies.createInventorySkuId !== "function") {
		throw new TypeError("createInventorySkuId is required.");
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

				const existingSku = transaction.getManagedSkuBySku(command.payload.sku);
				if (existingSku !== null) {
					const result: RegisterManagedSkuResult = {
						schema: COMMAND_RESULT_SCHEMA,
						outcome: "existing",
						commandId: command.commandId,
						inventorySku: identityFrom(existingSku),
					};
					transaction.storeCommandResult({
						commandId: command.commandId,
						commandDigest,
						result,
					});
					return result;
				}

				const registeredAt = committedAtFrom(dependencies.now);
				const sku: ManagedSkuRecord = {
					poolId: command.context.poolId,
					inventorySkuId: inventorySkuIdFrom(
						dependencies.createInventorySkuId,
					),
					sku: command.payload.sku,
					displayName: command.payload.displayNameIfNew,
					unit: MANAGED_SKU_UNIT,
					version: "1",
					registeredAt,
					registeredBy: principal,
				};
				const result: RegisterManagedSkuResult = {
					schema: COMMAND_RESULT_SCHEMA,
					outcome: "registered",
					commandId: command.commandId,
					inventorySku: identityFrom(sku),
				};
				transaction.commitManagedSku({
					commandId: command.commandId,
					commandDigest,
					sku,
					result,
				});
				return result;
			},
		);
	};
}
