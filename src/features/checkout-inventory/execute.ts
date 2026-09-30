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
	StoredCommandResult,
} from "../../storage/inventory-store.ts";
import {
	RESERVATION_RECORD_SCHEMA,
	holdIsOpen,
	reservationOrderLineKey,
	type ReservationRecord,
	type StockReservationBalanceEffect,
} from "../stock-reservation/index.ts";
import {
	CHECKOUT_RELEASE_TYPE,
	CHECKOUT_RESERVE_TYPE,
	InvalidCheckoutInventoryRequestError,
	checkoutOperationLine,
	checkoutReleaseCommandId,
	checkoutReserveCommandId,
	digestCheckoutStockRequest,
	normalizeInventoryProviderBinding,
	normalizeStockRequest,
	sameInventoryProviderBinding,
	type CheckoutInventoryPort,
	type CheckoutInventoryReceiptV2,
	type CheckoutInventoryRejectionCode,
	type CheckoutInventoryResult,
	type InventoryProviderBinding,
	type NormalizedStockRequest,
	type StockRequest,
} from "./domain.ts";

export type CheckoutInventoryExecution = Readonly<{
	principal: CommandPrincipal;
	siteId: string;
}>;

export type CheckoutInventoryDependencies = Readonly<{
	store: InventoryStore;
	binding: InventoryProviderBinding;
	now: () => Date;
	createReservationId: () => string;
	createReceiptId: () => string;
}>;

export type ReserveCheckoutBasket = (
	request: StockRequest,
	execution: CheckoutInventoryExecution,
) => Promise<CheckoutInventoryResult>;

export type ReleaseCheckoutBasket = (
	request: StockRequest,
	execution: CheckoutInventoryExecution,
) => Promise<CheckoutInventoryResult>;

function incrementVersion(version: string): string {
	return (BigInt(version) + 1n).toString();
}

