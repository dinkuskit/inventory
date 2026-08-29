import {
	COMMAND_RESULT_SCHEMA,
	OPENING_BALANCE_PREVIEW_SCHEMA,
	OPENING_BALANCE_TYPE,
	digestCommand,
	digestCommandPrincipal,
	digestOpaqueConfirmation,
	digestOpeningBalanceAction,
	normalizeCommandPrincipal,
	normalizePreviewOpeningBalanceInput,
	normalizeSetOpeningBalanceCommand,
	openingBalanceActionFromCommand,
	type CommandPrincipal,
	type OpeningBalancePreviewV1,
	type OpeningBalanceResult,
	type PreviewOpeningBalanceInputV1,
	type SetOpeningBalanceCommandV1,
} from "../domain/opening-balance.ts";
import type { InventoryStore } from "../storage/inventory-store.ts";
import { executeSetOpeningBalanceInTransaction } from "./set-opening-balance.ts";

export const OPENING_BALANCE_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;

export type OpeningBalanceConfirmationErrorCode =
	| "confirmation_not_found"
	| "confirmation_expired"
	| "confirmation_mismatch"
	| "confirmation_already_used";

export class OpeningBalanceConfirmationError extends Error {
	readonly code: OpeningBalanceConfirmationErrorCode;

	constructor(code: OpeningBalanceConfirmationErrorCode, message: string) {
		super(message);
		this.name = "OpeningBalanceConfirmationError";
		this.code = code;
	}
}

export type OpeningBalancePreviewErrorCode =
	| "opening_balance_already_set"
	| "sku_not_registered"
	| "sku_unit_mismatch";

export class OpeningBalancePreviewError extends Error {
	readonly code: OpeningBalancePreviewErrorCode;

	constructor(code: OpeningBalancePreviewErrorCode = "opening_balance_already_set") {
		super(
			code === "sku_not_registered"
				? "This SKU is not set up for inventory."
				: code === "sku_unit_mismatch"
					? "The stock quantity unit does not match this SKU."
					: "This SKU-location already has committed stock history.",
		);
		this.name = "OpeningBalancePreviewError";
		this.code = code;
	}
}

export type PreviewOpeningBalanceExecution = Readonly<{
	principal: CommandPrincipal;
}>;

export type PreviewOpeningBalance = (
	input: PreviewOpeningBalanceInputV1,
	execution: PreviewOpeningBalanceExecution,
) => Promise<OpeningBalancePreviewV1>;

export type PreviewOpeningBalanceDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createConfirmation: () => string;
}>;

export type ConfirmOpeningBalanceExecution = Readonly<{
	principal: CommandPrincipal;
}>;

export type ConfirmOpeningBalance = (
	confirmation: string,
	command: SetOpeningBalanceCommandV1,
	execution: ConfirmOpeningBalanceExecution,
) => Promise<OpeningBalanceResult>;

export type ConfirmOpeningBalanceDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReceiptId: () => string;
}>;

function requireDependencies(
	dependencies: Readonly<{
		store: InventoryStore;
		now: () => Date;
	}>,
): void {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	if (typeof dependencies.now !== "function") {
		throw new TypeError("now is required.");
	}
}

function dateFrom(now: () => Date): Date {
	const current = now();
	if (!(current instanceof Date) || Number.isNaN(current.getTime())) {
		throw new TypeError("now must return a valid Date.");
	}
	return current;
}

function timestampFrom(value: string): number {
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		throw new Error("Stored opening-balance confirmation expiry is invalid.");
	}
	return timestamp;
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
		throw new OpeningBalanceConfirmationError(
			"confirmation_not_found",
			"The opening-balance confirmation was not found.",
		);
	}
	return value.trim();
}

function principalMatches(
	storedDigest: string,
	providedDigest: string,
): boolean {
	return storedDigest === providedDigest;
}

function commandIdConflict(commandId: string): OpeningBalanceResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	};
}

