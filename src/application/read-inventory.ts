import {
	BALANCE_READ_RESULT_SCHEMA,
	MUTATION_READ_RESULT_SCHEMA,
	RECEIPT_HISTORY_READ_RESULT_SCHEMA,
	SKU_STOCK_READ_RESULT_SCHEMA,
	InconsistentSkuStockUnitError,
	normalizeInventoryMutationLookup,
	normalizeReadReceiptHistoryInput,
	normalizeReadSkuLocationBalanceInput,
	normalizeReadSkuStockInput,
	type InventoryMutationLookup,
	type InventoryMutationReadResult,
	type ReadReceiptHistoryInput,
	type ReadSkuLocationBalanceInput,
	type ReceiptHistoryReadResult,
	type ReadSkuStockInput,
	type SkuStockLocation,
	type SkuStockReadResult,
	type StockQuantities,
	type SkuLocationBalanceReadResult,
} from "../domain/inventory-read.ts";
import type { BalanceRecord, ExactQuantity } from "../domain/opening-balance.ts";
import type { InventoryStore } from "../storage/inventory-store.ts";

export type ReadInventoryDependencies = Readonly<{
	store: InventoryStore;
}>;

export type ReadSkuLocationBalance = (
	input: ReadSkuLocationBalanceInput,
) => Promise<SkuLocationBalanceReadResult>;

export type ReadInventoryMutation = (
	lookup: InventoryMutationLookup,
) => Promise<InventoryMutationReadResult>;

export type ReadReceiptHistory = (
	input: ReadReceiptHistoryInput,
) => Promise<ReceiptHistoryReadResult>;

export type ReadSkuStock = (
	input: ReadSkuStockInput,
) => Promise<SkuStockReadResult>;

function requireStore(dependencies: ReadInventoryDependencies): InventoryStore {
	if (dependencies?.store === undefined) {
		throw new TypeError("store is required.");
	}
	return dependencies.store;
}

export function createReadSkuLocationBalance(
	dependencies: ReadInventoryDependencies,
): ReadSkuLocationBalance {
	const store = requireStore(dependencies);
	return async function readSkuLocationBalance(
		input: ReadSkuLocationBalanceInput,
	): Promise<SkuLocationBalanceReadResult> {
		const key = normalizeReadSkuLocationBalanceInput(input);
		const balance = await store.readBalance(key);
		return balance === null
			? {
					schema: BALANCE_READ_RESULT_SCHEMA,
					outcome: "not_found",
					key,
				}
			: {
					schema: BALANCE_READ_RESULT_SCHEMA,
					outcome: "found",
					key,
					balance,
				};
	};
}

export function createReadInventoryMutation(
	dependencies: ReadInventoryDependencies,
): ReadInventoryMutation {
	const store = requireStore(dependencies);
	return async function readInventoryMutation(
		input: InventoryMutationLookup,
	): Promise<InventoryMutationReadResult> {
		const lookup = normalizeInventoryMutationLookup(input);
		const stored =
			"receiptId" in lookup
				? await store.readCommandByReceiptId(lookup.receiptId)
				: await store.readCommand(lookup.commandId);
		return stored === null
			? {
					schema: MUTATION_READ_RESULT_SCHEMA,
					outcome: "not_found",
					lookup,
				}
			: {
					schema: MUTATION_READ_RESULT_SCHEMA,
					outcome: "found",
					lookup,
					result: stored.result,
				};
	};
}

export function createReadReceiptHistory(
	dependencies: ReadInventoryDependencies,
): ReadReceiptHistory {
	const store = requireStore(dependencies);
	return async function readReceiptHistory(
		input: ReadReceiptHistoryInput,
	): Promise<ReceiptHistoryReadResult> {
		const query = normalizeReadReceiptHistoryInput(input);
		const stored = await store.listReceipts({
			poolId: query.poolId,
			...(query.scope.kind === "location"
				? { locationId: query.scope.locationId }
				: {}),
			limit: query.limit + 1,
			...(query.before === undefined ? {} : { before: query.before }),
		});
		const hasMore = stored.length > query.limit;
		const receipts = stored.slice(0, query.limit);
		const last = hasMore ? receipts.at(-1) : undefined;
		return {
			schema: RECEIPT_HISTORY_READ_RESULT_SCHEMA,
			poolId: query.poolId,
			scope: query.scope,
			receipts,
			next:
				last === undefined
					? null
					: {
							committedAt: last.committedAt,
							receiptId: last.receiptId,
						},
		};
	};
}

type ExactDecimal = Readonly<{ unscaled: bigint; scale: number }>;

