import type {
	BalanceRecord,
	OpeningBalanceResult,
	SkuLocationKey,
} from "../domain/opening-balance.ts";
import type {
	InventoryCommandResult,
	InventoryReceiptV2,
	LocationBalanceBlocker,
	LocationCommandResult,
	LocationReceiptV2,
	LocationRecord,
	LocationStatus,
} from "../domain/location-registry.ts";
import type { OpeningBalanceReceiptV2 } from "../domain/opening-balance.ts";

export type StoredCommandResult<
	TResult extends InventoryCommandResult = InventoryCommandResult,
> = Readonly<{
	commandId: string;
	commandDigest: string;
	result: TResult;
}>;

export type OpeningBalanceCommit = Readonly<{
	commandId: string;
	commandDigest: string;
	balance: BalanceRecord;
	receipt: OpeningBalanceReceiptV2;
	result: OpeningBalanceResult;
}>;

export type LocationCommit = Readonly<{
	commandId: string;
	commandDigest: string;
	previous: LocationRecord | null;
	location: LocationRecord;
	receipt: LocationReceiptV2;
	result: LocationCommandResult;
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

export type ReceiptListCursor = Readonly<{
	committedAt: string;
	receiptId: string;
}>;

export type ListReceiptsQuery = Readonly<{
	poolId: string;
	locationId?: string;
	limit: number;
	before?: ReceiptListCursor;
}>;

export type ListLocationsQuery = Readonly<{
	poolId: string;
	status: LocationStatus;
}>;

export interface InventoryTransaction {
	getCommand<TResult extends InventoryCommandResult = InventoryCommandResult>(
		commandId: string,
	): StoredCommandResult<TResult> | null;
	getBalance(key: SkuLocationKey): BalanceRecord | null;
	getLocation(locationId: string): LocationRecord | null;
	getLocationByNameKey(nameKey: string): LocationRecord | null;
	listLocationBalanceBlockers(
		locationId: string,
	): readonly LocationBalanceBlocker[];
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
	commitLocation(input: LocationCommit): void;
}

export interface InventoryStore {
	runTransaction<T>(
		poolId: string,
		operation: (transaction: InventoryTransaction) => T,
	): Promise<T>;
	readBalance(key: SkuLocationKey): Promise<BalanceRecord | null>;
	readCommand<TResult extends InventoryCommandResult = InventoryCommandResult>(
		commandId: string,
	): Promise<StoredCommandResult<TResult> | null>;
	readCommandByReceiptId<
		TResult extends InventoryCommandResult = InventoryCommandResult,
	>(
		receiptId: string,
	): Promise<StoredCommandResult<TResult> | null>;
	readReceipt(receiptId: string): Promise<InventoryReceiptV2 | null>;
	listReceipts(
		query: ListReceiptsQuery,
	): Promise<readonly OpeningBalanceReceiptV2[]>;
	listLocations(query: ListLocationsQuery): Promise<readonly LocationRecord[]>;
	close(): Promise<void>;
}
