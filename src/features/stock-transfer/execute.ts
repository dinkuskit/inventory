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
	StockTransferCommit,
} from "../../storage/inventory-store.ts";
import {
	CANCEL_STOCK_TRANSFER_TYPE,
	CREATE_STOCK_TRANSFER_TYPE,
	DISPATCH_STOCK_TRANSFER_TYPE,
	RECEIVE_STOCK_TRANSFER_TYPE,
	REOPEN_STOCK_TRANSFER_TYPE,
	STOCK_TRANSFER_RECORD_SCHEMA,
	UPDATE_STOCK_TRANSFER_TYPE,
	digestStockTransferCommand,
	normalizeStockTransferCommand,
	normalizeStockTransferReference,
	type CreatedStockTransferFields,
	type StockTransferBalanceEffect,
	type StockTransferBalanceSnapshot,
	type StockTransferCommandV1,
	type StockTransferReceiptV2,
	type StockTransferRecord,
	type StockTransferRejectionCode,
	type StockTransferResult,
	type StockTransferWarning,
} from "./domain.ts";

export type ExecuteStockTransferCommandExecution = Readonly<{
	principal: CommandPrincipal;
}>;

export type ExecuteStockTransferCommand = (
	command: StockTransferCommandV1,
	execution: ExecuteStockTransferCommandExecution,
) => Promise<StockTransferResult>;

export type ExecuteStockTransferCommandDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createTransferId: () => string;
	createTransferReference: () => string;
	createReceiptId: () => string;
}>;

type TransferStateQuantity = Readonly<{
	poolId: string;
	locationId: string;
	skuId: string;
	unit: string;
	onHand: string;
	outgoing: string;
	expected: string;
	inTransit: string;
}>;

function rejection(
	commandId: string,
	code: StockTransferRejectionCode,
	message: string,
): StockTransferResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code,
		message,
	};
}

function durableRejection(
	transaction: InventoryTransaction,
	command: StockTransferCommandV1,
	commandDigest: string,
	code: StockTransferRejectionCode,
	message: string,
): StockTransferResult {
	const result = rejection(command.commandId, code, message);
	transaction.storeRejection({
		commandId: command.commandId,
		commandDigest,
		result,
	});
	return result;
}

