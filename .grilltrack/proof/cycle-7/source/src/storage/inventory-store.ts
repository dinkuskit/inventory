import type {
	BalanceRecord,
	OpeningBalanceReceiptV2,
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
	receipt: OpeningBalanceReceiptV2;
	result: OpeningBalanceResult;
}>;

export type StoredOpeningBalanceConfirmation = Readonly<{
	confirmationDigest: string;
	poolId: string;
	actionDigest: string;
	principalDigest: string;
	issuedAt: string;
	expiresAt: string;
	commandId: string | null;
}>;

export interface InventoryTransaction {
	getCommand(commandId: string): StoredCommandResult | null;
	getBalance(key: SkuLocationKey): BalanceRecord | null;
	getOpeningBalanceConfirmation(
		confirmationDigest: string,
	): StoredOpeningBalanceConfirmation | null;
	storeOpeningBalanceConfirmation(
		record: StoredOpeningBalanceConfirmation,
	): void;
	bindOpeningBalanceConfirmation(
		confirmationDigest: string,
		commandId: string,
	): void;
	storeRejection(record: StoredCommandResult): void;
	commitOpeningBalance(input: OpeningBalanceCommit): void;
}

export interface InventoryStore {
	runTransaction<T>(
		poolId: string,
		operation: (transaction: InventoryTransaction) => T,
	): Promise<T>;
	readBalance(key: SkuLocationKey): Promise<BalanceRecord | null>;
	readCommand(commandId: string): Promise<StoredCommandResult | null>;
	readCommandByReceiptId(
		receiptId: string,
	): Promise<StoredCommandResult | null>;
	readReceipt(receiptId: string): Promise<OpeningBalanceReceiptV2 | null>;
	close(): Promise<void>;
}
