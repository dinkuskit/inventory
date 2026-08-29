import {
	COMMAND_RESULT_SCHEMA,
	digestCommandPrincipal,
	digestOpaqueConfirmation,
	normalizeCommandPrincipal,
	type BalanceRecord,
	type CommandPrincipal,
	type ExactQuantity,
} from "../../domain/opening-balance.ts";
import type { InventoryStore } from "../../storage/inventory-store.ts";
import {
	addExactDecimal,
	executeAdjustStockInTransaction,
	subtractExactDecimal,
} from "./adjust.ts";
import {
	STOCK_ADJUSTMENT_PREVIEW_SCHEMA,
	STOCK_ADJUSTMENT_TYPE,
	digestAdjustStockCommand,
	digestStockAdjustmentAction,
	normalizeAdjustStockCommand,
	normalizePreviewStockAdjustmentInput,
	stockAdjustmentActionFromCommand,
	type AdjustStockCommandV1,
	type PreviewStockAdjustmentInputV1,
	type StockAdjustmentActionV1,
	type StockAdjustmentPreviewV1,
	type StockAdjustmentResult,
} from "./domain.ts";

export const STOCK_ADJUSTMENT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;

export type StockAdjustmentConfirmationErrorCode =
	| "confirmation_not_found"
	| "confirmation_expired"
	| "confirmation_mismatch"
	| "confirmation_already_used";

export class StockAdjustmentConfirmationError extends Error {
	readonly code: StockAdjustmentConfirmationErrorCode;

	constructor(code: StockAdjustmentConfirmationErrorCode, message: string) {
		super(message);
		this.name = "StockAdjustmentConfirmationError";
		this.code = code;
	}
}

export type StockAdjustmentPreviewErrorCode =
	| "location_not_found"
	| "location_not_active"
	| "sku_not_registered"
	| "sku_unit_mismatch"
	| "opening_balance_required"
	| "stale_version";

export class StockAdjustmentPreviewError extends Error {
	readonly code: StockAdjustmentPreviewErrorCode;

	constructor(code: StockAdjustmentPreviewErrorCode, message: string) {
		super(message);
		this.name = "StockAdjustmentPreviewError";
		this.code = code;
	}
}

export type PreviewStockAdjustmentExecution = Readonly<{
	principal: CommandPrincipal;
}>;
export type PreviewStockAdjustment = (
	input: PreviewStockAdjustmentInputV1,
	execution: PreviewStockAdjustmentExecution,
) => Promise<StockAdjustmentPreviewV1>;
export type PreviewStockAdjustmentDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createConfirmation: () => string;
}>;

export type ConfirmStockAdjustmentExecution = Readonly<{
	principal: CommandPrincipal;
}>;
export type ConfirmStockAdjustment = (
	confirmation: string,
	command: AdjustStockCommandV1,
	execution: ConfirmStockAdjustmentExecution,
) => Promise<StockAdjustmentResult>;
export type ConfirmStockAdjustmentDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReceiptId: () => string;
}>;

function requireDependencies(
	dependencies: Readonly<{ store: InventoryStore; now: () => Date }>,
): void {
	if (dependencies?.store === undefined) throw new TypeError("store is required.");
	if (typeof dependencies.now !== "function") throw new TypeError("now is required.");
}

function dateFrom(now: () => Date): Date {
	const value = now();
	if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
		throw new TypeError("now must return a valid Date.");
	}
	return value;
}

function confirmationFrom(createConfirmation: () => string): string {
	const value = createConfirmation();
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError("createConfirmation must return a non-empty string.");
	}
	return value.trim();
}

function confirmationInput(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new StockAdjustmentConfirmationError(
			"confirmation_not_found",
			"The stock-adjustment confirmation was not found.",
		);
	}
	return value.trim();
}

function timestampFrom(value: string): number {
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		throw new Error("Stored stock-adjustment confirmation expiry is invalid.");
	}
	return timestamp;
}

