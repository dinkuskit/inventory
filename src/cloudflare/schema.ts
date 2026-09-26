export const CLOUDFLARE_INVENTORY_SCHEMA =
	"dinkuskit.inventory.cloudflare-schema-status/v1" as const;
export const CLOUDFLARE_INVENTORY_SCHEMA_VERSION = 7 as const;

const CLOUDFLARE_INVENTORY_V2_TABLES = [
	"inventory_balances",
	"inventory_command_results",
	"inventory_locations",
	"inventory_opening_balance_confirmations",
	"inventory_receipts",
	"inventory_schema_migrations",
] as const;

const CLOUDFLARE_INVENTORY_V3_TABLES = [
	...CLOUDFLARE_INVENTORY_V2_TABLES,
	"inventory_skus",
].sort();

const V3_MIGRATION_APPLIED_AT = "2026-08-28T22:38:50.000Z";
const V3_MIGRATION_PRINCIPAL_JSON = JSON.stringify({
	kind: "system",
	id: "inventory_schema_migration_v3",
	surface: "cloudflare_durable_object",
});
const V4_MIGRATION_APPLIED_AT = "2026-08-29T16:30:00.000Z";
const V5_MIGRATION_APPLIED_AT = "2026-09-25T19:48:00.000Z";
const V6_MIGRATION_APPLIED_AT = "2026-09-25T20:55:00.000Z";
const V7_MIGRATION_APPLIED_AT = "2026-09-26T02:44:00.000Z";

export const CLOUDFLARE_INVENTORY_V4_TABLES = [
	"inventory_balances",
	"inventory_command_results",
	"inventory_locations",
	"inventory_opening_balance_confirmations",
	"inventory_receipts",
	"inventory_schema_migrations",
	"inventory_skus",
	"inventory_transfers",
] as const;

export const CLOUDFLARE_INVENTORY_TABLES = [
	...CLOUDFLARE_INVENTORY_V4_TABLES,
	"inventory_reservations",
].sort();

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
	reservations: number;
	skus: number;
	transfers: number;
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

