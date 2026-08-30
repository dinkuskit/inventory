import type { InventoryStore } from "../../storage/inventory-store.ts";
import { addExactDecimal } from "../../domain/exact-decimal.ts";
import {
	STOCK_TRANSFER_LIST_RESULT_SCHEMA,
	STOCK_TRANSFER_READ_RESULT_SCHEMA,
	decodeStockTransferListCursor,
	encodeStockTransferListCursor,
	normalizeReadStockTransferListInput,
	normalizeReadStockTransferInput,
	type ReadStockTransferListInput,
	type ReadStockTransferInput,
	type StockTransferListEndpoint,
	type StockTransferListResult,
	type StockTransferListRow,
	type StockTransferReadResult,
} from "./domain.ts";
import type { StoredStockTransferListRow } from "../../storage/inventory-store.ts";

export type ReadStockTransfer = (
	input: ReadStockTransferInput,
) => Promise<StockTransferReadResult>;

export type ReadStockTransferDependencies = Readonly<{ store: InventoryStore }>;

export type ReadStockTransferList = (
	input: ReadStockTransferListInput,
) => Promise<StockTransferListResult>;

export type ReadStockTransferListDependencies = Readonly<{
	store: InventoryStore;
}>;

function endpoint(
	location: StoredStockTransferListRow["origin"],
): StockTransferListEndpoint {
	return {
		locationId: location.locationId,
		name: location.name,
		status: location.status,
	};
}

function compactTransferListRow(
	stored: StoredStockTransferListRow,
): StockTransferListRow {
	const { transfer, origin, destination } = stored;
	if (
		origin.poolId !== transfer.poolId ||
		destination.poolId !== transfer.poolId ||
		origin.locationId !== transfer.originLocationId ||
		destination.locationId !== transfer.destinationLocationId
	) {
		throw new Error("Stored stock transfer endpoint facts are inconsistent.");
	}
	const base = {
		transferId: transfer.transferId,
		reference: transfer.reference,
		status: transfer.status,
		origin: endpoint(origin),
		destination: endpoint(destination),
		productLineCount: transfer.lines.length,
	};
	if (transfer.status === "created") {
		if (
			transfer.dispatchedDate !== null ||
			transfer.receivedDate !== null ||
			transfer.canceledAt !== null
		) {
			throw new Error("Stored Created transfer has impossible lifecycle dates.");
		}
		return {
			...base,
			status: "created",
			createdAt: transfer.createdAt,
			expectedDispatchDate: transfer.expectedDispatchDate,
			expectedArrivalDate: transfer.expectedArrivalDate,
		};
	}
	if (transfer.status === "in_transit") {
		if (
			transfer.dispatchedDate === null ||
			transfer.receivedDate !== null ||
			transfer.canceledAt !== null
		) {
			throw new Error("Stored In-transit transfer has impossible lifecycle dates.");
		}
		return {
			...base,
			status: "in_transit",
			createdAt: transfer.createdAt,
			expectedDispatchDate: transfer.expectedDispatchDate,
			expectedArrivalDate: transfer.expectedArrivalDate,
		};
	}
	if (transfer.status === "received") {
		if (
			transfer.dispatchedDate === null ||
			transfer.receivedDate === null ||
			transfer.canceledAt !== null
		) {
			throw new Error("Stored Received transfer has impossible lifecycle dates.");
		}
		return {
			...base,
			status: "received",
			dispatchedDate: transfer.dispatchedDate,
			receivedDate: transfer.receivedDate,
		};
	}
	if (
		transfer.dispatchedDate !== null ||
		transfer.receivedDate !== null ||
		transfer.canceledAt === null
	) {
		throw new Error("Stored Canceled transfer has impossible lifecycle dates.");
	}
	return {
		...base,
		status: "canceled",
		createdAt: transfer.createdAt,
		canceledAt: transfer.canceledAt,
	};
}

