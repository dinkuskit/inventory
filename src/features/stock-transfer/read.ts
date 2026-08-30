import type { InventoryStore } from "../../storage/inventory-store.ts";
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
		return transfer === null
			? {
					schema: STOCK_TRANSFER_READ_RESULT_SCHEMA,
					outcome: "not_found",
					poolId: query.poolId,
					transferId: query.transferId,
				}
			: {
					schema: STOCK_TRANSFER_READ_RESULT_SCHEMA,
					outcome: "found",
					transfer,
				};
	};
}