function migrationVersions(storage: DurableObjectStorage): number[] {
	return storage.sql
		.exec<SqlRow>(
			`SELECT version
			 FROM inventory_schema_migrations
			 ORDER BY version`,
		)
		.toArray()
		.map((row) => Number(row.version));
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function assertExactSchema(storage: DurableObjectStorage): void {
	const migrations = migrationVersions(storage);
	if (
		![
			["7"],
			["6", "7"],
			["5", "6", "7"],
			["4", "5", "6", "7"],
			["3", "4", "5", "6", "7"],
			["2", "3", "4", "5", "6", "7"],
		].some((expected) => sameStrings(migrations.map(String), expected))
	) {
		throw new Error("Cloudflare Inventory schema migration history is invalid.");
	}
	if (!sameStrings(inventoryTables(storage), [...CLOUDFLARE_INVENTORY_TABLES])) {
		throw new Error("Cloudflare Inventory schema tables are incompatible.");
	}
}

function assertV4Schema(storage: DurableObjectStorage): void {
	const versions = migrationVersions(storage).map(String);
	if (
		!sameStrings(versions, ["4"]) &&
		!sameStrings(versions, ["3", "4"]) &&
		!sameStrings(versions, ["2", "3", "4"])
	) {
		throw new Error("Cloudflare Inventory v4 migration history is invalid.");
	}
	if (!sameStrings(inventoryTables(storage), [...CLOUDFLARE_INVENTORY_V4_TABLES])) {
		throw new Error("Cloudflare Inventory v4 schema tables are incompatible.");
	}
}

function createManagedSkuTable(storage: DurableObjectStorage): void {
	storage.sql
		.exec(
			`CREATE TABLE inventory_skus (
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
			) STRICT`,
		)
		.toArray();
}

function createStockTransferTable(storage: DurableObjectStorage): void {
	storage.sql
		.exec(
			`CREATE TABLE inventory_transfers (
				pool_id TEXT NOT NULL,
				transfer_id TEXT NOT NULL,
				reference_key TEXT NOT NULL,
				status TEXT NOT NULL
					CHECK (status IN ('created', 'in_transit', 'received', 'canceled')),
				version INTEGER NOT NULL CHECK (version >= 1),
				transfer_json TEXT NOT NULL,
				PRIMARY KEY (pool_id, transfer_id),
				UNIQUE (pool_id, reference_key)
			) STRICT`,
		)
		.toArray();
}

function createReservationTable(storage: DurableObjectStorage): void {
	storage.sql
		.exec(
			`CREATE TABLE inventory_reservations (
				pool_id TEXT NOT NULL,
				reservation_id TEXT NOT NULL,
				order_line_key TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('active', 'partially_packed', 'canceled', 'packed')),
				version INTEGER NOT NULL CHECK (version >= 1),
				reservation_json TEXT NOT NULL,
				PRIMARY KEY (pool_id, reservation_id)
			) STRICT`,
		)
		.toArray();
	storage.sql
		.exec(
			`CREATE UNIQUE INDEX inventory_reservations_active_order_line
			 ON inventory_reservations (pool_id, order_line_key)
			 WHERE status IN ('active', 'partially_packed')`,
		)
		.toArray();
}

function assertV3Schema(storage: DurableObjectStorage): void {
	const versions = migrationVersions(storage).map(String);
	if (
		!sameStrings(versions, ["3"]) &&
		!sameStrings(versions, ["2", "3"])
	) {
		throw new Error("Cloudflare Inventory v3 migration history is invalid.");
	}
	if (!sameStrings(inventoryTables(storage), CLOUDFLARE_INVENTORY_V3_TABLES)) {
		throw new Error("Cloudflare Inventory v3 schema tables are incompatible.");
	}
}

function migrateV2ToV3(storage: DurableObjectStorage): void {
	if (!sameStrings(migrationVersions(storage).map(String), ["2"])) {
		throw new Error("Cloudflare Inventory v2 migration history is invalid.");
	}
	const legacyUnits = storage.sql
		.exec<SqlRow>(
			`SELECT pool_id, sku_id, min(unit) AS unit,
			        count(DISTINCT unit) AS unit_count
			 FROM inventory_balances
			 GROUP BY pool_id, sku_id`,
		)
		.toArray();
	if (
		legacyUnits.some(
			(row) => Number(row.unit_count) !== 1 || String(row.unit) !== "each",
		)
	) {
		throw new Error(
			"Cloudflare Inventory v2 balances cannot be migrated to the each-only SKU registry.",
		);
	}

	createManagedSkuTable(storage);
	storage.sql
		.exec(
			`INSERT INTO inventory_skus (
				pool_id, inventory_sku_id, sku, display_name, unit, version,
				registered_at, registered_by_json
			)
			SELECT pool_id, sku_id, sku_id, sku_id, min(unit), 1, ?, ?
			FROM inventory_balances
			GROUP BY pool_id, sku_id`,
			V3_MIGRATION_APPLIED_AT,
			V3_MIGRATION_PRINCIPAL_JSON,
		)
		.toArray();
	storage.sql
		.exec(
			`INSERT INTO inventory_schema_migrations (version, applied_at)
			 VALUES (?, ?)`,
			3,
			V3_MIGRATION_APPLIED_AT,
		)
		.toArray();
	assertV3Schema(storage);
}

function migrateV3ToV4(storage: DurableObjectStorage): void {
	assertV3Schema(storage);
	storage.sql
		.exec(
			`ALTER TABLE inventory_balances
			 ADD COLUMN outgoing_transfer_committed_value TEXT NOT NULL DEFAULT '0'`,
		)
		.toArray();
	storage.sql
		.exec(
			`ALTER TABLE inventory_balances
			 ADD COLUMN expected_value TEXT NOT NULL DEFAULT '0'`,
		)
		.toArray();
	storage.sql
		.exec(
			`ALTER TABLE inventory_balances
			 ADD COLUMN in_transit_value TEXT NOT NULL DEFAULT '0'`,
		)
		.toArray();
	createStockTransferTable(storage);
	storage.sql
		.exec(
			`INSERT INTO inventory_schema_migrations (version, applied_at)
			 VALUES (?, ?)`,
			4,
			V4_MIGRATION_APPLIED_AT,
		)
		.toArray();
	assertV4Schema(storage);
}

function migrateV4ToV5(storage: DurableObjectStorage): void {
	assertV4Schema(storage);
	createReservationTable(storage);
	storage.sql
		.exec(
			`INSERT INTO inventory_schema_migrations (version, applied_at)
			 VALUES (?, ?)`,
			5,
			V5_MIGRATION_APPLIED_AT,
		)
		.toArray();
}

function reservationJsonWithOriginalQuantity(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Cloudflare Inventory reservation JSON is invalid.");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Cloudflare Inventory reservation JSON is invalid.");
	}
	const record = parsed as Record<string, unknown>;
	const quantity = record.quantity;
	const originalQuantity =
		record.originalQuantity !== undefined && record.originalQuantity !== null
			? record.originalQuantity
			: quantity;
	return JSON.stringify({
		...record,
		originalQuantity,
	});
}

