import {
	COMMAND_RESULT_SCHEMA,
	RECEIPT_SCHEMA,
	normalizeCommandPrincipal,
	type BalanceRecord,
	type CommandPrincipal,
	type ExactQuantity,
} from "../../domain/opening-balance.ts";
import {
	addExactDecimal,
	subtractExactDecimal,
} from "../../domain/exact-decimal.ts";
import type {
	InventoryStore,
	InventoryTransaction,
} from "../../storage/inventory-store.ts";
import {
	STOCK_ADJUSTMENT_TYPE,
	digestAdjustStockCommand,
	normalizeAdjustStockCommand,
	type AdjustStockCommandV1,
	type StockAdjustmentReceiptV2,
	type StockAdjustmentRejectionCode,
	type StockAdjustmentResult,
} from "./domain.ts";

export type AdjustStockExecution = Readonly<{ principal: CommandPrincipal }>;
export type AdjustStock = (
	command: AdjustStockCommandV1,
	execution: AdjustStockExecution,
) => Promise<StockAdjustmentResult>;
export type AdjustStockDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReceiptId: () => string;
}>;
export type AdjustStockTransactionDependencies = Readonly<{
	now: () => Date;
	createReceiptId: () => string;
}>;

function incrementVersion(version: string): string {
	return (BigInt(version) + 1n).toString();
}

function rejection(
	commandId: string,
	code: StockAdjustmentRejectionCode,
	message: string,
): StockAdjustmentResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code,
		message,
	};
}

function receiptIdFrom(createReceiptId: () => string): string {
	const value = createReceiptId();
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("createReceiptId must return a non-empty string.");
	}
	return value.trim();
}

function committedAtFrom(now: () => Date): string {
	const value = now();
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new TypeError("now must return a valid Date.");
	}
	return value.toISOString();
}

function quantities(balance: BalanceRecord): Readonly<{
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	available: ExactQuantity;
	version: string;
}> {
	return {
		onHand: balance.onHand,
		reserved: balance.reserved,
		available: balance.available,
		version: balance.version,
	};
}

function durableRejection(
	transaction: InventoryTransaction,
	commandId: string,
	commandDigest: string,
	code: StockAdjustmentRejectionCode,
	message: string,
): StockAdjustmentResult {
	const result = rejection(commandId, code, message);
	transaction.storeRejection({ commandId, commandDigest, result });
	return result;
}

export function executeAdjustStockInTransaction(
	transaction: InventoryTransaction,
	command: AdjustStockCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: AdjustStockTransactionDependencies,
): StockAdjustmentResult {
	const existing = transaction.getCommand<StockAdjustmentResult>(
		command.commandId,
	);
	if (existing !== null) {
		return existing.commandDigest === commandDigest
			? existing.result
			: rejection(
					command.commandId,
					"command_id_conflict",
					"The command ID is already bound to different contents.",
				);
	}

	const location = transaction.getLocation(command.context.locationId);
	if (location === null) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"location_not_found",
			"The location does not exist in this inventory pool.",
		);
	}
	if (location.status !== "active") {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"location_not_active",
			"The location is archived and cannot be adjusted.",
		);
	}

	const managedSku = transaction.getManagedSku(command.payload.skuId);
	if (managedSku === null) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"sku_not_registered",
			"This SKU is not set up for inventory.",
		);
	}
	if (managedSku.unit !== command.payload.delta.unit) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"sku_unit_mismatch",
			"The stock quantity unit does not match this SKU.",
		);
	}

	const key = {
		poolId: command.context.poolId,
		locationId: command.context.locationId,
		skuId: command.payload.skuId,
	};
	const before = transaction.getBalance(key);
	if (before === null || !before.hasStockHistory) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"opening_balance_required",
			"Set Initial Stock before making a stock adjustment.",
		);
	}
	if (
		before.onHand.unit !== command.payload.delta.unit ||
		before.reserved.unit !== command.payload.delta.unit ||
		before.available.unit !== command.payload.delta.unit
	) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"sku_unit_mismatch",
			"The stock quantity unit does not match this SKU.",
		);
	}
	const expectedVersion = command.expectedVersions[0].version;
	if (before.version !== expectedVersion) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"stale_version",
			"Stock changed after preview. Preview the adjustment again.",
		);
	}

	const unit = command.payload.delta.unit;
	const nextOnHand = addExactDecimal(
		before.onHand.value,
		command.payload.delta.value,
	);
	const nextAvailable = subtractExactDecimal(
		subtractExactDecimal(nextOnHand, before.reserved.value),
		before.outgoingTransferCommitted.value,
	);
	const after: BalanceRecord = {
		...key,
		onHand: { value: nextOnHand, unit },
		reserved: before.reserved,
		outgoingTransferCommitted: before.outgoingTransferCommitted,
		available: { value: nextAvailable, unit },
		expected: before.expected,
		inTransit: before.inTransit,
		version: incrementVersion(before.version),
		hasStockHistory: true,
	};
	const zero = { value: "0", unit };
	const receipt: StockAdjustmentReceiptV2 = {
		schema: RECEIPT_SCHEMA,
		receiptId: receiptIdFrom(dependencies.createReceiptId),
		commandId: command.commandId,
		commandDigest,
		status: "committed",
		type: STOCK_ADJUSTMENT_TYPE,
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
				onHandDelta: command.payload.delta,
				reservedDelta: zero,
				balanceBefore: quantities(before),
				balanceAfter: quantities(after),
			},
		],
		references: command.references,
	};
	const result: StockAdjustmentResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "committed",
		commandId: command.commandId,
		receipt,
	};
	transaction.commitStockAdjustment({
		commandId: command.commandId,
		commandDigest,
		previousVersion: before.version,
		balance: after,
		receipt,
		result,
	});
	return result;
}

export function createAdjustStock(
	dependencies: AdjustStockDependencies,
): AdjustStock {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	if (typeof dependencies.now !== "function") {
		throw new TypeError("now is required.");
	}
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}
	return async (commandInput, executionInput) => {
		const command = normalizeAdjustStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestAdjustStockCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executeAdjustStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}
