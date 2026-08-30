import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
	BalanceRecord,
	SkuLocationKey,
} from "../domain/opening-balance.ts";
import { normalizeCommandPrincipal } from "../domain/opening-balance.ts";
import type {
	InventoryCommandResult,
	InventoryReceiptV2,
	LocationBalanceBlocker,
	LocationRecord,
} from "../domain/location-registry.ts";
import type { InventoryStockReceiptV2 } from "../domain/inventory-read.ts";
import type { ManagedSkuRecord } from "../features/managed-sku/index.ts";
import type {
	ActiveLocationBalanceSnapshot,
	InventoryStore,
	InventoryTransaction,
	ListLocationsQuery,
	ListReceiptsQuery,
	LocationCommit,
	ManagedSkuCommit,
	OpeningBalanceCommit,
	ReadManagedSkuQuery,
	ReadSkuActiveLocationSnapshotQuery,
	StoredOpeningBalanceConfirmation,
	StoredStockAdjustmentConfirmation,
	StoredCommandResult,
	StockAdjustmentCommit,
} from "./inventory-store.ts";

const STORAGE_ROLE = "local-development-test-only";
const SCHEMA_VERSION = "opening-balance-local/v6";
const EXPECTED_TABLES = [
	"inventory_balances",
	"inventory_command_results",
	"inventory_locations",
	"inventory_opening_balance_confirmations",
	"inventory_receipts",
	"inventory_skus",
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

function locationFrom(row: DatabaseRow | undefined): LocationRecord | null {
	if (row === undefined) {
		return null;
	}
	return {
		poolId: String(row.pool_id),
		locationId: String(row.location_id),
		name: String(row.name),
		nameKey: String(row.name_key),
		status: String(row.status) as LocationRecord["status"],
		version: String(row.version),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
		archivedAt: row.archived_at === null ? null : String(row.archived_at),
	};
}

function managedSkuFrom(row: DatabaseRow | undefined): ManagedSkuRecord | null {
	if (row === undefined) {
		return null;
	}
	return {
		poolId: String(row.pool_id),
		inventorySkuId: String(row.inventory_sku_id),
		sku: String(row.sku),
		displayName: String(row.display_name),
		unit: "each",
		version: "1",
		registeredAt: String(row.registered_at),
		registeredBy: normalizeCommandPrincipal(json(row.registered_by_json)),
	};
}

function activeLocationBalanceSnapshotFrom(
	row: DatabaseRow,
): ActiveLocationBalanceSnapshot {
	const location = locationFrom(row);
	if (location === null) {
		throw new Error("An active location snapshot row is required.");
	}
	const balance =
		row.balance_sku_id === null
			? null
			: {
					poolId: String(row.pool_id),
					locationId: String(row.location_id),
					skuId: String(row.balance_sku_id),
					onHand: {
						value: String(row.balance_on_hand_value),
						unit: String(row.balance_unit),
					},
					reserved: {
						value: String(row.balance_reserved_value),
						unit: String(row.balance_unit),
					},
					available: {
						value: String(row.balance_available_value),
						unit: String(row.balance_unit),
					},
					version: String(row.balance_version),
					hasStockHistory: Number(row.balance_has_stock_history) === 1,
				};
	return { location, balance };
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

	getCommand<TResult extends InventoryCommandResult = InventoryCommandResult>(
		commandId: string,
	): StoredCommandResult<TResult> | null {
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
			result: json<TResult>(row.terminal_result_json),
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

	getManagedSku(inventorySkuId: string): ManagedSkuRecord | null {
		return managedSkuFrom(
			this.#database
				.prepare(
					`SELECT pool_id, inventory_sku_id, sku, display_name, unit,
					        version, registered_at, registered_by_json
					 FROM inventory_skus
					 WHERE pool_id = ? AND inventory_sku_id = ?`,
				)
				.get(this.#poolId, inventorySkuId) as DatabaseRow | undefined,
		);
	}

	getManagedSkuBySku(sku: string): ManagedSkuRecord | null {
		return managedSkuFrom(
			this.#database
				.prepare(
					`SELECT pool_id, inventory_sku_id, sku, display_name, unit,
					        version, registered_at, registered_by_json
					 FROM inventory_skus
					 WHERE pool_id = ? AND sku = ?`,
				)
				.get(this.#poolId, sku) as DatabaseRow | undefined,
		);
	}

	getLocation(locationId: string): LocationRecord | null {
		return locationFrom(
			this.#database
				.prepare(
					`SELECT pool_id, location_id, name, name_key, status, version,
					        created_at, updated_at, archived_at
					 FROM inventory_locations
					 WHERE pool_id = ? AND location_id = ?`,
				)
				.get(this.#poolId, locationId) as DatabaseRow | undefined,
		);
	}

	getLocationByNameKey(nameKey: string): LocationRecord | null {
		return locationFrom(
			this.#database
				.prepare(
					`SELECT pool_id, location_id, name, name_key, status, version,
					        created_at, updated_at, archived_at
					 FROM inventory_locations
					 WHERE pool_id = ? AND name_key = ?`,
				)
				.get(this.#poolId, nameKey) as DatabaseRow | undefined,
		);
	}

	listLocationBalanceBlockers(
		locationId: string,
	): readonly LocationBalanceBlocker[] {
		const rows = this.#database
			.prepare(
				`SELECT sku_id, on_hand_value, reserved_value, unit
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ?
				   AND (on_hand_value <> '0' OR reserved_value <> '0')
				 ORDER BY sku_id`,
			)
			.all(this.#poolId, locationId) as DatabaseRow[];
		return rows.map((row) => ({
			skuId: String(row.sku_id),
			onHand: { value: String(row.on_hand_value), unit: String(row.unit) },
			reserved: { value: String(row.reserved_value), unit: String(row.unit) },
		}));
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

	getStockAdjustmentConfirmation(
		confirmationDigest: string,
	): StoredStockAdjustmentConfirmation | null {
		return this.getOpeningBalanceConfirmation(confirmationDigest);
	}

	storeStockAdjustmentConfirmation(
		record: StoredStockAdjustmentConfirmation,
	): void {
		this.storeOpeningBalanceConfirmation(record);
	}

	bindStockAdjustmentConfirmation(
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
			throw new Error("Stock-adjustment confirmation binding failed.");
		}
	}

	storeCommandResult(record: StoredCommandResult): void {
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

	storeRejection(record: StoredCommandResult): void {
		this.storeCommandResult(record);
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

	commitStockAdjustment(input: StockAdjustmentCommit): void {
		this.#assertPool(input.balance);
		const updated = this.#database
			.prepare(
				`UPDATE inventory_balances
				 SET on_hand_value = ?, reserved_value = ?, available_value = ?,
				     unit = ?, version = ?, has_stock_history = ?
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?
				   AND version = ? AND has_stock_history = 1`,
			)
			.run(
				input.balance.onHand.value,
				input.balance.reserved.value,
				input.balance.available.value,
				input.balance.onHand.unit,
				Number(input.balance.version),
				input.balance.hasStockHistory ? 1 : 0,
				input.balance.poolId,
				input.balance.locationId,
				input.balance.skuId,
				Number(input.previousVersion),
			);
		if (Number(updated.changes) !== 1) {
			throw new Error("Stock-adjustment balance update lost its target row.");
		}
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
		this.storeCommandResult(input);
	}

	commitLocation(input: LocationCommit): void {
		if (input.location.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		if (input.previous === null) {
			this.#database
				.prepare(
					`INSERT INTO inventory_locations
					   (pool_id, location_id, name, name_key, status, version,
					    created_at, updated_at, archived_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					input.location.poolId,
					input.location.locationId,
					input.location.name,
					input.location.nameKey,
					input.location.status,
					Number(input.location.version),
					input.location.createdAt,
					input.location.updatedAt,
					input.location.archivedAt,
				);
		} else {
			const updated = this.#database
				.prepare(
					`UPDATE inventory_locations
					 SET name = ?, name_key = ?, status = ?, version = ?,
					     updated_at = ?, archived_at = ?
					 WHERE pool_id = ? AND location_id = ?`,
				)
				.run(
					input.location.name,
					input.location.nameKey,
					input.location.status,
					Number(input.location.version),
					input.location.updatedAt,
					input.location.archivedAt,
					input.location.poolId,
					input.location.locationId,
				);
			if (Number(updated.changes) !== 1) {
				throw new Error("Location update lost its target row.");
			}
		}
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

	commitManagedSku(input: ManagedSkuCommit): void {
		if (input.sku.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		this.#database
			.prepare(
				`INSERT INTO inventory_skus
				   (pool_id, inventory_sku_id, sku, display_name, unit, version,
				    registered_at, registered_by_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.sku.poolId,
				input.sku.inventorySkuId,
				input.sku.sku,
				input.sku.displayName,
				input.sku.unit,
				Number(input.sku.version),
				input.sku.registeredAt,
				JSON.stringify(input.sku.registeredBy),
			);
		this.storeCommandResult(input);
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
			CREATE TABLE inventory_locations (
				pool_id TEXT NOT NULL,
				location_id TEXT NOT NULL,
				name TEXT NOT NULL,
				name_key TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
				version INTEGER NOT NULL CHECK (version >= 1),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				archived_at TEXT,
				PRIMARY KEY (pool_id, location_id),
				UNIQUE (pool_id, name_key),
				CHECK (
					(status = 'active' AND archived_at IS NULL) OR
					(status = 'archived' AND archived_at IS NOT NULL)
				)
			) STRICT;
			CREATE TABLE inventory_skus (
				pool_id TEXT NOT NULL,
				inventory_sku_id TEXT NOT NULL,
				sku TEXT NOT NULL,
				display_name TEXT NOT NULL,
				unit TEXT NOT NULL CHECK (unit = 'each'),
				version INTEGER NOT NULL CHECK (version = 1),
				registered_at TEXT NOT NULL,
				registered_by_json TEXT NOT NULL,
				PRIMARY KEY (pool_id, inventory_sku_id),
				UNIQUE (pool_id, sku)
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

	async readManagedSku(
		query: ReadManagedSkuQuery,
	): Promise<ManagedSkuRecord | null> {
		return managedSkuFrom(
			this.#openDatabase()
				.prepare(
					`SELECT pool_id, inventory_sku_id, sku, display_name, unit,
					        version, registered_at, registered_by_json
					 FROM inventory_skus
					 WHERE pool_id = ? AND inventory_sku_id = ?`,
				)
				.get(query.poolId, query.skuId) as DatabaseRow | undefined,
		);
	}

	async readSkuActiveLocationSnapshot(
		query: ReadSkuActiveLocationSnapshotQuery,
	): Promise<readonly ActiveLocationBalanceSnapshot[]> {
		const rows = this.#openDatabase()
			.prepare(
				`SELECT location.pool_id, location.location_id, location.name,
				        location.name_key, location.status, location.version,
				        location.created_at, location.updated_at,
				        location.archived_at,
				        balance.sku_id AS balance_sku_id,
				        balance.on_hand_value AS balance_on_hand_value,
				        balance.reserved_value AS balance_reserved_value,
				        balance.available_value AS balance_available_value,
				        balance.unit AS balance_unit,
				        balance.version AS balance_version,
				        balance.has_stock_history AS balance_has_stock_history
				 FROM inventory_locations AS location
				 LEFT JOIN inventory_balances AS balance
				   ON balance.pool_id = location.pool_id
				  AND balance.location_id = location.location_id
				  AND balance.sku_id = ?
				 WHERE location.pool_id = ? AND location.status = 'active'
				 ORDER BY location.name_key, location.location_id`,
			)
			.all(query.skuId, query.poolId) as DatabaseRow[];
		return rows.map(activeLocationBalanceSnapshotFrom);
	}

	async readCommand<
		TResult extends InventoryCommandResult = InventoryCommandResult,
	>(commandId: string): Promise<StoredCommandResult<TResult> | null> {
		const row = this.#openDatabase()
			.prepare(
				`SELECT command_id, command_digest, terminal_result_json
				 FROM inventory_command_results
				 WHERE command_id = ?`,
			)
			.get(commandId) as DatabaseRow | undefined;
		return row === undefined
			? null
			: {
					commandId: String(row.command_id),
					commandDigest: String(row.command_digest),
					result: json<TResult>(row.terminal_result_json),
				};
	}

	async readCommandByReceiptId<
		TResult extends InventoryCommandResult = InventoryCommandResult,
	>(
		receiptId: string,
	): Promise<StoredCommandResult<TResult> | null> {
		const row = this.#openDatabase()
			.prepare(
				`SELECT result.command_id, result.command_digest,
				        result.terminal_result_json
				 FROM inventory_receipts AS receipt
				 JOIN inventory_command_results AS result
				   ON result.command_id = receipt.command_id
				 WHERE receipt.receipt_id = ?`,
			)
			.get(receiptId) as DatabaseRow | undefined;
		return row === undefined
			? null
			: {
					commandId: String(row.command_id),
					commandDigest: String(row.command_digest),
					result: json<TResult>(row.terminal_result_json),
				};
	}

	async readReceipt(
		receiptId: string,
	): Promise<InventoryReceiptV2 | null> {
		const row = this.#openDatabase()
			.prepare(
				"SELECT receipt_json FROM inventory_receipts WHERE receipt_id = ?",
			)
			.get(receiptId) as DatabaseRow | undefined;
		return row === undefined
			? null
			: json<InventoryReceiptV2>(row.receipt_json);
	}

	async listReceipts(
		query: ListReceiptsQuery,
	): Promise<readonly InventoryStockReceiptV2[]> {
		const clauses = [
			"json_extract(receipt_json, '$.context.poolId') = ?",
			"json_extract(receipt_json, '$.type') IN ('stock.opening_balance', 'stock.adjust')",
		];
		const bindings: Array<string | number> = [query.poolId];
		if (query.locationId !== undefined) {
			clauses.push(
				`EXISTS (
					SELECT 1
					FROM json_each(inventory_receipts.receipt_json, '$.effects') AS effect
					WHERE json_extract(effect.value, '$.locationId') = ?
				)`,
			);
			bindings.push(query.locationId);
		}
		if (query.before !== undefined) {
			clauses.push(
				`(
					json_extract(receipt_json, '$.committedAt') < ? OR
					(
						json_extract(receipt_json, '$.committedAt') = ? AND
						receipt_id < ?
					)
				)`,
			);
			bindings.push(
				query.before.committedAt,
				query.before.committedAt,
				query.before.receiptId,
			);
		}
		bindings.push(query.limit);
		const rows = this.#openDatabase()
			.prepare(
				`SELECT receipt_json
				 FROM inventory_receipts
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY json_extract(receipt_json, '$.committedAt') DESC,
				          receipt_id DESC
				 LIMIT ?`,
			)
			.all(...bindings) as DatabaseRow[];
		return rows.map((row) =>
			json<InventoryStockReceiptV2>(row.receipt_json),
		);
	}

	async listLocations(
		query: ListLocationsQuery,
	): Promise<readonly LocationRecord[]> {
		const rows = this.#openDatabase()
			.prepare(
				`SELECT pool_id, location_id, name, name_key, status, version,
				        created_at, updated_at, archived_at
				 FROM inventory_locations
				 WHERE pool_id = ? AND status = ?
				 ORDER BY name_key, location_id`,
			)
			.all(query.poolId, query.status) as DatabaseRow[];
		return rows.map((row) => locationFrom(row) as LocationRecord);
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