function reservationJsonWithPackedLifecycle(raw: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Cloudflare Inventory reservation JSON is invalid.");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Cloudflare Inventory reservation JSON is invalid.");
	}
	const record = parsed as Record<string, unknown>;
	return JSON.stringify({
		...record,
		packedAt: record.packedAt ?? null,
		packedBy: record.packedBy ?? null,
	});
}

function migrateV5ToV6(storage: DurableObjectStorage): void {
	const legacyRows = storage.sql
		.exec(
			`SELECT pool_id, reservation_id, order_line_key, status, version, reservation_json
			 FROM inventory_reservations`,
		)
		.toArray();
	storage.sql
		.exec(
			`CREATE TABLE inventory_reservations_v6 (
				pool_id TEXT NOT NULL,
				reservation_id TEXT NOT NULL,
				order_line_key TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('active', 'canceled', 'packed')),
				version INTEGER NOT NULL CHECK (version >= 1),
				reservation_json TEXT NOT NULL,
				PRIMARY KEY (pool_id, reservation_id)
			) STRICT`,
		)
		.toArray();
	for (const row of legacyRows) {
		storage.sql
			.exec(
				`INSERT INTO inventory_reservations_v6
				   (pool_id, reservation_id, order_line_key, status, version, reservation_json)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				String(row.pool_id),
				String(row.reservation_id),
				String(row.order_line_key),
				String(row.status),
				Number(row.version),
				reservationJsonWithPackedLifecycle(String(row.reservation_json)),
			)
			.toArray();
	}
	storage.sql.exec("DROP TABLE inventory_reservations").toArray();
	storage.sql
		.exec("ALTER TABLE inventory_reservations_v6 RENAME TO inventory_reservations")
		.toArray();
	storage.sql
		.exec(
			`CREATE UNIQUE INDEX inventory_reservations_active_order_line
			 ON inventory_reservations (pool_id, order_line_key)
			 WHERE status = 'active'`,
		)
		.toArray();
	storage.sql
		.exec(
			`INSERT INTO inventory_schema_migrations (version, applied_at)
			 VALUES (?, ?)`,
			6,
			V6_MIGRATION_APPLIED_AT,
		)
		.toArray();
}

function migrateV6ToV7(storage: DurableObjectStorage): void {
	const legacyRows = storage.sql
		.exec(
			`SELECT pool_id, reservation_id, order_line_key, status, version, reservation_json
			 FROM inventory_reservations`,
		)
		.toArray();
	storage.sql
		.exec(
			`CREATE TABLE inventory_reservations_v7 (
				pool_id TEXT NOT NULL,
				reservation_id TEXT NOT NULL,
				order_line_key TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('active', 'partially_packed', 'canceled', 'packed')),
				version INTEGER NOT NULL CHECK (version >= 1),
				reservation_json TEXT NOT NULL,
				PRIMARY KEY (pool_id, reservation_id)
			) STRICT`,
		)
		.toArray();
	for (const row of legacyRows) {
		storage.sql
			.exec(
				`INSERT INTO inventory_reservations_v7
				   (pool_id, reservation_id, order_line_key, status, version, reservation_json)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				String(row.pool_id),
				String(row.reservation_id),
				String(row.order_line_key),
				String(row.status),
				Number(row.version),
				reservationJsonWithOriginalQuantity(String(row.reservation_json)),
			)
			.toArray();
	}
	storage.sql.exec("DROP TABLE inventory_reservations").toArray();
	storage.sql
		.exec("ALTER TABLE inventory_reservations_v7 RENAME TO inventory_reservations")
		.toArray();
	storage.sql
		.exec(
			`CREATE UNIQUE INDEX inventory_reservations_active_order_line
			 ON inventory_reservations (pool_id, order_line_key)
			 WHERE status IN ('active', 'partially_packed')`,
		)
		.toArray();
	storage.sql
		.exec(
			`INSERT INTO inventory_schema_migrations (version, applied_at)
			 VALUES (?, ?)`,
			7,
			V7_MIGRATION_APPLIED_AT,
		)
		.toArray();
	assertExactSchema(storage);
}