function previewError(code: StockAdjustmentPreviewErrorCode): never {
	const messages: Record<StockAdjustmentPreviewErrorCode, string> = {
		location_not_found: "The location does not exist in this inventory pool.",
		location_not_active: "The location is archived and cannot be adjusted.",
		sku_not_registered: "This SKU is not set up for inventory.",
		sku_unit_mismatch: "The stock quantity unit does not match this SKU.",
		opening_balance_required: "Set Initial Stock before making a stock adjustment.",
		stale_version: "Stock changed while preparing the preview. Preview again.",
	};
	throw new StockAdjustmentPreviewError(code, messages[code]);
}

function quantities(balance: BalanceRecord) {
	return {
		onHand: balance.onHand,
		reserved: balance.reserved,
		available: balance.available,
		version: balance.version,
	};
}

function incrementVersion(version: string): string {
	return (BigInt(version) + 1n).toString();
}

function conflict(commandId: string): StockAdjustmentResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	};
}

export function createPreviewStockAdjustment(
	dependencies: PreviewStockAdjustmentDependencies,
): PreviewStockAdjustment {
	requireDependencies(dependencies);
	if (typeof dependencies.createConfirmation !== "function") {
		throw new TypeError("createConfirmation is required.");
	}

	return async (input, execution) => {
		const normalized = normalizePreviewStockAdjustmentInput(input);
		const principal = normalizeCommandPrincipal(execution?.principal);
		const key = {
			poolId: normalized.context.poolId,
			locationId: normalized.context.locationId,
			skuId: normalized.payload.skuId,
		};
		const observed = await dependencies.store.runTransaction(
			normalized.context.poolId,
			(transaction) => {
				const location = transaction.getLocation(normalized.context.locationId);
				if (location === null) previewError("location_not_found");
				if (location.status !== "active") previewError("location_not_active");
				const managedSku = transaction.getManagedSku(normalized.payload.skuId);
				if (managedSku === null) previewError("sku_not_registered");
				if (managedSku.unit !== normalized.payload.delta.unit) {
					previewError("sku_unit_mismatch");
				}
				const balance = transaction.getBalance(key);
				if (balance === null || !balance.hasStockHistory) {
					previewError("opening_balance_required");
				}
				if (
					balance.onHand.unit !== normalized.payload.delta.unit ||
					balance.reserved.unit !== normalized.payload.delta.unit ||
					balance.available.unit !== normalized.payload.delta.unit
				) {
					previewError("sku_unit_mismatch");
				}
				return balance;
			},
		);
		const action: StockAdjustmentActionV1 = {
			...normalized,
			expectedVersion: observed.version,
		};
		const confirmation = confirmationFrom(dependencies.createConfirmation);
		const [confirmationDigest, actionDigest, principalDigest] =
			await Promise.all([
				digestOpaqueConfirmation(confirmation),
				digestStockAdjustmentAction(action),
				digestCommandPrincipal(principal),
			]);

		return dependencies.store.runTransaction(
			normalized.context.poolId,
			(transaction) => {
				const location = transaction.getLocation(normalized.context.locationId);
				if (location === null) previewError("location_not_found");
				if (location.status !== "active") previewError("location_not_active");
				const managedSku = transaction.getManagedSku(normalized.payload.skuId);
				if (managedSku === null) previewError("sku_not_registered");
				if (managedSku.unit !== normalized.payload.delta.unit) {
					previewError("sku_unit_mismatch");
				}
				const before = transaction.getBalance(key);
				if (before === null || !before.hasStockHistory) {
					previewError("opening_balance_required");
				}
				if (before.version !== observed.version) previewError("stale_version");
				if (
					before.onHand.unit !== normalized.payload.delta.unit ||
					before.reserved.unit !== normalized.payload.delta.unit ||
					before.available.unit !== normalized.payload.delta.unit
				) {
					previewError("sku_unit_mismatch");
				}

				const unit = normalized.payload.delta.unit;
				const nextOnHand = addExactDecimal(
					before.onHand.value,
					normalized.payload.delta.value,
				);
				const nextAvailable = subtractExactDecimal(
					nextOnHand,
					before.reserved.value,
				);
				const after: BalanceRecord = {
					...key,
					onHand: { value: nextOnHand, unit },
					reserved: before.reserved,
					available: { value: nextAvailable, unit },
					version: incrementVersion(before.version),
					hasStockHistory: true,
				};
				const issued = dateFrom(dependencies.now);
				const expires = new Date(
					issued.getTime() + STOCK_ADJUSTMENT_CONFIRMATION_TTL_MS,
				);
				transaction.storeStockAdjustmentConfirmation({
					confirmationDigest,
					poolId: normalized.context.poolId,
					actionDigest,
					principalDigest,
					issuedAt: issued.toISOString(),
					expiresAt: expires.toISOString(),
					commandId: null,
				});
				const zero: ExactQuantity = { value: "0", unit };
				const warnings = nextAvailable.startsWith("-")
					? [
							{
								code: "negative_available" as const,
								reserved: before.reserved,
								oversoldBy: {
									value: nextAvailable.slice(1),
									unit,
								},
								message: `${before.reserved.value} units are reserved for orders. This adjustment will oversell stock by ${nextAvailable.slice(1)} units.`,
							},
						]
					: [];
				return {
					schema: STOCK_ADJUSTMENT_PREVIEW_SCHEMA,
					type: STOCK_ADJUSTMENT_TYPE,
					context: normalized.context,
					effect: {
						skuId: normalized.payload.skuId,
						locationId: normalized.context.locationId,
						onHandDelta: normalized.payload.delta,
						reservedDelta: zero,
						balanceBefore: quantities(before),
						balanceAfter: quantities(after),
					},
					reason: normalized.reason,
					references: normalized.references,
					warnings,
					confirmation: {
						value: confirmation,
						expiresAt: expires.toISOString(),
					},
				};
			},
		);
	};
}

