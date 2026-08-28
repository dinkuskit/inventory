import type {
	BalanceRecord,
	OpeningBalanceReceiptV2,
	OpeningBalanceResult,
	SkuLocationKey,
} from "../domain/opening-balance.ts";
import type {
	InventoryStore,
	InventoryTransaction,
	OpeningBalanceCommit,
	StoredCommandResult,
	StoredOpeningBalanceConfirmation,
} from "./inventory-store.ts";

type SqlRow = Record<string, SqlStorageValue>;

function json<T>(value: unknown): T {
	return JSON.parse(String(value)) as T;
}

function first(
	storage: DurableObjectStorage,
	query: string,
	...bindings: unknown[]
): SqlRow | undefined {
	return storage.sql.exec<SqlRow>(query, ...bindings).toArray()[0];
}

function balanceFrom(row: SqlRow | undefined): BalanceRecord | null {
	if (row === undefined) {
		return null;
	}
	const unit = String(row.unit);
	return {
		poolId: String(row.pool_id),
		locationId: String(row.location_id),
		skuId: String(row.sku_id),
		onHand: { value: String(row.on_hand_value), unit },
		reserved: { value: String(row.reserved_value), unit },
		available: { value: String(row.available_value), unit },
		version: String(row.version),
		hasStockHistory: Number(row.has_stock_history) === 1,
	};
}

function commandFrom(row: SqlRow | undefined): StoredCommandResult | null {
	return row === undefined
		? null
		: {
				commandId: String(row.command_id),
				commandDigest: String(row.command_digest),
				result: json<OpeningBalanceResult>(row.terminal_result_json),
			};
}

class CloudflareSqliteInventoryTransaction implements InventoryTransaction {
	readonly #storage: DurableObjectStorage;
	readonly #poolId: string;

	constructor(storage: DurableObjectStorage, poolId: string) {
		this.#storage = storage;
		this.#poolId = poolId;
	}

	#assertPool(key: SkuLocationKey): void {
		if (key.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
	}

	getCommand(commandId: string): StoredCommandResult | null {
		return commandFrom(
			first(
				this.#storage,
				`SELECT command_id, command_digest, terminal_result_json
				 FROM inventory_command_results
				 WHERE command_id = ?`,
				commandId,
			),
		);
	}