export function createReadStockTransferList(
	dependencies: ReadStockTransferListDependencies,
): ReadStockTransferList {
	if (dependencies?.store === undefined) throw new TypeError("store is required.");
	return async (input) => {
		const query = normalizeReadStockTransferListInput(input);
		const after = query.cursor === undefined
			? undefined
			: decodeStockTransferListCursor(query.cursor, query);
		const stored = await dependencies.store.listStockTransfers({
			poolId: query.poolId,
			view: query.view,
			...(query.scope.kind === "location"
				? { locationId: query.scope.locationId }
				: {}),
			limit: query.limit + 1,
			...(after === undefined ? {} : { after }),
		});
		if (query.scope.kind === "location") {
			if (stored.selectedLocation === null) {
				return {
					schema: STOCK_TRANSFER_LIST_RESULT_SCHEMA,
					outcome: "location_not_found",
					poolId: query.poolId,
					view: query.view,
					scope: query.scope,
				};
			}
			if (
				stored.selectedLocation.poolId !== query.poolId ||
				stored.selectedLocation.locationId !== query.scope.locationId
			) {
				throw new Error("Stored selected-location facts are inconsistent.");
			}
			if (stored.selectedLocation.status !== "active") {
				return {
					schema: STOCK_TRANSFER_LIST_RESULT_SCHEMA,
					outcome: "location_not_active",
					poolId: query.poolId,
					view: query.view,
					scope: query.scope,
				};
			}
		}
		for (const row of stored.rows) {
			if (
				row.transfer.poolId !== query.poolId ||
				(query.view === "open"
					? row.transfer.status !== "created" && row.transfer.status !== "in_transit"
					: row.transfer.status !== "received" && row.transfer.status !== "canceled")
			) {
				throw new Error("Stored stock-transfer list row does not match its query.");
			}
		}
		const hasMore = stored.rows.length > query.limit;
		const page = stored.rows.slice(0, query.limit);
		const last = hasMore ? page.at(-1) : undefined;
		return {
			schema: STOCK_TRANSFER_LIST_RESULT_SCHEMA,
			outcome: "listed",
			poolId: query.poolId,
			view: query.view,
			scope: query.scope,
			transfers: page.map(compactTransferListRow),
			next: last === undefined
				? null
				: encodeStockTransferListCursor(query, last.position),
		};
	};
}

export function createReadStockTransfer(
	dependencies: ReadStockTransferDependencies,
): ReadStockTransfer {
	if (dependencies?.store === undefined) throw new TypeError("store is required.");
	return async (input) => {
		const query = normalizeReadStockTransferInput(input);
		const transfer = await dependencies.store.readStockTransfer(query);
		if (transfer === null) {
			return {
					schema: STOCK_TRANSFER_READ_RESULT_SCHEMA,
					outcome: "not_found",
					poolId: query.poolId,
					transferId: query.transferId,
				};
		}
		const lineStock = await Promise.all(
			transfer.lines.map(async (line) => {
				const [origin, destination] = await Promise.all([
					dependencies.store.readBalance({
						poolId: query.poolId,
						locationId: transfer.originLocationId,
						skuId: line.skuId,
					}),
					dependencies.store.readBalance({
						poolId: query.poolId,
						locationId: transfer.destinationLocationId,
						skuId: line.skuId,
					}),
				]);
				const zero = { value: "0", unit: line.quantity.unit };
				const originAvailable = origin?.available ?? zero;
				const originMovable = {
					value:
						transfer.status === "created"
							? addExactDecimal(
									originAvailable.value,
									line.quantity.value,
								)
							: originAvailable.value,
					unit: line.quantity.unit,
				};
				const projectedOriginAvailable =
					transfer.status === "created"
						? originAvailable
						: originMovable;
				return {
					skuId: line.skuId,
					originMovable,
					quantityToMove: line.quantity,
					destinationOnHand: destination?.onHand ?? zero,
					projectedOriginAvailable,
					reservedForOrders: origin?.reserved ?? zero,
					availability: projectedOriginAvailable.value.startsWith("-")
						? "not_available" as const
						: "available" as const,
				};
			}),
		);
		return {
			schema: STOCK_TRANSFER_READ_RESULT_SCHEMA,
			outcome: "found",
			transfer,
			lineStock,
		};
	};
}
