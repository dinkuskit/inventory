export const CLOUDFLARE_INVENTORY_SCHEMA =
	"dinkuskit.inventory.cloudflare-schema-status/v1" as const;
export const CLOUDFLARE_INVENTORY_SCHEMA_VERSION = 2 as const;

export const CLOUDFLARE_INVENTORY_TABLES = [
	"inventory_balances",
	"inventory_command_results",
	"inventory_locations",
	"inventory_opening_balance_confirmations",
	"inventory_receipts",
	"inventory_schema_migrations",
] as const;

export type CloudflareInventorySchemaStatus = Readonly<{
	schema: typeof CLOUDFLARE_INVENTORY_SCHEMA;
	version: typeof CLOUDFLARE_INVENTORY_SCHEMA_VERSION;
	tables: readonly string[];
}>;

export type CloudflareInventoryRecordCounts = Readonly<{
	balances: number;
	commandResults: number;
	confirmations: number;
	receipts: number;
}>;

type SqlRow = Record<string, SqlStorageValue>;

function inventoryTables(storage: DurableObjectStorage): string[] {
	return storage.sql
		.exec<SqlRow>(
			`SELECT name
			 FROM sqlite_schema
			 WHERE type = 'table' AND name LIKE 'inventory_%'
			 ORDER BY name`,
		)
		.toArray()
		.map((row) => String(row.name));
}

function assertExactSchema(storage: DurableObjectStorage): void {
	const migrations = storage.sql
		.exec<SqlRow>(
			`SELECT version
			 FROM inventory_schema_migrations
			 ORDER BY version`,
		)
		.toArray()
		.map((row) => Number(row.version));
	if (
		JSON.stringify(migrations) !==
		JSON.stringify([1, CLOUDFLARE_INVENTORY_SCHEMA_VERSION])
	) {
		throw new Error("Cloudflare Inventory schema migration history is invalid.");
	}
	if (
		JSON.stringify(inventoryTables(storage)) !==
		JSON.stringify(CLOUDFLARE_INVENTORY_TABLES)
	) {
		throw new Error("Cloudflare Inventory schema tables are incompatible.");
	}
}

export function initializeCloudflareInventorySchema(
	storage: DurableObjectStorage,
): void {
	storage.transactionSync(() => {
		storage.sql
			.exec(
				`CREATE TABLE IF NOT EXISTS inventory_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				) STRICT`,
			)
			.toArray();

		const versions = storage.sql
			.exec<SqlRow>(
				"SELECT version FROM inventory_schema_migrations ORDER BY version",
			)
			.toArray()
			.map((row) => Number(row.version));
		if (versions.length === 0) {
			storage.sql
				.exec(
					`CREATE TABLE inventory_command_results (
						command_id TEXT PRIMARY KEY,
						command_digest TEXT NOT NULL,
						terminal_result_json TEXT NOT NULL
					) STRICT`,
				)
				.toArray();
			storage.sql
				.exec(
					`CREATE TABLE inventory_balances (
						pool_id TEXT NOT NULL,
						location_id TEXT NOT NULL,
						sku_id TEXT NOT NULL,
						on_hand_value TEXT NOT NULL,
						reserved_value TEXT NOT NULL,
						available_value TEXT NOT NULL,
						unit TEXT NOT NULL,
						version INTEGER NOT NULL,
						has_stock_history INTEGER NOT NULL
							CHECK (has_stock_history IN (0, 1)),
						PRIMARY KEY (pool_id, location_id, sku_id)
					) STRICT`,
				)
				.toArray();
			storage.sql
				.exec(
					`CREATE TABLE inventory_receipts (
						receipt_id TEXT PRIMARY KEY,
						command_id TEXT NOT NULL UNIQUE,
						receipt_json TEXT NOT NULL
					) STRICT`,
				)
				.toArray();
			storage.sql
				.exec(
					`CREATE TABLE inventory_opening_balance_confirmations (
						confirmation_digest TEXT PRIMARY KEY,
						pool_id TEXT NOT NULL,
						action_digest TEXT NOT NULL,
						principal_digest TEXT NOT NULL,
						issued_at TEXT NOT NULL,
						expires_at TEXT NOT NULL,
						command_id TEXT UNIQUE,
						FOREIGN KEY (command_id)
							REFERENCES inventory_command_results(command_id)
					) STRICT`,
				)
				.toArray();
			storage.sql
				.exec(
					`INSERT INTO inventory_schema_migrations (version, applied_at)
					 VALUES (?, ?)`,
					1,
					"2026-08-28T00:00:00.000Z",
				)
				.toArray();
		}

		const currentVersions = storage.sql
			.exec<SqlRow>(
				"SELECT version FROM inventory_schema_migrations ORDER BY version",
			)
			.toArray()
			.map((row) => Number(row.version));
		if (JSON.stringify(currentVersions) === JSON.stringify([1])) {
			storage.sql
				.exec(
					`CREATE TABLE inventory_locations (
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
					) STRICT`,
				)
				.toArray();
			storage.sql
				.exec(
					`INSERT INTO inventory_schema_migrations (version, applied_at)
					 VALUES (?, ?)`,
					CLOUDFLARE_INVENTORY_SCHEMA_VERSION,
					"2026-08-28T16:00:00.000Z",
				)
				.toArray();
		}
		assertExactSchema(storage);
	});
}

export function readCloudflareInventorySchemaStatus(
	storage: DurableObjectStorage,
): CloudflareInventorySchemaStatus {
	assertExactSchema(storage);
	return {
		schema: CLOUDFLARE_INVENTORY_SCHEMA,
		version: CLOUDFLARE_INVENTORY_SCHEMA_VERSION,
		tables: inventoryTables(storage),
	};
}

function rowCount(storage: DurableObjectStorage, table: string): number {
	const allowed = new Set([
		"inventory_balances",
		"inventory_command_results",
		"inventory_opening_balance_confirmations",
		"inventory_receipts",
	]);
	if (!allowed.has(table)) {
		throw new Error("Unsupported Inventory table count.");
	}
	return Number(storage.sql.exec<SqlRow>(`SELECT count(*) AS count FROM ${table}`).one().count);
}

export function readCloudflareInventoryRecordCounts(
	storage: DurableObjectStorage,
): CloudflareInventoryRecordCounts {
	return {
		balances: rowCount(storage, "inventory_balances"),
		commandResults: rowCount(storage, "inventory_command_results"),
		confirmations: rowCount(
			storage,
			"inventory_opening_balance_confirmations",
		),
		receipts: rowCount(storage, "inventory_receipts"),
	};
}