	getBalance(key: SkuLocationKey): BalanceRecord | null {
		this.#assertPool(key);
		return balanceFrom(
			first(
				this.#storage,
				`SELECT pool_id, location_id, sku_id, on_hand_value,
				        reserved_value, available_value, unit, version,
				        has_stock_history
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
				key.poolId,
				key.locationId,
				key.skuId,
			),
		);
	}

	getOpeningBalanceConfirmation(
		confirmationDigest: string,
	): StoredOpeningBalanceConfirmation | null {
		const row = first(
			this.#storage,
			`SELECT confirmation_digest, pool_id, action_digest,
			        principal_digest, issued_at, expires_at, command_id
			 FROM inventory_opening_balance_confirmations
			 WHERE confirmation_digest = ?`,
			confirmationDigest,
		);
		return row === undefined
			? null
			: {
					confirmationDigest: String(row.confirmation_digest),
					poolId: String(row.pool_id),
					actionDigest: String(row.action_digest),
					principalDigest: String(row.principal_digest),
					issuedAt: String(row.issued_at),
					expiresAt: String(row.expires_at),
					commandId:
						row.command_id === null ? null : String(row.command_id),
				};
	}

	storeOpeningBalanceConfirmation(
		record: StoredOpeningBalanceConfirmation,
	): void {
		if (record.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		this.#storage.sql
			.exec(
				`INSERT INTO inventory_opening_balance_confirmations
				   (confirmation_digest, pool_id, action_digest, principal_digest,
				    issued_at, expires_at, command_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				record.confirmationDigest,
				record.poolId,
				record.actionDigest,
				record.principalDigest,
				record.issuedAt,
				record.expiresAt,
				record.commandId,
			)
			.toArray();
	}

	bindOpeningBalanceConfirmation(
		confirmationDigest: string,
		commandId: string,
	): void {
		const rows = this.#storage.sql
			.exec<SqlRow>(
			`UPDATE inventory_opening_balance_confirmations
			 SET command_id = ?
			 WHERE confirmation_digest = ? AND command_id IS NULL
			 RETURNING confirmation_digest`,
			commandId,
			confirmationDigest,
			)
			.toArray();
		if (rows.length !== 1) {
			throw new Error("Opening-balance confirmation binding failed.");
		}
	}

	storeRejection(record: StoredCommandResult): void {
		this.#storage.sql
			.exec(
				`INSERT INTO inventory_command_results
				   (command_id, command_digest, terminal_result_json)
				 VALUES (?, ?, ?)`,
				record.commandId,
				record.commandDigest,
				JSON.stringify(record.result),
			)
			.toArray();
	}

	commitOpeningBalance(input: OpeningBalanceCommit): void {
		this.#assertPool(input.balance);
		this.#storage.sql
			.exec(
				`INSERT INTO inventory_balances
				   (pool_id, location_id, sku_id, on_hand_value,
				    reserved_value, available_value, unit, version,
				    has_stock_history)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.balance.poolId,
				input.balance.locationId,
				input.balance.skuId,
				input.balance.onHand.value,
				input.balance.reserved.value,
				input.balance.available.value,
				input.balance.onHand.unit,
				Number(input.balance.version),
				input.balance.hasStockHistory ? 1 : 0,
			)
			.toArray();
		this.#storage.sql
			.exec(
				`INSERT INTO inventory_receipts
				   (receipt_id, command_id, receipt_json)
				 VALUES (?, ?, ?)`,
				input.receipt.receiptId,
				input.commandId,
				JSON.stringify(input.receipt),
			)
			.toArray();
		this.#storage.sql
			.exec(
				`INSERT INTO inventory_command_results
				   (command_id, command_digest, terminal_result_json)
				 VALUES (?, ?, ?)`,
				input.commandId,
				input.commandDigest,
				JSON.stringify(input.result),
			)
			.toArray();
	}
}

export class CloudflareSqliteInventoryStore implements InventoryStore {
	readonly #storage: DurableObjectStorage;
	readonly #poolId: string;

	constructor(
		options: Readonly<{
			storage: DurableObjectStorage;
			poolId: string;
		}>,
	) {
		if (options?.storage === undefined) {
			throw new TypeError("Durable Object storage is required.");
		}
		if (typeof options.poolId !== "string" || options.poolId.trim().length === 0) {
			throw new TypeError("An explicit pool ID is required.");
		}
		this.#storage = options.storage;
		this.#poolId = options.poolId.trim();
	}

	async runTransaction<T>(
		poolId: string,
		operation: (transaction: InventoryTransaction) => T,
	): Promise<T> {
		if (poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		return this.#storage.transactionSync(() => {
			const value = operation(
				new CloudflareSqliteInventoryTransaction(this.#storage, this.#poolId),
			);
			if (value instanceof Promise) {
				throw new TypeError(
					"Cloudflare SQLite transaction callbacks must be synchronous.",
				);
			}
			return value;
		});
	}

	async readBalance(key: SkuLocationKey): Promise<BalanceRecord | null> {
		if (key.poolId !== this.#poolId) {
			throw new Error("A store cannot read across inventory pools.");
		}
		return balanceFrom(
			first(
				this.#storage,
				`SELECT pool_id, location_id, sku_id, on_hand_value,
				        reserved_value, available_value, unit, version,
				        has_stock_history
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
				key.poolId,
				key.locationId,
				key.skuId,
			),
		);
	}

	async readCommand(commandId: string): Promise<StoredCommandResult | null> {
		return commandFrom(
			first(
				this.#storage,
				`SELECT command_id, command_digest, terminal_result_json
				 FROM inventory_command_results
				 WHERE command_id = ?`,
				commandId,
			),
		);
	}

	async readCommandByReceiptId(
		receiptId: string,
	): Promise<StoredCommandResult | null> {
		return commandFrom(
			first(
				this.#storage,
				`SELECT result.command_id, result.command_digest,
				        result.terminal_result_json
				 FROM inventory_receipts AS receipt
				 JOIN inventory_command_results AS result
				   ON result.command_id = receipt.command_id
				 WHERE receipt.receipt_id = ?`,
				receiptId,
			),
		);
	}

	async readReceipt(
		receiptId: string,
	): Promise<OpeningBalanceReceiptV2 | null> {
		const row = first(
			this.#storage,
			"SELECT receipt_json FROM inventory_receipts WHERE receipt_id = ?",
			receiptId,
		);
		return row === undefined
			? null
			: json<OpeningBalanceReceiptV2>(row.receipt_json);
	}

	async close(): Promise<void> {}
}

export function createCloudflareSqliteInventoryStore(
	options: Readonly<{
		storage: DurableObjectStorage;
		poolId: string;
	}>,
): CloudflareSqliteInventoryStore {
	return new CloudflareSqliteInventoryStore(options);
}