export function createPreviewOpeningBalance(
	dependencies: PreviewOpeningBalanceDependencies,
): PreviewOpeningBalance {
	requireDependencies(dependencies);
	if (typeof dependencies.createConfirmation !== "function") {
		throw new TypeError("createConfirmation is required.");
	}

	return async function previewOpeningBalance(
		input: PreviewOpeningBalanceInputV1,
		execution: PreviewOpeningBalanceExecution,
	): Promise<OpeningBalancePreviewV1> {
		const action = normalizePreviewOpeningBalanceInput(input);
		const principal = normalizeCommandPrincipal(execution?.principal);
		const confirmation = confirmationFrom(dependencies.createConfirmation);
		const [confirmationDigest, actionDigest, principalDigest] =
			await Promise.all([
				digestOpaqueConfirmation(confirmation),
				digestOpeningBalanceAction(action),
				digestCommandPrincipal(principal),
			]);
		const zero = { value: "0", unit: action.payload.quantity.unit };

		return dependencies.store.runTransaction(
			action.context.poolId,
			(transaction) => {
				const issued = dateFrom(dependencies.now);
				const expires = new Date(
					issued.getTime() + OPENING_BALANCE_CONFIRMATION_TTL_MS,
				);
				const key = {
					poolId: action.context.poolId,
					locationId: action.context.locationId,
					skuId: action.payload.skuId,
				};
				const managedSku = transaction.getManagedSku(action.payload.skuId);
				if (managedSku === null) {
					throw new OpeningBalancePreviewError("sku_not_registered");
				}
				if (managedSku.unit !== action.payload.quantity.unit) {
					throw new OpeningBalancePreviewError("sku_unit_mismatch");
				}
				const balance = transaction.getBalance(key);
				if (
					balance !== null &&
					(balance.hasStockHistory || balance.version !== "0")
				) {
					throw new OpeningBalancePreviewError();
				}

				transaction.storeOpeningBalanceConfirmation({
					confirmationDigest,
					poolId: action.context.poolId,
					actionDigest,
					principalDigest,
					issuedAt: issued.toISOString(),
					expiresAt: expires.toISOString(),
					commandId: null,
				});

				return {
					schema: OPENING_BALANCE_PREVIEW_SCHEMA,
					type: OPENING_BALANCE_TYPE,
					context: action.context,
					effect: {
						skuId: action.payload.skuId,
						locationId: action.context.locationId,
						onHandDelta: action.payload.quantity,
						reservedDelta: zero,
						balanceBefore: {
							onHand: zero,
							reserved: zero,
							available: zero,
							version: "0",
						},
						balanceAfter: {
							onHand: action.payload.quantity,
							reserved: zero,
							available: action.payload.quantity,
							version: "1",
						},
					},
					reason: action.reason,
					references: action.references,
					warning:
						"This opening balance permanently starts stock history for this SKU-location.",
					confirmation: {
						value: confirmation,
						expiresAt: expires.toISOString(),
					},
				};
			},
		);
	};
}

export function createConfirmOpeningBalance(
	dependencies: ConfirmOpeningBalanceDependencies,
): ConfirmOpeningBalance {
	requireDependencies(dependencies);
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}

	return async function confirmOpeningBalance(
		confirmationValue: string,
		commandInput: SetOpeningBalanceCommandV1,
		execution: ConfirmOpeningBalanceExecution,
	): Promise<OpeningBalanceResult> {
		const confirmation = confirmationInput(confirmationValue);
		const command = normalizeSetOpeningBalanceCommand(commandInput);
		const principal = normalizeCommandPrincipal(execution?.principal);
		const action = openingBalanceActionFromCommand(command);
		const [confirmationDigest, actionDigest, principalDigest, commandDigest] =
			await Promise.all([
				digestOpaqueConfirmation(confirmation),
				digestOpeningBalanceAction(action),
				digestCommandPrincipal(principal),
				digestCommand(command),
			]);

		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) => {
				const stored = transaction.getOpeningBalanceConfirmation(
					confirmationDigest,
				);
				if (stored === null) {
					throw new OpeningBalanceConfirmationError(
						"confirmation_not_found",
						"The opening-balance confirmation was not found.",
					);
				}
				if (
					stored.poolId !== command.context.poolId ||
					stored.actionDigest !== actionDigest ||
					!principalMatches(stored.principalDigest, principalDigest)
				) {
					throw new OpeningBalanceConfirmationError(
						"confirmation_mismatch",
						"The confirmation does not match this action and principal.",
					);
				}

				if (stored.commandId !== null) {
					if (stored.commandId !== command.commandId) {
						throw new OpeningBalanceConfirmationError(
							"confirmation_already_used",
							"The confirmation is already bound to another command ID.",
						);
					}
					const existing = transaction.getCommand<OpeningBalanceResult>(
						command.commandId,
					);
					if (existing === null) {
						throw new Error(
							"Confirmed opening-balance command result is missing.",
						);
					}
					return existing.commandDigest === commandDigest
						? existing.result
						: commandIdConflict(command.commandId);
				}

				if (
					dateFrom(dependencies.now).getTime() >=
					timestampFrom(stored.expiresAt)
				) {
					throw new OpeningBalanceConfirmationError(
						"confirmation_expired",
						"The opening-balance confirmation has expired.",
					);
				}

				const existing = transaction.getCommand<OpeningBalanceResult>(
					command.commandId,
				);
				if (existing !== null) {
					if (existing.commandDigest !== commandDigest) {
						return commandIdConflict(command.commandId);
					}
					throw new OpeningBalanceConfirmationError(
						"confirmation_already_used",
						"The command ID already has a result not linked to this confirmation.",
					);
				}

				const result = executeSetOpeningBalanceInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				);
				transaction.bindOpeningBalanceConfirmation(
					confirmationDigest,
					command.commandId,
				);
				return result;
			},
		);
	};
}
