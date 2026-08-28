import {
	COMMAND_RESULT_SCHEMA,
	OPENING_BALANCE_TYPE,
	RECEIPT_SCHEMA,
	digestCommand,
	normalizeCommandPrincipal,
	normalizeSetOpeningBalanceCommand,
	type BalanceRecord,
	type CommandPrincipal,
	type OpeningBalanceReceiptV1,
	type OpeningBalanceResult,
	type SetOpeningBalanceCommandV1,
} from "../domain/opening-balance.ts";
import type { InventoryStore } from "../storage/inventory-store.ts";

export type SetOpeningBalanceExecution = Readonly<{
	principal: CommandPrincipal;
}>;

export type SetOpeningBalance = (
	command: SetOpeningBalanceCommandV1,
	execution: SetOpeningBalanceExecution,
) => Promise<OpeningBalanceResult>;

export type SetOpeningBalanceDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReceiptId: () => string;
}>;

function conflict(commandId: string): OpeningBalanceResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	};
}

function alreadySet(commandId: string): OpeningBalanceResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "opening_balance_already_set",
		message: "This SKU-location already has committed stock history.",
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

export function createSetOpeningBalance(
	dependencies: SetOpeningBalanceDependencies,
): SetOpeningBalance {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	if (typeof dependencies.now !== "function") {
		throw new TypeError("now is required.");
	}
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}

	return async function setOpeningBalance(
		commandInput: SetOpeningBalanceCommandV1,
		executionInput: SetOpeningBalanceExecution,
	): Promise<OpeningBalanceResult> {
		const command = normalizeSetOpeningBalanceCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestCommand(command);
		const key = {
			poolId: command.context.poolId,
			locationId: command.context.locationId,
			skuId: command.payload.skuId,
		};

		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) => {
				const existing = transaction.getCommand(command.commandId);
				if (existing !== null) {
					return existing.commandDigest === commandDigest
						? existing.result
						: conflict(command.commandId);
				}

				const existingBalance = transaction.getBalance(key);
				if (existingBalance?.hasStockHistory === true) {
					const result = alreadySet(command.commandId);
					transaction.storeRejection({
						commandId: command.commandId,
						commandDigest,
						result,
					});
					return result;
				}

				const zero = { value: "0", unit: command.payload.quantity.unit };
				const balance: BalanceRecord = {
					...key,
					onHand: command.payload.quantity,
					reserved: zero,
					available: command.payload.quantity,
					version: "1",
					hasStockHistory: true,
				};
				const receipt: OpeningBalanceReceiptV1 = {
					schema: RECEIPT_SCHEMA,
					receiptId: receiptIdFrom(dependencies.createReceiptId),
					commandId: command.commandId,
					commandDigest,
					status: "committed",
					type: OPENING_BALANCE_TYPE,
					committedAt: committedAtFrom(dependencies.now),
					principal,
					context: {
						siteId: command.context.siteId,
						poolId: command.context.poolId,
					},
					reason: command.reason,
					effects: [
						{
							skuId: command.payload.skuId,
							locationId: command.context.locationId,
							onHandDelta: command.payload.quantity,
							reservedDelta: zero,
							balanceAfter: {
								onHand: command.payload.quantity,
								reserved: zero,
								available: command.payload.quantity,
								version: "1",
							},
						},
					],
					references: command.references,
				};
				const result: OpeningBalanceResult = {
					schema: COMMAND_RESULT_SCHEMA,
					outcome: "committed",
					commandId: command.commandId,
					receipt,
				};

				transaction.commitOpeningBalance({
					commandId: command.commandId,
					commandDigest,
					balance,
					receipt,
					result,
				});
				return result;
			},
		);
	};
}
