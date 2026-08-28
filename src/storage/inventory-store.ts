import type {
	BalanceRecord,
	OpeningBalanceReceiptV1,
	OpeningBalanceResult,
	SkuLocationKey,
} from "../domain/opening-balance.ts";

export type StoredCommandResult = Readonly<{
	commandId: string;
	commandDigest: string;
	result: OpeningBalanceResult;
}>;

export type OpeningBalanceCommit = Readonly<{
	commandId: string;
	commandDigest: string;
	balance: BalanceRecord;
	receipt: OpeningBalanceReceiptV1;
	result: OpeningBalanceResult;
}>;

export interface InventoryTransaction {
	getCommand(commandId: string): StoredCommandResult | null;
	getBalance(key: SkuLocationKey): BalanceRecord | null;
	storeRejection(record: StoredCommandResult): void;
	commitOpeningBalance(input: OpeningBalanceCommit): void;
}

export interface InventoryStore {
	runTransaction<T>(
		poolId: string,
		operation: (transaction: InventoryTransaction) => T,
	): Promise<T>;
	readBalance(key: SkuLocationKey): Promise<BalanceRecord | null>;
	readReceipt(receiptId: string): Promise<OpeningBalanceReceiptV1 | null>;
	close(): Promise<void>;
}
