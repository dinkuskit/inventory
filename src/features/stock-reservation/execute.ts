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
	compareExactDecimal,
	subtractExactDecimal,
} from "../../domain/exact-decimal.ts";
import type {
	InventoryStore,
	InventoryTransaction,
} from "../../storage/inventory-store.ts";
import {
	PACK_ALL_STOCK_TYPE,
	PACK_SOME_STOCK_TYPE,
	PACK_STOCK_TYPE,
	RELEASE_STOCK_TYPE,
	RESERVE_STOCK_TYPE,
	RESERVATION_RECORD_SCHEMA,
	digestStockReservationCommand,
	holdIsOpen,
	normalizePackAllStockCommand,
	normalizePackSomeStockCommand,
	normalizePackStockCommand,
	normalizeReleaseStockCommand,
	normalizeReserveStockCommand,
	reservationOrderLineKey,
	sameReservationContents,
	type PackAllStockCommandV1,
	type PackSomeStockCommandV1,
	type PackStockCommandV1,
	type ReleaseStockCommandV1,
	type ReservationRecord,
	type ReserveStockCommandV1,
	type StockReservationBalanceEffect,
	type StockReservationReceiptV2,
	type StockReservationRejectionCode,
	type StockReservationResult,
} from "./domain.ts";

export type ReserveStockExecution = Readonly<{ principal: CommandPrincipal }>;
export type ReleaseStockExecution = ReserveStockExecution;
export type PackStockExecution = ReserveStockExecution;

export type ReserveStock = (
	command: ReserveStockCommandV1,
	execution: ReserveStockExecution,
) => Promise<StockReservationResult>;
export type ReleaseStock = (
	command: ReleaseStockCommandV1,
	execution: ReleaseStockExecution,
) => Promise<StockReservationResult>;
export type PackStock = (
	command: PackStockCommandV1,
	execution: PackStockExecution,
) => Promise<StockReservationResult>;
export type PackAllStockExecution = PackStockExecution;
export type PackAllStock = (
	command: PackAllStockCommandV1,
	execution: PackAllStockExecution,
) => Promise<StockReservationResult>;
export type PackSomeStockExecution = PackStockExecution;
export type PackSomeStock = (
	command: PackSomeStockCommandV1,
	execution: PackSomeStockExecution,
) => Promise<StockReservationResult>;

export type StockReservationDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReservationId: () => string;
	createReceiptId: () => string;
}>;

export type ReleaseStockDependencies = Readonly<{
	store: InventoryStore;
	now: () => Date;
	createReceiptId: () => string;
}>;
export type PackStockDependencies = ReleaseStockDependencies;
export type PackAllStockDependencies = PackStockDependencies;
export type PackSomeStockDependencies = PackStockDependencies;

function incrementVersion(version: string): string {
	return (BigInt(version) + 1n).toString();
}

function rejection(
	commandId: string,
	code: StockReservationRejectionCode,
	message: string,
): StockReservationResult {
	return {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "rejected",
		commandId,
		code,
		message,
	};
}