function idFrom(factory: () => string, field: string): string {
	const value = factory();
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${field} must return a non-empty string.`);
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

function incrementVersion(version: string): string {
	return (BigInt(version) + 1n).toString();
}

function isZero(value: string): boolean {
	return value === "0";
}

function negate(value: string): string {
	return value.startsWith("-") ? value.slice(1) : isZero(value) ? "0" : `-${value}`;
}

function planningKey(locationId: string, skuId: string): string {
	return `${locationId}\u0000${skuId}`;
}

function stateQuantitiesFor(
	poolId: string,
	transfer: StockTransferRecord | null,
): Map<string, TransferStateQuantity> {
	const values = new Map<string, TransferStateQuantity>();
	if (
		transfer === null ||
		!["created", "in_transit", "received"].includes(transfer.status)
	) {
		return values;
	}
	for (const line of transfer.lines) {
		values.set(planningKey(transfer.originLocationId, line.skuId), {
			poolId,
			locationId: transfer.originLocationId,
			skuId: line.skuId,
			unit: line.quantity.unit,
			onHand:
				transfer.status === "in_transit" || transfer.status === "received"
					? negate(line.quantity.value)
					: "0",
			outgoing: transfer.status === "created" ? line.quantity.value : "0",
			expected: "0",
			inTransit: "0",
		});
		values.set(planningKey(transfer.destinationLocationId, line.skuId), {
			poolId,
			locationId: transfer.destinationLocationId,
			skuId: line.skuId,
			unit: line.quantity.unit,
			onHand: transfer.status === "received" ? line.quantity.value : "0",
			outgoing: "0",
			expected: transfer.status === "created" ? line.quantity.value : "0",
			inTransit: transfer.status === "in_transit" ? line.quantity.value : "0",
		});
	}
	return values;
}

function zeroQuantity(unit: string): ExactQuantity {
	return { value: "0", unit };
}

function snapshot(balance: BalanceRecord): StockTransferBalanceSnapshot {
	return {
		onHand: balance.onHand,
		reserved: balance.reserved,
		outgoingTransferCommitted: balance.outgoingTransferCommitted,
		available: balance.available,
		expected: balance.expected,
		inTransit: balance.inTransit,
		version: balance.version,
	};
}

function baseBalance(value: TransferStateQuantity): BalanceRecord {
	const zero = zeroQuantity(value.unit);
	return {
		poolId: value.poolId,
		locationId: value.locationId,
		skuId: value.skuId,
		onHand: zero,
		reserved: zero,
		outgoingTransferCommitted: zero,
		available: zero,
		expected: zero,
		inTransit: zero,
		version: "0",
		hasStockHistory: false,
	};
}

function assertStoredUnits(balance: BalanceRecord, unit: string): boolean {
	return [
		balance.onHand,
		balance.reserved,
		balance.outgoingTransferCommitted,
		balance.available,
		balance.expected,
		balance.inTransit,
	].every((quantity) => quantity.unit === unit);
}

function transferBalanceChanges(
	transaction: InventoryTransaction,
	poolId: string,
	before: StockTransferRecord | null,
	after: StockTransferRecord,
): Readonly<{
	commits: StockTransferCommit["balances"];
	effects: readonly StockTransferBalanceEffect[];
	warnings: readonly StockTransferWarning[];
}> {
	const prior = stateQuantitiesFor(poolId, before);
	const next = stateQuantitiesFor(poolId, after);
	const keys = new Set([...prior.keys(), ...next.keys()]);
	const commits: Array<StockTransferCommit["balances"][number]> = [];
	const effects: StockTransferBalanceEffect[] = [];

	for (const key of [...keys].sort()) {
		const oldValue = prior.get(key);
		const newValue = next.get(key);
		const value = newValue ?? oldValue;
		if (value === undefined) throw new Error("A transfer balance key lost its value.");
		const onHandDelta = addExactDecimal(
			newValue?.onHand ?? "0",
			negate(oldValue?.onHand ?? "0"),
		);
		const outgoingDelta = addExactDecimal(
			newValue?.outgoing ?? "0",
			negate(oldValue?.outgoing ?? "0"),
		);
		const expectedDelta = addExactDecimal(
			newValue?.expected ?? "0",
			negate(oldValue?.expected ?? "0"),
		);
		const inTransitDelta = addExactDecimal(
			newValue?.inTransit ?? "0",
			negate(oldValue?.inTransit ?? "0"),
		);
		if (
			isZero(onHandDelta) &&
			isZero(outgoingDelta) &&
			isZero(expectedDelta) &&
			isZero(inTransitDelta)
		) continue;

		const stored = transaction.getBalance(value);
		const current = stored ?? baseBalance(value);
		if (!assertStoredUnits(current, value.unit)) {
			throw new Error("Stored transfer balance units are inconsistent.");
		}
		const onHand = addExactDecimal(current.onHand.value, onHandDelta);
		const outgoing = addExactDecimal(
			current.outgoingTransferCommitted.value,
			outgoingDelta,
		);
		const expected = addExactDecimal(current.expected.value, expectedDelta);
		const inTransit = addExactDecimal(
			current.inTransit.value,
			inTransitDelta,
		);
		if (
			outgoing.startsWith("-") ||
			expected.startsWith("-") ||
			inTransit.startsWith("-")
		) {
			throw new Error("Transfer state quantities cannot become negative.");
		}
		const available = subtractExactDecimal(
			subtractExactDecimal(onHand, current.reserved.value),
			outgoing,
		);
		const updated: BalanceRecord = {
			...current,
			onHand: { value: onHand, unit: value.unit },
			outgoingTransferCommitted: { value: outgoing, unit: value.unit },
			available: { value: available, unit: value.unit },
			expected: { value: expected, unit: value.unit },
			inTransit: { value: inTransit, unit: value.unit },
			version: incrementVersion(current.version),
			hasStockHistory:
				current.hasStockHistory ||
				(
					after.status === "received" &&
					value.locationId === after.destinationLocationId &&
					!isZero(onHandDelta)
				),
		};
		commits.push({ previous: stored, balance: updated });
		effects.push({
			skuId: value.skuId,
			locationId: value.locationId,
			onHandDelta: { value: onHandDelta, unit: value.unit },
			reservedDelta: zeroQuantity(value.unit),
			outgoingTransferCommittedDelta: {
				value: outgoingDelta,
				unit: value.unit,
			},
			expectedDelta: { value: expectedDelta, unit: value.unit },
			inTransitDelta: { value: inTransitDelta, unit: value.unit },
			balanceBefore: stored === null ? null : snapshot(stored),
			balanceAfter: snapshot(updated),
		});
	}

	const committedBalances = new Map(
		commits.map(({ balance }) => [
			planningKey(balance.locationId, balance.skuId),
			balance,
		]),
	);
	const warnings =
		["created", "in_transit"].includes(after.status)
			? after.lines.flatMap((line): readonly StockTransferWarning[] => {
					const balance =
						committedBalances.get(
							planningKey(after.originLocationId, line.skuId),
						) ??
						transaction.getBalance({
							poolId,
							locationId: after.originLocationId,
							skuId: line.skuId,
						});
					if (balance === null || !balance.available.value.startsWith("-")) {
						return [];
					}
					const oversoldBy = balance.available.value.slice(1);
					const unit = balance.available.unit;
					const reserved = balance.reserved;
					const outgoing =
						after.status === "in_transit" && before?.status === "created"
							? transaction.getBalance({
									poolId,
									locationId: after.originLocationId,
									skuId: line.skuId,
								})?.outgoingTransferCommitted ?? balance.outgoingTransferCommitted
							: balance.outgoingTransferCommitted;
					return [
						{
							code: "negative_available",
							skuId: line.skuId,
							locationId: after.originLocationId,
							reservedForOrders: reserved,
							outgoingTransferCommitted: outgoing,
							oversoldBy: { value: oversoldBy, unit },
							message: `This transfer will leave you with -${oversoldBy} stock. ${reserved.value} are reserved for orders.`,
						},
					];
				})
			: [];
	return { commits, effects, warnings };
}

function validateLocations(
	transaction: InventoryTransaction,
	command: StockTransferCommandV1,
	commandDigest: string,
	fields: CreatedStockTransferFields,
): StockTransferResult | null {
	for (const locationId of [
		fields.originLocationId,
		fields.destinationLocationId,
	]) {
		const location = transaction.getLocation(locationId);
		if (location === null) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				"location_not_found",
				"A transfer location does not exist in this inventory pool.",
			);
		}
		if (location.status !== "active") {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				"location_not_active",
				"A transfer location is archived and cannot be used.",
			);
		}
	}
	return null;
}

function validateLines(
	transaction: InventoryTransaction,
	command: StockTransferCommandV1,
	commandDigest: string,
	fields: CreatedStockTransferFields,
): StockTransferResult | null {
	for (const line of fields.lines) {
		const sku = transaction.getManagedSku(line.skuId);
		if (sku === null) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				"sku_not_registered",
				"A transfer SKU is not set up for inventory.",
			);
		}
		if (sku.unit !== line.quantity.unit) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				"sku_unit_mismatch",
				"A transfer quantity unit does not match its SKU.",
			);
		}
		if (!isZero(line.quantity.value)) {
			const origin = transaction.getBalance({
				poolId: command.context.poolId,
				locationId: fields.originLocationId,
				skuId: line.skuId,
			});
			if (origin === null || !origin.hasStockHistory) {
				return durableRejection(
					transaction,
					command,
					commandDigest,
					"opening_balance_required",
					"Set Initial Stock at the origin before committing a positive transfer quantity.",
				);
			}
			if (!assertStoredUnits(origin, line.quantity.unit)) {
				return durableRejection(
					transaction,
					command,
					commandDigest,
					"sku_unit_mismatch",
					"A transfer quantity unit does not match stored stock.",
				);
			}
		}
	}
	return null;
}

function referenceConflict(
	transaction: InventoryTransaction,
	referenceKey: string,
	transferId: string | null,
): boolean {
	const existing = transaction.getStockTransferByReferenceKey(referenceKey);
	return existing !== null && existing.transferId !== transferId;
}

export function executeStockTransferCommandInTransaction(
	transaction: InventoryTransaction,
	command: StockTransferCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Omit<ExecuteStockTransferCommandDependencies, "store">,
): StockTransferResult {
	const existingCommand = transaction.getCommand<StockTransferResult>(
		command.commandId,
	);
	if (existingCommand !== null) {
		return existingCommand.commandDigest === commandDigest
			? existingCommand.result
			: rejection(
					command.commandId,
					"command_id_conflict",
					"The command ID is already bound to different contents.",
				);
	}

	let before: StockTransferRecord | null = null;
	let reference: Readonly<{ reference: string; referenceKey: string }>;
	let fields: CreatedStockTransferFields;
	if (command.type === CREATE_STOCK_TRANSFER_TYPE) {
		fields = command.payload;
		reference = normalizeStockTransferReference(
			fields.reference ??
				idFrom(dependencies.createTransferReference, "createTransferReference"),
		);
	} else {
		before = transaction.getStockTransfer(command.payload.transferId);
		if (before === null) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				"transfer_not_found",
				"The transfer does not exist in this inventory pool.",
			);
		}
		const requiresInTransit =
			command.type === REOPEN_STOCK_TRANSFER_TYPE ||
			command.type === RECEIVE_STOCK_TRANSFER_TYPE;
		const requiredStatus = requiresInTransit ? "in_transit" : "created";
		if (before.status !== requiredStatus) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				requiresInTransit
					? "transfer_not_in_transit"
					: "transfer_not_created",
				command.type === REOPEN_STOCK_TRANSFER_TYPE
					? "Only an In-transit transfer can be returned to Created."
					: command.type === RECEIVE_STOCK_TRANSFER_TYPE
						? "Only an In-transit transfer can be received."
					: command.type === DISPATCH_STOCK_TRANSFER_TYPE
						? "Only a Created transfer can be marked In transit."
						: "Only a Created transfer can be edited or canceled.",
			);
		}
		if (before.version !== command.expectedVersions[0].version) {
			return durableRejection(
				transaction,
				command,
				commandDigest,
				"stale_version",
				"The transfer changed after it was read. Refresh and try again.",
			);
		}
		fields =
			command.type === UPDATE_STOCK_TRANSFER_TYPE ? command.payload : before;
		reference = normalizeStockTransferReference(
			command.type === UPDATE_STOCK_TRANSFER_TYPE
				? command.payload.reference
				: before.reference,
		);
	}

	if (
		referenceConflict(
			transaction,
			reference.referenceKey,
			before?.transferId ?? null,
		)
	) {
		return durableRejection(
			transaction,
			command,
			commandDigest,
			"transfer_reference_conflict",
			"Another transfer already uses this reference.",
		);
	}

	if (
		command.type !== CANCEL_STOCK_TRANSFER_TYPE &&
		command.type !== RECEIVE_STOCK_TRANSFER_TYPE
	) {
		const locationFailure = validateLocations(
			transaction,
			command,
			commandDigest,
			fields,
		);
		if (locationFailure !== null) return locationFailure;
		const lineFailure = validateLines(
			transaction,
			command,
			commandDigest,
			fields,
		);
		if (lineFailure !== null) return lineFailure;
	}
	if (
		command.type === DISPATCH_STOCK_TRANSFER_TYPE &&
		fields.lines.some((line) => isZero(line.quantity.value))
	) {
		return durableRejection(
			transaction,
			command,
			commandDigest,
			"positive_transfer_quantity_required",
			"Every transfer line must have a positive quantity before it can be marked In transit.",
		);
	}

	const committedAt = committedAtFrom(dependencies.now);
	let after: StockTransferRecord;
	if (command.type === CREATE_STOCK_TRANSFER_TYPE) {
		const transferId = idFrom(dependencies.createTransferId, "createTransferId");
		if (transaction.getStockTransfer(transferId) !== null) {
			throw new Error("createTransferId returned an existing transfer ID.");
		}
		after = {
			schema: STOCK_TRANSFER_RECORD_SCHEMA,
			poolId: command.context.poolId,
			transferId,
			reference: reference.reference,
			status: "created",
			originLocationId: fields.originLocationId,
			destinationLocationId: fields.destinationLocationId,
			lines: fields.lines,
			note: fields.note,
			createdAt: committedAt,
			createdBy: principal,
			updatedAt: committedAt,
			version: "1",
			expectedDispatchDate: fields.expectedDispatchDate,
			expectedArrivalDate: fields.expectedArrivalDate,
			dispatchedDate: null,
			receivedDate: null,
			canceledAt: null,
		};
	} else if (command.type === UPDATE_STOCK_TRANSFER_TYPE) {
		after = {
			...before!,
			reference: reference.reference,
			originLocationId: fields.originLocationId,
			destinationLocationId: fields.destinationLocationId,
			lines: fields.lines,
			note: fields.note,
			expectedDispatchDate: fields.expectedDispatchDate,
			expectedArrivalDate: fields.expectedArrivalDate,
			updatedAt: committedAt,
			version: incrementVersion(before!.version),
		};
	} else if (command.type === CANCEL_STOCK_TRANSFER_TYPE) {
		after = {
			...before!,
			status: "canceled",
			updatedAt: committedAt,
			version: incrementVersion(before!.version),
			canceledAt: committedAt,
		};
	} else if (command.type === DISPATCH_STOCK_TRANSFER_TYPE) {
		after = {
			...before!,
			status: "in_transit",
			updatedAt: committedAt,
			version: incrementVersion(before!.version),
			dispatchedDate: committedAt,
		};
	} else if (command.type === RECEIVE_STOCK_TRANSFER_TYPE) {
		after = {
			...before!,
			status: "received",
			updatedAt: committedAt,
			version: incrementVersion(before!.version),
			receivedDate: committedAt,
		};
	} else {
		after = {
			...before!,
			status: "created",
			updatedAt: committedAt,
			version: incrementVersion(before!.version),
			dispatchedDate: null,
		};
	}

	const planning = transferBalanceChanges(
		transaction,
		command.context.poolId,
		before,
		after,
	);
	const receipt: StockTransferReceiptV2 = {
		schema: RECEIPT_SCHEMA,
		receiptId: idFrom(dependencies.createReceiptId, "createReceiptId"),
		commandId: command.commandId,
		commandDigest,
		status: "committed",
		type: command.type,
		committedAt,
		principal,
		context: command.context,
		transfer: { before, after },
		effects: planning.effects,
		...(command.type === REOPEN_STOCK_TRANSFER_TYPE
			? { reason: command.payload.reason }
			: {}),
		references: command.references,
	};
	const result: StockTransferResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "committed",
		commandId: command.commandId,
		transfer: after,
		receipt,
		warnings: planning.warnings,
	};
	transaction.commitStockTransfer({
		commandId: command.commandId,
		commandDigest,
		previous: before,
		transfer: after,
		referenceKey: reference.referenceKey,
		balances: planning.commits,
		receipt,
		result,
	});
	return result;
}

export function createExecuteStockTransferCommand(
	dependencies: ExecuteStockTransferCommandDependencies,
): ExecuteStockTransferCommand {
	if (dependencies?.store === undefined) throw new TypeError("store is required.");
	for (const name of [
		"now",
		"createTransferId",
		"createTransferReference",
		"createReceiptId",
	] as const) {
		if (typeof dependencies[name] !== "function") {
			throw new TypeError(`${name} is required.`);
		}
	}
	return async (commandInput, executionInput) => {
		const command = normalizeStockTransferCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestStockTransferCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executeStockTransferCommandInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}