function exactDecimal(value: string): ExactDecimal {
	if (!/^-?\d+(?:\.\d+)?$/u.test(value)) {
		throw new Error("Stored inventory quantity is not an exact decimal.");
	}
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [whole, fraction = ""] = unsigned.split(".");
	const unscaled = BigInt(`${whole}${fraction}`);
	return {
		unscaled: negative ? -unscaled : unscaled,
		scale: fraction.length,
	};
}

function exactDecimalString(unscaled: bigint, scale: number): string {
	if (unscaled === 0n) {
		return "0";
	}
	const negative = unscaled < 0n;
	const digits = (negative ? -unscaled : unscaled)
		.toString()
		.padStart(scale + 1, "0");
	if (scale === 0) {
		return `${negative ? "-" : ""}${digits}`;
	}
	const whole = digits.slice(0, -scale);
	const fraction = digits.slice(-scale).replace(/0+$/u, "");
	return `${negative ? "-" : ""}${whole}${fraction.length === 0 ? "" : `.${fraction}`}`;
}

function sumExactDecimals(values: readonly string[]): string {
	const parsed = values.map(exactDecimal);
	const scale = parsed.reduce(
		(maximum, value) => Math.max(maximum, value.scale),
		0,
	);
	const sum = parsed.reduce(
		(total, value) =>
			total + value.unscaled * 10n ** BigInt(scale - value.scale),
		0n,
	);
	return exactDecimalString(sum, scale);
}

function stockUnit(balance: BalanceRecord): string {
	const units = [
		balance.onHand.unit,
		balance.reserved.unit,
		balance.available.unit,
	];
	if (units.some((unit) => unit !== units[0])) {
		throw new InconsistentSkuStockUnitError();
	}
	return units[0];
}

function quantity(value: string, unit: string): ExactQuantity {
	return { value, unit };
}

function stockFromValues(
	onHand: string,
	reserved: string,
	unit: string,
): StockQuantities {
	return {
		onHand: quantity(sumExactDecimals([onHand]), unit),
		reserved: quantity(sumExactDecimals([reserved]), unit),
		available: quantity(sumExactDecimals([onHand, `-${reserved}`]), unit),
	};
}

function totalStock(
	locations: readonly SkuStockLocation[],
	unit: string,
): StockQuantities {
	const onHand = sumExactDecimals(
		locations.map((location) => location.stock.onHand.value),
	);
	const reserved = sumExactDecimals(
		locations.map((location) => location.stock.reserved.value),
	);
	return stockFromValues(onHand, reserved, unit);
}

export function createReadSkuStock(
	dependencies: ReadInventoryDependencies,
): ReadSkuStock {
	const store = requireStore(dependencies);
	return async function readSkuStock(
		input: ReadSkuStockInput,
	): Promise<SkuStockReadResult> {
		const query = normalizeReadSkuStockInput(input);
		const managedSku = await store.readManagedSku({
			poolId: query.poolId,
			skuId: query.skuId,
		});
		if (managedSku === null) {
			return {
				schema: SKU_STOCK_READ_RESULT_SCHEMA,
				outcome: "not_found",
				poolId: query.poolId,
				skuId: query.skuId,
				scope: query.scope,
			};
		}
		const snapshot = await store.readSkuActiveLocationSnapshot({
			poolId: query.poolId,
			skuId: query.skuId,
		});
		const balances = snapshot.flatMap(({ balance }) =>
			balance === null ? [] : [balance],
		);
		const unit = managedSku.unit;
		for (const balance of balances) {
			if (stockUnit(balance) !== unit) {
				throw new InconsistentSkuStockUnitError();
			}
		}
		const selectedLocationId =
			query.scope.kind === "location" ? query.scope.locationId : null;
		const selected =
			selectedLocationId === null
				? snapshot
				: snapshot.filter(
						({ location }) =>
							location.locationId === selectedLocationId,
					);
		if (selected.length === 0) {
			return {
				schema: SKU_STOCK_READ_RESULT_SCHEMA,
				outcome: "not_found",
				poolId: query.poolId,
				skuId: query.skuId,
				scope: query.scope,
			};
		}
		const locations = selected.map(({ location, balance }) => ({
			locationId: location.locationId,
			name: location.name,
			stock:
				balance === null
					? stockFromValues("0", "0", unit)
					: stockFromValues(
							balance.onHand.value,
							balance.reserved.value,
							unit,
						),
		}));
		return {
			schema: SKU_STOCK_READ_RESULT_SCHEMA,
			outcome: "found",
			poolId: query.poolId,
			skuId: query.skuId,
			scope: query.scope,
			stock: totalStock(locations, unit),
			locations,
		};
	};
}
