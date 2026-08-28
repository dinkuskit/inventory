import {
	BALANCE_READ_RESULT_SCHEMA,
	MUTATION_READ_RESULT_SCHEMA,
	normalizeInventoryMutationLookup,
	normalizeReadSkuLocationBalanceInput,
	type InventoryMutationLookup,
	type InventoryMutationReadResult,
	type ReadSkuLocationBalanceInput,
	type SkuLocationBalanceReadResult,
} from "../domain/inventory-read.ts";
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