export function createConfirmStockAdjustment(
	dependencies: ConfirmStockAdjustmentDependencies,
): ConfirmStockAdjustment {
	requireDependencies(dependencies);
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}

	return async (confirmationValue, commandInput, execution) => {
		const confirmation = confirmationInput(confirmationValue);
		const command = normalizeAdjustStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(execution?.principal);
		const action = stockAdjustmentActionFromCommand(command);
		const [confirmationDigest, actionDigest, principalDigest, commandDigest] =
			await Promise.all([
				digestOpaqueConfirmation(confirmation),
				digestStockAdjustmentAction(action),
				digestCommandPrincipal(principal),
				digestAdjustStockCommand(command),
			]);

		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) => {
				const stored = transaction.getStockAdjustmentConfirmation(
					confirmationDigest,
				);
				if (stored === null) {
					throw new StockAdjustmentConfirmationError(
						"confirmation_not_found",
						"The stock-adjustment confirmation was not found.",
					);
				}
				if (
					stored.poolId !== command.context.poolId ||
					stored.principalDigest !== principalDigest
				) {
					throw new StockAdjustmentConfirmationError(
						"confirmation_mismatch",
						"The confirmation does not match this action and principal.",
					);
				}
				if (stored.commandId !== null) {
					if (stored.commandId !== command.commandId) {
						throw new StockAdjustmentConfirmationError(
							"confirmation_already_used",
							"The confirmation is already bound to another command ID.",
						);
					}
					const existing = transaction.getCommand<StockAdjustmentResult>(
						command.commandId,
					);
					if (existing === null) {
						throw new Error("Confirmed stock-adjustment result is missing.");
					}
					return existing.commandDigest === commandDigest
						? existing.result
						: conflict(command.commandId);
				}
				if (stored.actionDigest !== actionDigest) {
					throw new StockAdjustmentConfirmationError(
						"confirmation_mismatch",
						"The confirmation does not match this action and principal.",
					);
				}
				if (dateFrom(dependencies.now).getTime() >= timestampFrom(stored.expiresAt)) {
					throw new StockAdjustmentConfirmationError(
						"confirmation_expired",
						"The stock-adjustment confirmation has expired.",
					);
				}
				const existing = transaction.getCommand<StockAdjustmentResult>(
					command.commandId,
				);
				if (existing !== null) {
					if (existing.commandDigest !== commandDigest) return conflict(command.commandId);
					throw new StockAdjustmentConfirmationError(
						"confirmation_already_used",
						"The command ID already has a result not linked to this confirmation.",
					);
				}

				const result = executeAdjustStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				);
				transaction.bindStockAdjustmentConfirmation(
					confirmationDigest,
					command.commandId,
				);
				return result;
			},
		);
	};
}
