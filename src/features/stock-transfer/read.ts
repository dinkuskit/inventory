import type { InventoryStore } from "../../storage/inventory-store.ts";
import { addExactDecimal } from "../../domain/exact-decimal.ts";
import {
	STOCK_TRANSFER_READ_RESULT_SCHEMA,
	normalizeReadStockTransferInput,
	type ReadStockTransferInput,
	type StockTransferReadResult,
} from "./domain.ts";

export type ReadStockTransfer = (
	input: ReadStockTransferInput,
) => Promise<StockTransferReadResult>;

export type ReadStockTransferDependencies = Readonly<{ store: InventoryStore }>;

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