export function initializeCloudflareInventorySchema(
	storage: DurableObjectStorage,
): void {
	storage.transactionSync(() => {
		const existingTables = inventoryTables(storage);
		if (existingTables.length > 0) {
			if (sameStrings(existingTables, [...CLOUDFLARE_INVENTORY_TABLES])) {
				const versions = migrationVersions(storage);
				if (versions.includes(7)) {
					assertExactSchema(storage);
					return;
				}
				if (versions.includes(6)) {
					migrateV6ToV7(storage);
					return;
				}
				if (versions.at(-1) === 5) {
					migrateV5ToV6(storage);
					migrateV6ToV7(storage);
					return;
				}
				throw new Error("Cloudflare Inventory schema migration history is invalid.");
			}
			if (sameStrings(existingTables, [...CLOUDFLARE_INVENTORY_V4_TABLES])) {
				migrateV4ToV5(storage);
				migrateV5ToV6(storage);
				migrateV6ToV7(storage);
				return;
			}
			if (sameStrings(existingTables, CLOUDFLARE_INVENTORY_V3_TABLES)) {
				migrateV3ToV4(storage);
				migrateV4ToV5(storage);
				migrateV5ToV6(storage);
				migrateV6ToV7(storage);
				return;
			}
			if (sameStrings(existingTables, CLOUDFLARE_INVENTORY_V2_TABLES)) {
				migrateV2ToV3(storage);
				migrateV3ToV4(storage);
				migrateV4ToV5(storage);
				migrateV5ToV6(storage);
				migrateV6ToV7(storage);
				return;
			}
			throw new Error(
				"Cloudflare Inventory storage uses an older or incompatible schema.",
			);
		}

		storage.sql
			.exec(
				`CREATE TABLE inventory_schema_migrations (
					version INTEGER PRIMARY KEY,
					applied_at TEXT NOT NULL
				) STRICT`,
			)
			.toArray();
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
					outgoing_transfer_committed_value TEXT NOT NULL DEFAULT '0',
					available_value TEXT NOT NULL,
					expected_value TEXT NOT NULL DEFAULT '0',
					in_transit_value TEXT NOT NULL DEFAULT '0',
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
		createManagedSkuTable(storage);
		createStockTransferTable(storage);
		createReservationTable(storage);
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
				CLOUDFLARE_INVENTORY_SCHEMA_VERSION,
				V7_MIGRATION_APPLIED_AT,
			)
			.toArray();
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
		"inventory_reservations",
		"inventory_skus",
		"inventory_transfers",
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
		reservations: rowCount(storage, "inventory_reservations"),
		skus: rowCount(storage, "inventory_skus"),
		transfers: rowCount(storage, "inventory_transfers"),
	};
}
