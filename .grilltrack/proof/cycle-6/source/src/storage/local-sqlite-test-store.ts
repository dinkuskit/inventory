import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
	BalanceRecord,
	OpeningBalanceReceiptV1,
	OpeningBalanceResult,
	SkuLocationKey,
} from "../domain/opening-balance.ts";
import type {
	InventoryStore,
	InventoryTransaction,
	OpeningBalanceCommit,
	StoredOpeningBalanceConfirmation,
	StoredCommandResult,
} from "./inventory-store.ts";

const STORAGE_ROLE = "local-development-test-only";
const SCHEMA_VERSION = "opening-balance-local/v2";
const EXPECTED_TABLES = [
	"inventory_balances",
	"inventory_command_results",
	"inventory_opening_balance_confirmations",
	"inventory_receipts",
	"inventory_storage_metadata",
] as const;

type DatabaseRow = Record<string, unknown>;

function json<T>(value: unknown): T {
	return JSON.parse(String(value)) as T;
}

function balanceFrom(row: DatabaseRow | undefined): BalanceRecord | null {
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

class SqliteInventoryTransaction implements InventoryTransaction {
	readonly #database: DatabaseSync;
	readonly #poolId: string;

	constructor(database: DatabaseSync, poolId: string) {
		this.#database = database;
		this.#poolId = poolId;
	}

	#assertPool(key: SkuLocationKey): void {
		if (key.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
	}

	getCommand(commandId: string): StoredCommandResult | null {
		const row = this.#database
			.prepare(
				`SELECT command_id, command_digest, terminal_result_json
				 FROM inventory_command_results
				 WHERE command_id = ?`,
			)
			.get(commandId) as DatabaseRow | undefined;
		if (row === undefined) {
			return null;
		}
		return {
			commandId: String(row.command_id),
			commandDigest: String(row.command_digest),
			result: json<OpeningBalanceResult>(row.terminal_result_json),
		};
	}

	getBalance(key: SkuLocationKey): BalanceRecord | null {
		this.#assertPool(key);
		const row = this.#database
			.prepare(
				`SELECT pool_id, location_id, sku_id, on_hand_value,
				        reserved_value, available_value, unit, version,
				        has_stock_history
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
			)
			.get(key.poolId, key.locationId, key.skuId) as
			| DatabaseRow
			| undefined;
		return balanceFrom(row);
	}

	getOpeningBalanceConfirmation(
		confirmationDigest: string,
	): StoredOpeningBalanceConfirmation | null {
		const row = this.#database
			.prepare(
				`SELECT confirmation_digest, pool_id, action_digest,
				        principal_digest, issued_at, expires_at, command_id
				 FROM inventory_opening_balance_confirmations
				 WHERE confirmation_digest = ?`,
			)
			.get(confirmationDigest) as DatabaseRow | undefined;
		if (row === undefined) {
			return null;
		}
		return {
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
		this.#database
			.prepare(
				`INSERT INTO inventory_opening_balance_confirmations
				   (confirmation_digest, pool_id, action_digest, principal_digest,
				    issued_at, expires_at, command_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.confirmationDigest,
				record.poolId,
				record.actionDigest,
				record.principalDigest,
				record.issuedAt,
				record.expiresAt,
				record.commandId,
			);
	}

	bindOpeningBalanceConfirmation(
		confirmationDigest: string,
		commandId: string,
	): void {
		const result = this.#database
			.prepare(
				`UPDATE inventory_opening_balance_confirmations
				 SET command_id = ?
				 WHERE confirmation_digest = ? AND command_id IS NULL`,
			)
			.run(commandId, confirmationDigest);
		if (Number(result.changes) !== 1) {
			throw new Error("Opening-balance confirmation binding failed.");
		}
	}

	storeRejection(record: StoredCommandResult): void {
		this.#database
			.prepare(
				`INSERT INTO inventory_command_results
				   (command_id, command_digest, terminal_result_json)
				 VALUES (?, ?, ?)`,
			)
			.run(
				record.commandId,
				record.commandDigest,
				JSON.stringify(record.result),
			);
	}

	commitOpeningBalance(input: OpeningBalanceCommit): void {
		this.#assertPool(input.balance);
		this.#database
			.prepare(
				`INSERT INTO inventory_balances
				   (pool_id, location_id, sku_id, on_hand_value,
				    reserved_value, available_value, unit, version,
				    has_stock_history)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.balance.poolId,
				input.balance.locationId,
				input.balance.skuId,
				input.balance.onHand.value,
				input.balance.reserved.value,
				input.balance.available.value,
				input.balance.onHand.unit,
				Number(input.balance.version),
				input.balance.hasStockHistory ? 1 : 0,
			);
		this.#database
			.prepare(
				`INSERT INTO inventory_receipts
				   (receipt_id, command_id, receipt_json)
				 VALUES (?, ?, ?)`,
			)
			.run(
				input.receipt.receiptId,
				input.commandId,
				JSON.stringify(input.receipt),
			);
		this.#database
			.prepare(
				`INSERT INTO inventory_command_results
				   (command_id, command_digest, terminal_result_json)
				 VALUES (?, ?, ?)`,
			)
			.run(
				input.commandId,
				input.commandDigest,
				JSON.stringify(input.result),
			);
	}
}

export class LocalSqliteTestInventoryStore implements InventoryStore {
	#database: DatabaseSync | null;

	constructor({ filePath }: Readonly<{ filePath: string }>) {
		if (
			typeof filePath !== "string" ||
			filePath === ":memory:" ||
			!isAbsolute(filePath)
		) {
			throw new TypeError(
				"Test SQLite storage requires an explicit absolute file path.",
			);
		}
		if (process.env.NODE_ENV === "production") {
			throw new Error("Local SQLite storage is development and test only.");
		}

		this.#database = null;
		const database = new DatabaseSync(filePath);
		try {
			database.exec(`
				PRAGMA foreign_keys = ON;
				PRAGMA busy_timeout = 5000;
			`);
			const existingTables = database
				.prepare(
					`SELECT name
					 FROM sqlite_master
					 WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
					 ORDER BY name`,
				)
				.all()
				.map((row) => String((row as DatabaseRow).name));

			if (existingTables.length === 0) {
				database.exec(`
			CREATE TABLE inventory_storage_metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			) STRICT;
			CREATE TABLE inventory_command_results (
				command_id TEXT PRIMARY KEY,
				command_digest TEXT NOT NULL,
				terminal_result_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE inventory_balances (
				pool_id TEXT NOT NULL,
				location_id TEXT NOT NULL,
				sku_id TEXT NOT NULL,
				on_hand_value TEXT NOT NULL,
				reserved_value TEXT NOT NULL,
				available_value TEXT NOT NULL,
				unit TEXT NOT NULL,
				version INTEGER NOT NULL,
				has_stock_history INTEGER NOT NULL CHECK (has_stock_history IN (0, 1)),
				PRIMARY KEY (pool_id, location_id, sku_id)
			) STRICT;
			CREATE TABLE inventory_receipts (
				receipt_id TEXT PRIMARY KEY,
				command_id TEXT NOT NULL UNIQUE,
				receipt_json TEXT NOT NULL
			) STRICT;
			CREATE TABLE inventory_opening_balance_confirmations (
				confirmation_digest TEXT PRIMARY KEY,
				pool_id TEXT NOT NULL,
				action_digest TEXT NOT NULL,
				principal_digest TEXT NOT NULL,
				issued_at TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				command_id TEXT UNIQUE,
				FOREIGN KEY (command_id)
					REFERENCES inventory_command_results(command_id)
			) STRICT;
			`);
				const metadata = database.prepare(
					`INSERT INTO inventory_storage_metadata (key, value)
			 VALUES (?, ?)`,
				);
				metadata.run("storage_role", STORAGE_ROLE);
				metadata.run("schema_version", SCHEMA_VERSION);
			} else {
				if (!existingTables.includes("inventory_storage_metadata")) {
					throw new Error(
						"SQLite file is not an Inventory local-test database.",
					);
				}
				const metadataRows = database
					.prepare(
						"SELECT key, value FROM inventory_storage_metadata WHERE key IN ('storage_role', 'schema_version')",
					)
					.all() as DatabaseRow[];
				const metadata = new Map(
					metadataRows.map((row) => [String(row.key), String(row.value)]),
				);
				if (metadata.get("storage_role") !== STORAGE_ROLE) {
					throw new Error(
						"SQLite file is not an Inventory local-test database.",
					);
				}
				if (
					metadata.get("schema_version") !== SCHEMA_VERSION ||
					JSON.stringify(existingTables) !== JSON.stringify(EXPECTED_TABLES)
				) {
					throw new Error(
						"SQLite file uses an incompatible Inventory local-test schema.",
					);
				}
			}
			this.#database = database;
		} catch (error) {
			database.close();
			throw error;
		}
	}

	#openDatabase(): DatabaseSync {
		if (this.#database === null) {
			throw new Error("Inventory store is closed.");
		}
		return this.#database;
	}

	async runTransaction<T>(
		poolId: string,
		operation: (transaction: InventoryTransaction) => T,
	): Promise<T> {
		const database = this.#openDatabase();
		database.exec("BEGIN IMMEDIATE");
		try {
			const value = operation(
				new SqliteInventoryTransaction(database, poolId),
			);
			if (value instanceof Promise) {
				throw new TypeError(
					"Local SQLite transaction callbacks must be synchronous.",
				);
			}
			database.exec("COMMIT");
			return value;
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
	}

	async readBalance(key: SkuLocationKey): Promise<BalanceRecord | null> {
		const row = this.#openDatabase()
			.prepare(
				`SELECT pool_id, location_id, sku_id, on_hand_value,
				        reserved_value, available_value, unit, version,
				        has_stock_history
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
			)
			.get(key.poolId, key.locationId, key.skuId) as
			| DatabaseRow
			| undefined;
		return balanceFrom(row);
	}

	async readReceipt(
		receiptId: string,
	): Promise<OpeningBalanceReceiptV1 | null> {
		const row = this.#openDatabase()
			.prepare(
				"SELECT receipt_json FROM inventory_receipts WHERE receipt_id = ?",
			)
			.get(receiptId) as DatabaseRow | undefined;
		return row === undefined
			? null
			: json<OpeningBalanceReceiptV1>(row.receipt_json);
	}

	async close(): Promise<void> {
		if (this.#database !== null) {
			this.#database.close();
			this.#database = null;
		}
	}
}

export function createLocalSqliteTestStore(
	options: Readonly<{ filePath: string }>,
): LocalSqliteTestInventoryStore {
	return new LocalSqliteTestInventoryStore(options);
}