function rejection(
	commandId: string,
	code: CheckoutInventoryRejectionCode,
	message: string,
): CheckoutInventoryResult {
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

function applyReservedDelta(before: BalanceRecord, reservedDelta: string): BalanceRecord {
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

function effect(
	before: BalanceRecord,
	after: BalanceRecord,
	reservedDelta: ExactQuantity,
): StockReservationBalanceEffect {
	return {
		skuId: before.skuId,
		locationId: before.locationId,
		onHandDelta: { value: "0", unit: before.onHand.unit },
		reservedDelta,
		balanceBefore: quantities(before),
		balanceAfter: quantities(after),
	};
}

function durableRejection(
	transaction: InventoryTransaction,
	commandId: string,
	commandDigest: string,
	code: CheckoutInventoryRejectionCode,
	message: string,
): CheckoutInventoryResult {
	const result = rejection(commandId, code, message);
	transaction.storeRejection({ commandId, commandDigest, result });
	return result;
}

function replayOrConflict(
	transaction: InventoryTransaction,
	commandId: string,
	commandDigest: string,
): CheckoutInventoryResult | null {
	const existing = transaction.getCommand<CheckoutInventoryResult>(commandId);
	if (existing === null) return null;
	return existing.commandDigest === commandDigest
		? existing.result
		: rejection(
				commandId,
				"command_id_conflict",
				"The command ID is already bound to different contents.",
			);
}

function receipt(input: {
	commandId: string;
	commandDigest: string;
	type: typeof CHECKOUT_RESERVE_TYPE | typeof CHECKOUT_RELEASE_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	siteId: string;
	poolId: string;
	operationId: string;
	binding: NormalizedStockRequest["binding"];
	holds: CheckoutInventoryReceiptV2["holds"];
	effects: readonly StockReservationBalanceEffect[];
	createReceiptId: () => string;
}): CheckoutInventoryReceiptV2 {
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
		operationId: input.operationId,
		binding: input.binding,
		holds: input.holds,
		effects: input.effects,
		references: input.holds.map((hold) => hold.after.orderLine),
	};
}

function evaluateReserve(
	transaction: InventoryTransaction,
	request: NormalizedStockRequest,
	principal: CommandPrincipal,
	siteId: string,
	commandDigest: string,
	dependencies: CheckoutInventoryDependencies,
): CheckoutInventoryResult {
	const reserveCommandId = checkoutReserveCommandId(request.operationId);
	const releaseCommandId = checkoutReleaseCommandId(request.operationId);
	const releaseFence = transaction.getCommand(releaseCommandId);
	if (releaseFence !== null) {
		if (releaseFence.commandDigest !== commandDigest) {
			return rejection(
				reserveCommandId,
				"command_id_conflict",
				"The command ID is already bound to different contents.",
			);
		}
		const existingReserve = replayOrConflict(
			transaction,
			reserveCommandId,
			commandDigest,
		);
		if (existingReserve !== null && existingReserve.outcome === "rejected") {
			return existingReserve;
		}
		if (existingReserve !== null && existingReserve.outcome === "reserved") {
			return rejection(
				reserveCommandId,
				"checkout_released",
				"This checkout operation was already released and cannot hold stock again.",
			);
		}
		return durableRejection(
			transaction,
			reserveCommandId,
			commandDigest,
			"checkout_released",
			"This checkout operation was already released and cannot hold stock.",
		);
	}

	const replayed = replayOrConflict(transaction, reserveCommandId, commandDigest);
	if (replayed !== null) return replayed;

	if (request.requirements.some((line) => line.allowBackorders)) {
		return durableRejection(
			transaction,
			reserveCommandId,
			commandDigest,
			"unsupported_backorder_policy",
			"Backorder holds are unsupported; the basket was rejected without holds.",
		);
	}

	const location = transaction.getLocation(request.binding.defaultFulfillmentLocationId);
	if (location === null) {
		return durableRejection(
			transaction,
			reserveCommandId,
			commandDigest,
			"location_not_found",
			"The fulfillment location does not exist in this inventory pool.",
		);
	}
	if (location.status !== "active") {
		return durableRejection(
			transaction,
			reserveCommandId,
			commandDigest,
			"location_not_active",
			"The fulfillment location is archived and cannot hold stock.",
		);
	}

	const originals = new Map<string, BalanceRecord>();
	const working = new Map<string, BalanceRecord>();
	const created: ReservationRecord[] = [];
	const holds: Array<CheckoutInventoryReceiptV2["holds"][number]> = [];
	const effects: StockReservationBalanceEffect[] = [];
	const createdAt = committedAtFrom(dependencies.now);

	for (const line of request.requirements) {
		const managedSku = transaction.getManagedSku(line.skuId);
		if (managedSku === null) {
			return durableRejection(
				transaction,
				reserveCommandId,
				commandDigest,
				"sku_not_registered",
				"This SKU is not set up for inventory.",
			);
		}
		if (managedSku.unit !== "each") {
			return durableRejection(
				transaction,
				reserveCommandId,
				commandDigest,
				"sku_unit_mismatch",
				"The stock quantity unit does not match this SKU.",
			);
		}

		const orderLine = checkoutOperationLine(request.operationId, line.skuId);
		const orderLineKey = reservationOrderLineKey(orderLine);
		const existingHold = transaction.getActiveReservationByOrderLineKey(orderLineKey);
		if (existingHold !== null) {
			return durableRejection(
				transaction,
				reserveCommandId,
				commandDigest,
				"command_id_conflict",
				"This checkout line already has a hold with different contents.",
			);
		}

		const key = {
			poolId: request.binding.poolId,
			locationId: request.binding.defaultFulfillmentLocationId,
			skuId: line.skuId,
		};
		let before = working.get(line.skuId);
		if (before === undefined) {
			const loaded = transaction.getBalance(key);
			if (loaded === null) {
				return durableRejection(
					transaction,
					reserveCommandId,
					commandDigest,
					"insufficient_available",
					"Available stock is not enough to hold the whole basket.",
				);
			}
			if (
				loaded.onHand.unit !== "each" ||
				loaded.reserved.unit !== "each" ||
				loaded.available.unit !== "each"
			) {
				return durableRejection(
					transaction,
					reserveCommandId,
					commandDigest,
					"sku_unit_mismatch",
					"The stock quantity unit does not match this SKU.",
				);
			}
			originals.set(line.skuId, loaded);
			before = loaded;
		}
		if (compareExactDecimal(before.available.value, line.quantity) < 0) {
			return durableRejection(
				transaction,
				reserveCommandId,
				commandDigest,
				"insufficient_available",
				"Available stock is not enough to hold the whole basket.",
			);
		}

		const after = applyReservedDelta(before, line.quantity);
		working.set(line.skuId, after);
		const reservation: ReservationRecord = {
			schema: RESERVATION_RECORD_SCHEMA,
			reservationId: idFrom(dependencies.createReservationId, "createReservationId"),
			poolId: request.binding.poolId,
			locationId: request.binding.defaultFulfillmentLocationId,
			skuId: line.skuId,
			quantity: { value: line.quantity, unit: "each" },
			originalQuantity: { value: line.quantity, unit: "each" },
			orderLine,
			status: "not_shipped",
			version: "1",
			createdAt,
			canceledAt: null,
			packedAt: null,
			createdBy: principal,
			canceledBy: null,
			packedBy: null,
		};
		created.push(reservation);
		holds.push({ before: null, after: reservation });
		effects.push(
			effect(before, after, { value: line.quantity, unit: "each" }),
		);
	}

	const committedReceipt = receipt({
		commandId: reserveCommandId,
		commandDigest,
		type: CHECKOUT_RESERVE_TYPE,
		committedAt: createdAt,
		principal,
		siteId,
		poolId: request.binding.poolId,
		operationId: request.operationId,
		binding: request.binding,
		holds,
		effects,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: CheckoutInventoryResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "reserved",
		commandId: reserveCommandId,
		reservations: created,
		receipt: committedReceipt,
	};
	transaction.commitStockReservationBatch({
		commandId: reserveCommandId,
		commandDigest,
		reservations: holds.map((hold) => ({
			previous: null,
			reservation: hold.after,
			orderLineKey: reservationOrderLineKey(hold.after.orderLine),
		})),
		balances: [...working.entries()].map(([skuId, balance]) => ({
			previous: originals.get(skuId) as BalanceRecord,
			balance,
		})),
		receipt: committedReceipt,
		result,
	});
	return result;
}

function evaluateRelease(
	transaction: InventoryTransaction,
	request: NormalizedStockRequest,
	principal: CommandPrincipal,
	siteId: string,
	commandDigest: string,
	dependencies: CheckoutInventoryDependencies,
): CheckoutInventoryResult {
	const reserveCommandId = checkoutReserveCommandId(request.operationId);
	const releaseCommandId = checkoutReleaseCommandId(request.operationId);
	const replayed = replayOrConflict(transaction, releaseCommandId, commandDigest);
	if (replayed !== null) return replayed;

	const existingReserve = transaction.getCommand<CheckoutInventoryResult>(
		reserveCommandId,
	);
	if (
		existingReserve !== null &&
		existingReserve.commandDigest !== commandDigest
	) {
		return rejection(
			releaseCommandId,
			"command_id_conflict",
			"The command ID is already bound to different contents.",
		);
	}

	const currents = resolveReleaseHolds(
		transaction,
		request,
		existingReserve as StoredCheckoutCommand | null,
	);

	if (currents.length === 0) {
		const result: CheckoutInventoryResult = {
			schema: COMMAND_RESULT_SCHEMA,
			outcome: "released",
			commandId: releaseCommandId,
			reservations: [],
			receipt: null,
		};
		transaction.storeCommandResult({
			commandId: releaseCommandId,
			commandDigest,
			result,
		});
		return result;
	}

	const canceledAt = committedAtFrom(dependencies.now);
	const originals = new Map<string, BalanceRecord>();
	const working = new Map<string, BalanceRecord>();
	const canceled: ReservationRecord[] = [];
	const holds: Array<CheckoutInventoryReceiptV2["holds"][number]> = [];
	const effects: StockReservationBalanceEffect[] = [];

	for (const current of currents) {
		const key = `${current.locationId}:${current.skuId}`;
		let before = working.get(key);
		if (before === undefined) {
			const loaded = transaction.getBalance({
				poolId: request.binding.poolId,
				locationId: current.locationId,
				skuId: current.skuId,
			});
			if (loaded === null) {
				throw new Error("An active checkout hold is missing its balance row.");
			}
			originals.set(key, loaded);
			before = loaded;
		}
		const after = applyReservedDelta(before, `-${current.quantity.value}`);
		working.set(key, after);
		const next: ReservationRecord = {
			...current,
			status: "canceled",
			version: incrementVersion(current.version),
			canceledAt,
			canceledBy: principal,
		};
		canceled.push(next);
		holds.push({ before: current, after: next });
		effects.push(
			effect(before, after, {
				value: `-${current.quantity.value}`,
				unit: current.quantity.unit,
			}),
		);
	}

	const committedReceipt = receipt({
		commandId: releaseCommandId,
		commandDigest,
		type: CHECKOUT_RELEASE_TYPE,
		committedAt: canceledAt,
		principal,
		siteId,
		poolId: request.binding.poolId,
		operationId: request.operationId,
		binding: request.binding,
		holds,
		effects,
		createReceiptId: dependencies.createReceiptId,
	});
	const result: CheckoutInventoryResult = {
		schema: COMMAND_RESULT_SCHEMA,
		outcome: "released",
		commandId: releaseCommandId,
		reservations: canceled,
		receipt: committedReceipt,
	};
	transaction.commitStockReservationBatch({
		commandId: releaseCommandId,
		commandDigest,
		reservations: holds.map((hold) => ({
			previous: hold.before,
			reservation: hold.after,
			orderLineKey: reservationOrderLineKey(
				(hold.before ?? hold.after).orderLine,
			),
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

function resolveReleaseHolds(
	transaction: InventoryTransaction,
	request: NormalizedStockRequest,
	existingReserve: StoredCheckoutCommand | null,
): ReservationRecord[] {
	const liveByKey = new Map<string, ReservationRecord>();
	for (const line of request.requirements) {
		const orderLineKey = reservationOrderLineKey(
			checkoutOperationLine(request.operationId, line.skuId),
		);
		const live = transaction.getActiveReservationByOrderLineKey(orderLineKey);
		if (live !== null) {
			liveByKey.set(orderLineKey, live);
		}
	}

	const listedOpen =
		existingReserve?.result.outcome === "reserved"
			? existingReserve.result.reservations.filter((hold) =>
					holdIsOpen(hold.status),
				)
			: [];

	if (listedOpen.length === 0) {
		if (liveByKey.size > 0) {
			throw new Error(
				"Checkout release found an unexpected live hold for this operation.",
			);
		}
		return [];
	}

	const currents: ReservationRecord[] = [];
	const accounted = new Set<string>();
	for (const listed of listedOpen) {
		const current = transaction.getReservation(listed.reservationId);
		if (current === null) {
			throw new Error(
				"Checkout release cannot find a listed reservation row.",
			);
		}
		const expectedKey = reservationOrderLineKey(listed.orderLine);
		const live = liveByKey.get(expectedKey);
		if (holdIsOpen(current.status)) {
			if (live === undefined || live.reservationId !== current.reservationId) {
				throw new Error(
					"Checkout release found ambiguous reservation rows for one checkout line.",
				);
			}
			if (reservationOrderLineKey(current.orderLine) !== expectedKey) {
				throw new Error(
					"Checkout release found a listed hold that does not match its checkout line.",
				);
			}
			currents.push(current);
			accounted.add(current.reservationId);
		} else if (live !== undefined && live.reservationId !== current.reservationId) {
			throw new Error(
				"Checkout release found ambiguous reservation rows for one checkout line.",
			);
		}
	}

	for (const live of liveByKey.values()) {
		if (!accounted.has(live.reservationId)) {
			throw new Error(
				"Checkout release found an unexpected live hold for this operation.",
			);
		}
	}
	return currents;
}

type StoredCheckoutCommand = StoredCommandResult<CheckoutInventoryResult>;

function requireConfiguredBinding(
	binding: unknown,
): InventoryProviderBinding {
	return Object.freeze(normalizeInventoryProviderBinding(binding, "binding"));
}

function admitConfiguredBinding(
	configured: InventoryProviderBinding,
	request: NormalizedStockRequest,
): void {
	if (!sameInventoryProviderBinding(configured, request.binding)) {
		throw new InvalidCheckoutInventoryRequestError(
			"request binding does not match the configured inventory provider binding.",
		);
	}
}

function requireDependencies(
	dependencies: CheckoutInventoryDependencies,
): InventoryProviderBinding {
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
	return requireConfiguredBinding(dependencies.binding);
}

function admitCheckoutOperation(
	configured: InventoryProviderBinding,
	requestInput: StockRequest,
	executionInput: CheckoutInventoryExecution,
): {
	request: NormalizedStockRequest;
	principal: CommandPrincipal;
	siteId: string;
} {
	const request = normalizeStockRequest(requestInput);
	admitConfiguredBinding(configured, request);
	const principal = normalizeCommandPrincipal(executionInput?.principal);
	const siteId = executionInput?.siteId?.trim();
	if (!siteId) {
		throw new TypeError("siteId is required.");
	}
	return { request, principal, siteId };
}

export function createReserveCheckoutBasket(
	dependencies: CheckoutInventoryDependencies,
): ReserveCheckoutBasket {
	const configured = requireDependencies(dependencies);
	return async (requestInput, executionInput) => {
		const { request, principal, siteId } = admitCheckoutOperation(
			configured,
			requestInput,
			executionInput,
		);
		const commandDigest = await digestCheckoutStockRequest(request, siteId);
		return dependencies.store.runTransaction(configured.poolId, (transaction) =>
			evaluateReserve(
				transaction,
				request,
				principal,
				siteId,
				commandDigest,
				dependencies,
			),
		);
	};
}

export function createReleaseCheckoutBasket(
	dependencies: CheckoutInventoryDependencies,
): ReleaseCheckoutBasket {
	const configured = requireDependencies(dependencies);
	return async (requestInput, executionInput) => {
		const { request, principal, siteId } = admitCheckoutOperation(
			configured,
			requestInput,
			executionInput,
		);
		const commandDigest = await digestCheckoutStockRequest(request, siteId);
		return dependencies.store.runTransaction(configured.poolId, (transaction) =>
			evaluateRelease(
				transaction,
				request,
				principal,
				siteId,
				commandDigest,
				dependencies,
			),
		);
	};
}

export function createCheckoutInventoryPort(
	dependencies: CheckoutInventoryDependencies & CheckoutInventoryExecution,
): CheckoutInventoryPort {
	const reserveBasket = createReserveCheckoutBasket(dependencies);
	const releaseBasket = createReleaseCheckoutBasket(dependencies);
	const execution = {
		principal: dependencies.principal,
		siteId: dependencies.siteId,
	};
	return {
		async reserve(request) {
			try {
				const result = await reserveBasket(request, execution);
				if (result.outcome === "reserved") return "reserved";
				if (result.outcome === "rejected") return "rejected";
				return "unknown";
			} catch (error) {
				if (error instanceof InvalidCheckoutInventoryRequestError) {
					return "rejected";
				}
				return "unknown";
			}
		},
		async release(request) {
			try {
				const result = await releaseBasket(request, execution);
				if (result.outcome === "released") return "released";
				return "unknown";
			} catch (error) {
				if (error instanceof InvalidCheckoutInventoryRequestError) {
					return "unknown";
				}
				return "unknown";
			}
		},
	};
}