function idFrom(createId: () => string, label: string): string {
	const value = createId();
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must return a non-empty string.`);
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

function quantities(balance: BalanceRecord): StockReservationBalanceEffect["balanceBefore"] {
	return {
		onHand: balance.onHand,
		reserved: balance.reserved,
		outgoingTransferCommitted: balance.outgoingTransferCommitted,
		available: balance.available,
		version: balance.version,
	};
}

function replayOrConflict(
	transaction: InventoryTransaction,
	commandId: string,
	commandDigest: string,
): StockReservationResult | null {
	const existing = transaction.getCommand<StockReservationResult>(commandId);
	if (existing === null) return null;
	return existing.commandDigest === commandDigest
		? existing.result
		: rejection(
				commandId,
				"command_id_conflict",
				"The command ID is already bound to different contents.",
			);
}

function durableRejection(
	transaction: InventoryTransaction,
	commandId: string,
	commandDigest: string,
	code: StockReservationRejectionCode,
	message: string,
): StockReservationResult {
	const result = rejection(commandId, code, message);
	transaction.storeRejection({ commandId, commandDigest, result });
	return result;
}

function applyReservedDelta(
	before: BalanceRecord,
	reservedDelta: string,
): BalanceRecord {
	const unit = before.onHand.unit;
	const nextReserved = addExactDecimal(before.reserved.value, reservedDelta);
	const nextAvailable = subtractExactDecimal(
		subtractExactDecimal(before.onHand.value, nextReserved),
		before.outgoingTransferCommitted.value,
	);
	return {
		...before,
		reserved: { value: nextReserved, unit },
		available: { value: nextAvailable, unit },
		version: incrementVersion(before.version),
	};
}

function applyPackDelta(before: BalanceRecord, quantity: string): BalanceRecord {
	const unit = before.onHand.unit;
	const nextOnHand = subtractExactDecimal(before.onHand.value, quantity);
	const nextReserved = subtractExactDecimal(before.reserved.value, quantity);
	const nextAvailable = subtractExactDecimal(
		subtractExactDecimal(nextOnHand, nextReserved),
		before.outgoingTransferCommitted.value,
	);
	return {
		...before,
		onHand: { value: nextOnHand, unit },
		reserved: { value: nextReserved, unit },
		available: { value: nextAvailable, unit },
		version: incrementVersion(before.version),
	};
}

function zero(unit: string): ExactQuantity {
	return { value: "0", unit };
}

function effect(
	before: BalanceRecord,
	after: BalanceRecord,
	reservedDelta: ExactQuantity,
	onHandDelta: ExactQuantity = zero(before.onHand.unit),
): StockReservationBalanceEffect {
	return {
		skuId: before.skuId,
		locationId: before.locationId,
		onHandDelta,
		reservedDelta,
		balanceBefore: quantities(before),
		balanceAfter: quantities(after),
	};
}

function receipt(input: {
	commandId: string;
	commandDigest: string;
	type:
		| typeof RESERVE_STOCK_TYPE
		| typeof RELEASE_STOCK_TYPE
		| typeof PACK_STOCK_TYPE
		| typeof PACK_ALL_STOCK_TYPE
		| typeof PACK_SOME_STOCK_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	siteId: string;
	poolId: string;
	reservationBefore: ReservationRecord | null;
	reservationAfter: ReservationRecord;
	holds?: readonly Readonly<{
		before: ReservationRecord;
		after: ReservationRecord;
	}>[];
	effects: readonly StockReservationBalanceEffect[];
	references: ReserveStockCommandV1["references"];
	createReceiptId: () => string;
}): StockReservationReceiptV2 {
	return {
		schema: RECEIPT_SCHEMA,
		receiptId: idFrom(input.createReceiptId, "createReceiptId"),
		commandId: input.commandId,
		commandDigest: input.commandDigest,
		status: "committed",
		type: input.type,
		committedAt: input.committedAt,
		principal: input.principal,
		context: { siteId: input.siteId, poolId: input.poolId },
		reservation: {
			before: input.reservationBefore,
			after: input.reservationAfter,
		},
		...(input.holds === undefined ? {} : { holds: input.holds }),
		effects: input.effects,
		references: input.references,
	};
}

export function executeReserveStockInTransaction(
	transaction: InventoryTransaction,
	command: ReserveStockCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Readonly<{
		now: () => Date;
		createReservationId: () => string;
		createReceiptId: () => string;
	}>,
): StockReservationResult {
	const replayed = replayOrConflict(
		transaction,
		command.commandId,
		commandDigest,
	);
	if (replayed !== null) return replayed;

	const orderLineKey = reservationOrderLineKey(command.payload.orderLine);
	const existingHold = transaction.getActiveReservationByOrderLineKey(
		orderLineKey,
	);
	if (existingHold !== null) {
		if (!sameReservationContents(existingHold, command)) {
			return durableRejection(
				transaction,
				command.commandId,
				commandDigest,
				"order_line_conflict",
				"This order line already has a hold with different contents.",
			);
		}
		const result: StockReservationResult = {
			schema: COMMAND_RESULT_SCHEMA,
			outcome: "existing",
			commandId: command.commandId,
			reservation: existingHold,
		};
		transaction.storeCommandResult({
			commandId: command.commandId,
			commandDigest,
			result,
		});
		return result;
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
			"The location is archived and cannot hold stock.",
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
	if (managedSku.unit !== command.payload.quantity.unit) {
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
	const available = before?.available.value ?? "0";
	const availableUnit = before?.available.unit ?? command.payload.quantity.unit;
	if (
		before !== null &&
		(before.onHand.unit !== command.payload.quantity.unit ||
			before.reserved.unit !== command.payload.quantity.unit ||
			availableUnit !== command.payload.quantity.unit)
	) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"sku_unit_mismatch",
			"The stock quantity unit does not match this SKU.",
		);
	}
	if (compareExactDecimal(available, command.payload.quantity.value) < 0) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"insufficient_available",
			"Available stock is not enough to hold this quantity.",
		);
	}
	if (before === null) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"insufficient_available",
			"Available stock is not enough to hold this quantity.",
		);
	}

	const after = applyReservedDelta(before, command.payload.quantity.value);
	const createdAt = committedAtFrom(dependencies.now);
	const reservation: ReservationRecord = {
		schema: RESERVATION_RECORD_SCHEMA,
		reservationId: idFrom(
			dependencies.createReservationId,
			"createReservationId",
		),
		poolId: command.context.poolId,
		locationId: command.context.locationId,
		skuId: command.payload.skuId,
		quantity: command.payload.quantity,
		orderLine: command.payload.orderLine,
		status: "active",
		version: "1",
		createdAt,
		canceledAt: null,
		packedAt: null,
		createdBy: principal,
		canceledBy: null,
		packedBy: null,
	};
	const committedReceipt = receipt({
		commandId: command.commandId,
		commandDigest,
		type: RESERVE_STOCK_TYPE,
		committedAt: createdAt,
		principal,
		siteId: command.context.siteId,
		poolId: command.context.poolId,
		reservationBefore: null,
		reservationAfter: reservation,
		effects: [effect(before, after, command.payload.quantity)],
		references: command.references,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: StockReservationResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "reserved",
		commandId: command.commandId,
		reservation,
		receipt: committedReceipt,
	};
	transaction.commitStockReservation({
		commandId: command.commandId,
		commandDigest,
		previous: null,
		reservation,
		orderLineKey,
		previousBalance: before,
		balance: after,
		receipt: committedReceipt,
		result,
	});
	return result;
}

export function executeReleaseStockInTransaction(
	transaction: InventoryTransaction,
	command: ReleaseStockCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Readonly<{
		now: () => Date;
		createReceiptId: () => string;
	}>,
): StockReservationResult {
	const replayed = replayOrConflict(
		transaction,
		command.commandId,
		commandDigest,
	);
	if (replayed !== null) return replayed;

	const current = transaction.getReservation(command.payload.reservationId);
	if (current === null) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_not_found",
			"The reservation does not exist in this inventory pool.",
		);
	}
	if (!holdIsOpen(current.status)) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_not_active",
			"The reservation is not active.",
		);
	}

	const key = {
		poolId: command.context.poolId,
		locationId: current.locationId,
		skuId: current.skuId,
	};
	const before = transaction.getBalance(key);
	if (before === null) {
		throw new Error("An active reservation is missing its balance row.");
	}

	const after = applyReservedDelta(
		before,
		`-${current.quantity.value}`,
	);
	const canceledAt = committedAtFrom(dependencies.now);
	const canceled: ReservationRecord = {
		...current,
		status: "canceled",
		version: incrementVersion(current.version),
		canceledAt,
		canceledBy: principal,
	};
	const committedReceipt = receipt({
		commandId: command.commandId,
		commandDigest,
		type: RELEASE_STOCK_TYPE,
		committedAt: canceledAt,
		principal,
		siteId: command.context.siteId,
		poolId: command.context.poolId,
		reservationBefore: current,
		reservationAfter: canceled,
		effects: [
			effect(before, after, {
				value: `-${current.quantity.value}`,
				unit: current.quantity.unit,
			}),
		],
		references: command.references,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: StockReservationResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "released",
		commandId: command.commandId,
		reservation: canceled,
		receipt: committedReceipt,
	};
	transaction.commitStockReservation({
		commandId: command.commandId,
		commandDigest,
		previous: current,
		reservation: canceled,
		orderLineKey: reservationOrderLineKey(current.orderLine),
		previousBalance: before,
		balance: after,
		receipt: committedReceipt,
		result,
	});
	return result;
}

export function executePackStockInTransaction(
	transaction: InventoryTransaction,
	command: PackStockCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Readonly<{
		now: () => Date;
		createReceiptId: () => string;
	}>,
): StockReservationResult {
	const replayed = replayOrConflict(
		transaction,
		command.commandId,
		commandDigest,
	);
	if (replayed !== null) return replayed;

	const current = transaction.getReservation(command.payload.reservationId);
	if (current === null) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_not_found",
			"The reservation does not exist in this inventory pool.",
		);
	}
	if (current.status === "packed") {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_already_packed",
			"The reservation is already packed.",
		);
	}
	if (!holdIsOpen(current.status)) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_not_active",
			"The reservation is not active.",
		);
	}

	const key = {
		poolId: command.context.poolId,
		locationId: current.locationId,
		skuId: current.skuId,
	};
	const before = transaction.getBalance(key);
	if (before === null) {
		throw new Error("An active reservation is missing its balance row.");
	}
	if (compareExactDecimal(before.reserved.value, current.quantity.value) < 0) {
		throw new Error("Reserved stock is short of the packed hold.");
	}

	const after = applyPackDelta(before, current.quantity.value);
	const packedAt = committedAtFrom(dependencies.now);
	const packed: ReservationRecord = {
		...current,
		quantity: { value: "0", unit: current.quantity.unit },
		status: "packed",
		version: incrementVersion(current.version),
		packedAt,
		packedBy: principal,
	};
	const packedDelta = {
		value: `-${current.quantity.value}`,
		unit: current.quantity.unit,
	};
	const committedReceipt = receipt({
		commandId: command.commandId,
		commandDigest,
		type: PACK_STOCK_TYPE,
		committedAt: packedAt,
		principal,
		siteId: command.context.siteId,
		poolId: command.context.poolId,
		reservationBefore: current,
		reservationAfter: packed,
		effects: [effect(before, after, packedDelta, packedDelta)],
		references: command.references,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: StockReservationResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "packed",
		commandId: command.commandId,
		reservation: packed,
		receipt: committedReceipt,
	};
	transaction.commitStockReservation({
		commandId: command.commandId,
		commandDigest,
		previous: current,
		reservation: packed,
		orderLineKey: reservationOrderLineKey(current.orderLine),
		previousBalance: before,
		balance: after,
		receipt: committedReceipt,
		result,
	});
	return result;
}

function packAllHoldRejection(
	current: ReservationRecord | null,
): Readonly<{ code: StockReservationRejectionCode; message: string }> | null {
	if (current === null) {
		return {
			code: "reservation_not_found",
			message: "The reservation does not exist in this inventory pool.",
		};
	}
	if (current.status === "packed") {
		return {
			code: "reservation_already_packed",
			message: "The reservation is already packed.",
		};
	}
	if (!holdIsOpen(current.status)) {
		return {
			code: "reservation_not_active",
			message: "The reservation is not active.",
		};
	}
	return null;
}

function balanceKey(locationId: string, skuId: string): string {
	return JSON.stringify([locationId, skuId]);
}

export function executePackAllStockInTransaction(
	transaction: InventoryTransaction,
	command: PackAllStockCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Readonly<{
		now: () => Date;
		createReceiptId: () => string;
	}>,
): StockReservationResult {
	const replayed = replayOrConflict(
		transaction,
		command.commandId,
		commandDigest,
	);
	if (replayed !== null) return replayed;

	const currents: ReservationRecord[] = [];
	for (const reservationId of command.payload.reservationIds) {
		const current = transaction.getReservation(reservationId);
		const rejected = packAllHoldRejection(current);
		if (rejected !== null) {
			return durableRejection(
				transaction,
				command.commandId,
				commandDigest,
				rejected.code,
				rejected.message,
			);
		}
		currents.push(current as ReservationRecord);
	}

	const packedAt = committedAtFrom(dependencies.now);
	const originals = new Map<string, BalanceRecord>();
	const working = new Map<string, BalanceRecord>();
	const packedHolds: ReservationRecord[] = [];
	const holds: { before: ReservationRecord; after: ReservationRecord }[] = [];
	const effects: StockReservationBalanceEffect[] = [];

	for (const current of currents) {
		const key = balanceKey(current.locationId, current.skuId);
		let before = working.get(key);
		if (before === undefined) {
			const loaded = transaction.getBalance({
				poolId: command.context.poolId,
				locationId: current.locationId,
				skuId: current.skuId,
			});
			if (loaded === null) {
				throw new Error("An active reservation is missing its balance row.");
			}
			originals.set(key, loaded);
			before = loaded;
		}
		if (compareExactDecimal(before.reserved.value, current.quantity.value) < 0) {
			throw new Error("Reserved stock is short of the packed hold.");
		}
		const after = applyPackDelta(before, current.quantity.value);
		working.set(key, after);
		const packed: ReservationRecord = {
			...current,
			quantity: { value: "0", unit: current.quantity.unit },
			status: "packed",
			version: incrementVersion(current.version),
			packedAt,
			packedBy: principal,
		};
		packedHolds.push(packed);
		holds.push({ before: current, after: packed });
		const packedDelta = {
			value: `-${current.quantity.value}`,
			unit: current.quantity.unit,
		};
		effects.push(effect(before, after, packedDelta, packedDelta));
	}

	const committedReceipt = receipt({
		commandId: command.commandId,
		commandDigest,
		type: PACK_ALL_STOCK_TYPE,
		committedAt: packedAt,
		principal,
		siteId: command.context.siteId,
		poolId: command.context.poolId,
		reservationBefore: currents[0] ?? null,
		reservationAfter: packedHolds[0] as ReservationRecord,
		holds,
		effects,
		references: command.references,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: StockReservationResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "packed_all",
		commandId: command.commandId,
		reservations: packedHolds,
		receipt: committedReceipt,
	};
	transaction.commitStockReservationBatch({
		commandId: command.commandId,
		commandDigest,
		reservations: holds.map((hold) => ({
			previous: hold.before,
			reservation: hold.after,
			orderLineKey: reservationOrderLineKey(hold.before.orderLine),
		})),
		balances: [...working.entries()].map(([key, balance]) => ({
			previous: originals.get(key) as BalanceRecord,
			balance,
		})),
		receipt: committedReceipt,
		result,
	});
	return result;
}

export function executePackSomeStockInTransaction(
	transaction: InventoryTransaction,
	command: PackSomeStockCommandV1,
	principal: CommandPrincipal,
	commandDigest: string,
	dependencies: Readonly<{
		now: () => Date;
		createReceiptId: () => string;
	}>,
): StockReservationResult {
	const replayed = replayOrConflict(
		transaction,
		command.commandId,
		commandDigest,
	);
	if (replayed !== null) return replayed;

	const current = transaction.getReservation(command.payload.reservationId);
	if (current === null) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_not_found",
			"The reservation does not exist in this inventory pool.",
		);
	}
	if (current.status === "packed") {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_already_packed",
			"The reservation is already packed.",
		);
	}
	if (!holdIsOpen(current.status)) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_not_active",
			"The reservation is not active.",
		);
	}
	if (command.payload.quantity.unit !== current.quantity.unit) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"sku_unit_mismatch",
			"The packed quantity unit does not match the hold.",
		);
	}
	if (
		compareExactDecimal(command.payload.quantity.value, current.quantity.value) >
		0
	) {
		return durableRejection(
			transaction,
			command.commandId,
			commandDigest,
			"reservation_quantity_exceeds_hold",
			"A ticket can only pack the hats still reserved on it.",
		);
	}

	const key = {
		poolId: command.context.poolId,
		locationId: current.locationId,
		skuId: current.skuId,
	};
	const before = transaction.getBalance(key);
	if (before === null) {
		throw new Error("An active reservation is missing its balance row.");
	}
	if (
		compareExactDecimal(before.reserved.value, command.payload.quantity.value) < 0
	) {
		throw new Error("Reserved stock is short of the packed hold.");
	}

	const remaining = subtractExactDecimal(
		current.quantity.value,
		command.payload.quantity.value,
	);
	const finished = compareExactDecimal(remaining, "0") === 0;
	const after = applyPackDelta(before, command.payload.quantity.value);
	const packedAt = committedAtFrom(dependencies.now);
	const next: ReservationRecord = finished
		? {
				...current,
				quantity: { value: "0", unit: current.quantity.unit },
				status: "packed",
				version: incrementVersion(current.version),
				packedAt,
				packedBy: principal,
			}
		: {
				...current,
				quantity: { value: remaining, unit: current.quantity.unit },
				status: "partially_packed",
				version: incrementVersion(current.version),
			};
	const packedDelta = {
		value: `-${command.payload.quantity.value}`,
		unit: current.quantity.unit,
	};
	const committedReceipt = receipt({
		commandId: command.commandId,
		commandDigest,
		type: PACK_SOME_STOCK_TYPE,
		committedAt: packedAt,
		principal,
		siteId: command.context.siteId,
		poolId: command.context.poolId,
		reservationBefore: current,
		reservationAfter: next,
		effects: [effect(before, after, packedDelta, packedDelta)],
		references: command.references,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: StockReservationResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: finished ? "packed" : "packed_some",
		commandId: command.commandId,
		reservation: next,
		receipt: committedReceipt,
	};
	transaction.commitStockReservation({
		commandId: command.commandId,
		commandDigest,
		previous: current,
		reservation: next,
		orderLineKey: reservationOrderLineKey(current.orderLine),
		previousBalance: before,
		balance: after,
		receipt: committedReceipt,
		result,
	});
	return result;
}

export function createReserveStock(
	dependencies: StockReservationDependencies,
): ReserveStock {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	if (typeof dependencies.now !== "function") {
		throw new TypeError("now is required.");
	}
	if (typeof dependencies.createReservationId !== "function") {
		throw new TypeError("createReservationId is required.");
	}
	if (typeof dependencies.createReceiptId !== "function") {
		throw new TypeError("createReceiptId is required.");
	}
	return async (commandInput, executionInput) => {
		const command = normalizeReserveStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestStockReservationCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executeReserveStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}

export function createReleaseStock(
	dependencies: ReleaseStockDependencies,
): ReleaseStock {
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
		const command = normalizeReleaseStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestStockReservationCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executeReleaseStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}

export function createPackStock(
	dependencies: PackStockDependencies,
): PackStock {
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
		const command = normalizePackStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestStockReservationCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executePackStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}

export function createPackSomeStock(
	dependencies: PackSomeStockDependencies,
): PackSomeStock {
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
		const command = normalizePackSomeStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestStockReservationCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executePackSomeStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}

export function createPackAllStock(
	dependencies: PackAllStockDependencies,
): PackAllStock {
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
		const command = normalizePackAllStockCommand(commandInput);
		const principal = normalizeCommandPrincipal(executionInput?.principal);
		const commandDigest = await digestStockReservationCommand(command);
		return dependencies.store.runTransaction(
			command.context.poolId,
			(transaction) =>
				executePackAllStockInTransaction(
					transaction,
					command,
					principal,
					commandDigest,
					dependencies,
				),
		);
	};
}
