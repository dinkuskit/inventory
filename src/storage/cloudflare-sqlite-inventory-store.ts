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
	ReadStockTransferInput,
	StockTransferRecord,
} from "../features/stock-transfer/index.ts";
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
	StoredCommandResult,
	StoredOpeningBalanceConfirmation,
	StoredStockAdjustmentConfirmation,
	StockAdjustmentCommit,
	StockTransferCommit,
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
		outgoingTransferCommitted: {
			value: String(row.outgoing_transfer_committed_value),
			unit,
		},
		available: { value: String(row.available_value), unit },
		expected: { value: String(row.expected_value), unit },
		inTransit: { value: String(row.in_transit_value), unit },
		version: String(row.version),
		hasStockHistory: Number(row.has_stock_history) === 1,
	};
}

function stockTransferFrom(row: SqlRow | undefined): StockTransferRecord | null {
	return row === undefined
		? null
		: json<StockTransferRecord>(row.transfer_json);
}

function locationFrom(row: SqlRow | undefined): LocationRecord | null {
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

function managedSkuFrom(row: SqlRow | undefined): ManagedSkuRecord | null {
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
	row: SqlRow,
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
					outgoingTransferCommitted: {
						value: String(row.balance_outgoing_transfer_committed_value),
						unit: String(row.balance_unit),
					},
					available: {
						value: String(row.balance_available_value),
						unit: String(row.balance_unit),
					},
					expected: {
						value: String(row.balance_expected_value),
						unit: String(row.balance_unit),
					},
					inTransit: {
						value: String(row.balance_in_transit_value),
						unit: String(row.balance_unit),
					},
					version: String(row.balance_version),
					hasStockHistory: Number(row.balance_has_stock_history) === 1,
				};
	return { location, balance };
}

function commandFrom<
	TResult extends InventoryCommandResult = InventoryCommandResult,
>(row: SqlRow | undefined): StoredCommandResult<TResult> | null {
	return row === undefined
		? null
		: {
				commandId: String(row.command_id),
				commandDigest: String(row.command_digest),
				result: json<TResult>(row.terminal_result_json),
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

	getCommand<TResult extends InventoryCommandResult = InventoryCommandResult>(
		commandId: string,
	): StoredCommandResult<TResult> | null {
		return commandFrom<TResult>(
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
				        reserved_value, outgoing_transfer_committed_value,
				        available_value, expected_value, in_transit_value,
				        unit, version,
				        has_stock_history
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
				key.poolId,
				key.locationId,
				key.skuId,
			),
		);
	}

	getManagedSku(inventorySkuId: string): ManagedSkuRecord | null {
		return managedSkuFrom(
			first(
				this.#storage,
				`SELECT pool_id, inventory_sku_id, sku, display_name, unit,
				        version, registered_at, registered_by_json
				 FROM inventory_skus
				 WHERE pool_id = ? AND inventory_sku_id = ?`,
				this.#poolId,
				inventorySkuId,
			),
		);
	}

	getManagedSkuBySku(sku: string): ManagedSkuRecord | null {
		return managedSkuFrom(
			first(
				this.#storage,
				`SELECT pool_id, inventory_sku_id, sku, display_name, unit,
				        version, registered_at, registered_by_json
				 FROM inventory_skus
				 WHERE pool_id = ? AND sku = ?`,
				this.#poolId,
				sku,
			),
		);
	}

	getStockTransfer(transferId: string): StockTransferRecord | null {
		return stockTransferFrom(
			first(
				this.#storage,
				`SELECT transfer_json
				 FROM inventory_transfers
				 WHERE pool_id = ? AND transfer_id = ?`,
				this.#poolId,
				transferId,
			),
		);
	}

	getStockTransferByReferenceKey(
		referenceKey: string,
	): StockTransferRecord | null {
		return stockTransferFrom(
			first(
				this.#storage,
				`SELECT transfer_json
				 FROM inventory_transfers
				 WHERE pool_id = ? AND reference_key = ?`,
				this.#poolId,
				referenceKey,
			),
		);
	}

	getLocation(locationId: string): LocationRecord | null {
		return locationFrom(
			first(
				this.#storage,
				`SELECT pool_id, location_id, name, name_key, status, version,
				        created_at, updated_at, archived_at
				 FROM inventory_locations
				 WHERE pool_id = ? AND location_id = ?`,
				this.#poolId,
				locationId,
			),
		);
	}

	getLocationByNameKey(nameKey: string): LocationRecord | null {
		return locationFrom(
			first(
				this.#storage,
				`SELECT pool_id, location_id, name, name_key, status, version,
				        created_at, updated_at, archived_at
				 FROM inventory_locations
				 WHERE pool_id = ? AND name_key = ?`,
				this.#poolId,
				nameKey,
			),
		);
	}

	listLocationBalanceBlockers(
		locationId: string,
	): readonly LocationBalanceBlocker[] {
		return this.#storage.sql
			.exec<SqlRow>(
				`SELECT sku_id, on_hand_value, reserved_value,
				        outgoing_transfer_committed_value, expected_value,
				        in_transit_value, unit
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ?
				   AND (
				     on_hand_value <> '0' OR reserved_value <> '0' OR
				     outgoing_transfer_committed_value <> '0' OR
				     expected_value <> '0' OR in_transit_value <> '0'
				   )
				 ORDER BY sku_id`,
				this.#poolId,
				locationId,
			)
			.toArray()
			.map((row) => ({
				skuId: String(row.sku_id),
				onHand: { value: String(row.on_hand_value), unit: String(row.unit) },
				reserved: {
					value: String(row.reserved_value),
					unit: String(row.unit),
				},
				outgoingTransferCommitted: {
					value: String(row.outgoing_transfer_committed_value),
					unit: String(row.unit),
				},
				expected: {
					value: String(row.expected_value),
					unit: String(row.unit),
				},
				inTransit: {
					value: String(row.in_transit_value),
					unit: String(row.unit),
				},
			}));
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
			throw new Error("Stock-adjustment confirmation binding failed.");
		}
	}

	storeCommandResult(record: StoredCommandResult): void {
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

	storeRejection(record: StoredCommandResult): void {
		this.storeCommandResult(record);
	}

	commitOpeningBalance(input: OpeningBalanceCommit): void {
		this.#assertPool(input.balance);
		if (input.previous === null) {
			this.#storage.sql.exec(
				`INSERT INTO inventory_balances
				   (pool_id, location_id, sku_id, on_hand_value,
				    reserved_value, outgoing_transfer_committed_value,
				    available_value, expected_value, in_transit_value,
				    unit, version, has_stock_history)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				input.balance.poolId,
				input.balance.locationId,
				input.balance.skuId,
				input.balance.onHand.value,
				input.balance.reserved.value,
				input.balance.outgoingTransferCommitted.value,
				input.balance.available.value,
				input.balance.expected.value,
				input.balance.inTransit.value,
				input.balance.onHand.unit,
				Number(input.balance.version),
				input.balance.hasStockHistory ? 1 : 0,
			).toArray();
		} else {
			const updated = this.#storage.sql.exec<SqlRow>(
				`UPDATE inventory_balances
				 SET on_hand_value = ?, reserved_value = ?,
				     outgoing_transfer_committed_value = ?, available_value = ?,
				     expected_value = ?, in_transit_value = ?, unit = ?,
				     version = ?, has_stock_history = ?
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?
				   AND version = ? AND has_stock_history = 0
				 RETURNING sku_id`,
				input.balance.onHand.value,
				input.balance.reserved.value,
				input.balance.outgoingTransferCommitted.value,
				input.balance.available.value,
				input.balance.expected.value,
				input.balance.inTransit.value,
				input.balance.onHand.unit,
				Number(input.balance.version),
				input.balance.hasStockHistory ? 1 : 0,
				input.balance.poolId,
				input.balance.locationId,
				input.balance.skuId,
				Number(input.previous.version),
			).toArray();
			if (updated.length !== 1) {
				throw new Error("Opening-balance update lost its planning row.");
			}
		}
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

	commitStockAdjustment(input: StockAdjustmentCommit): void {
		this.#assertPool(input.balance);
		const updated = this.#storage.sql
			.exec<SqlRow>(
				`UPDATE inventory_balances
				 SET on_hand_value = ?, reserved_value = ?,
				     outgoing_transfer_committed_value = ?, available_value = ?,
				     expected_value = ?, in_transit_value = ?, unit = ?,
				     version = ?, has_stock_history = ?
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?
				   AND version = ? AND has_stock_history = 1
				 RETURNING sku_id`,
				input.balance.onHand.value,
				input.balance.reserved.value,
				input.balance.outgoingTransferCommitted.value,
				input.balance.available.value,
				input.balance.expected.value,
				input.balance.inTransit.value,
				input.balance.onHand.unit,
				Number(input.balance.version),
				input.balance.hasStockHistory ? 1 : 0,
				input.balance.poolId,
				input.balance.locationId,
				input.balance.skuId,
				Number(input.previousVersion),
			)
			.toArray();
		if (updated.length !== 1) {
			throw new Error("Stock-adjustment balance update lost its target row.");
		}
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
		this.storeCommandResult(input);
	}

	commitLocation(input: LocationCommit): void {
		if (input.location.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		if (input.previous === null) {
			this.#storage.sql
				.exec(
					`INSERT INTO inventory_locations
					   (pool_id, location_id, name, name_key, status, version,
					    created_at, updated_at, archived_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					input.location.poolId,
					input.location.locationId,
					input.location.name,
					input.location.nameKey,
					input.location.status,
					Number(input.location.version),
					input.location.createdAt,
					input.location.updatedAt,
					input.location.archivedAt,
				)
				.toArray();
		} else {
			const updated = this.#storage.sql
				.exec<SqlRow>(
					`UPDATE inventory_locations
					 SET name = ?, name_key = ?, status = ?, version = ?,
					     updated_at = ?, archived_at = ?
					 WHERE pool_id = ? AND location_id = ?
					 RETURNING location_id`,
					input.location.name,
					input.location.nameKey,
					input.location.status,
					Number(input.location.version),
					input.location.updatedAt,
					input.location.archivedAt,
					input.location.poolId,
					input.location.locationId,
				)
				.toArray();
			if (updated.length !== 1) {
				throw new Error("Location update lost its target row.");
			}
		}
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

	commitManagedSku(input: ManagedSkuCommit): void {
		if (input.sku.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		this.#storage.sql
			.exec(
				`INSERT INTO inventory_skus
				   (pool_id, inventory_sku_id, sku, display_name, unit, version,
				    registered_at, registered_by_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.sku.poolId,
				input.sku.inventorySkuId,
				input.sku.sku,
				input.sku.displayName,
				input.sku.unit,
				Number(input.sku.version),
				input.sku.registeredAt,
				JSON.stringify(input.sku.registeredBy),
			)
			.toArray();
		this.storeCommandResult(input);
	}

	commitStockTransfer(input: StockTransferCommit): void {
		if (input.transfer.poolId !== this.#poolId) {
			throw new Error("A transaction cannot cross inventory pools.");
		}
		for (const change of input.balances) {
			this.#assertPool(change.balance);
			if (change.previous === null) {
				this.#storage.sql.exec(
					`INSERT INTO inventory_balances (
						pool_id, location_id, sku_id, on_hand_value, reserved_value,
						outgoing_transfer_committed_value, available_value,
						expected_value, in_transit_value, unit, version,
						has_stock_history
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					change.balance.poolId,
					change.balance.locationId,
					change.balance.skuId,
					change.balance.onHand.value,
					change.balance.reserved.value,
					change.balance.outgoingTransferCommitted.value,
					change.balance.available.value,
					change.balance.expected.value,
					change.balance.inTransit.value,
					change.balance.onHand.unit,
					Number(change.balance.version),
					change.balance.hasStockHistory ? 1 : 0,
				).toArray();
			} else {
				const updated = this.#storage.sql.exec<SqlRow>(
					`UPDATE inventory_balances
					 SET on_hand_value = ?, reserved_value = ?,
					     outgoing_transfer_committed_value = ?, available_value = ?,
					     expected_value = ?, in_transit_value = ?, unit = ?,
					     version = ?, has_stock_history = ?
					 WHERE pool_id = ? AND location_id = ? AND sku_id = ?
					   AND version = ?
					 RETURNING sku_id`,
					change.balance.onHand.value,
					change.balance.reserved.value,
					change.balance.outgoingTransferCommitted.value,
					change.balance.available.value,
					change.balance.expected.value,
					change.balance.inTransit.value,
					change.balance.onHand.unit,
					Number(change.balance.version),
					change.balance.hasStockHistory ? 1 : 0,
					change.balance.poolId,
					change.balance.locationId,
					change.balance.skuId,
					Number(change.previous.version),
				).toArray();
				if (updated.length !== 1) {
					throw new Error("Stock-transfer balance update lost its target row.");
				}
			}
		}
		if (input.previous === null) {
			this.#storage.sql.exec(
				`INSERT INTO inventory_transfers
				   (pool_id, transfer_id, reference_key, status, version, transfer_json)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				input.transfer.poolId,
				input.transfer.transferId,
				input.referenceKey,
				input.transfer.status,
				Number(input.transfer.version),
				JSON.stringify(input.transfer),
			).toArray();
		} else {
			const updated = this.#storage.sql.exec<SqlRow>(
				`UPDATE inventory_transfers
				 SET reference_key = ?, status = ?, version = ?, transfer_json = ?
				 WHERE pool_id = ? AND transfer_id = ? AND version = ?
				 RETURNING transfer_id`,
				input.referenceKey,
				input.transfer.status,
				Number(input.transfer.version),
				JSON.stringify(input.transfer),
				input.transfer.poolId,
				input.transfer.transferId,
				Number(input.previous.version),
			).toArray();
			if (updated.length !== 1) {
				throw new Error("Stock-transfer update lost its target row.");
			}
		}
		this.#storage.sql.exec(
			`INSERT INTO inventory_receipts (receipt_id, command_id, receipt_json)
			 VALUES (?, ?, ?)`,
			input.receipt.receiptId,
			input.commandId,
			JSON.stringify(input.receipt),
		).toArray();
		this.storeCommandResult(input);
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
				        reserved_value, outgoing_transfer_committed_value,
				        available_value, expected_value, in_transit_value,
				        unit, version,
				        has_stock_history
				 FROM inventory_balances
				 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
				key.poolId,
				key.locationId,
				key.skuId,
			),
		);
	}

	async readManagedSku(
		query: ReadManagedSkuQuery,
	): Promise<ManagedSkuRecord | null> {
		if (query.poolId !== this.#poolId) {
			throw new Error("A store cannot read across inventory pools.");
		}
		return managedSkuFrom(
			first(
				this.#storage,
				`SELECT pool_id, inventory_sku_id, sku, display_name, unit,
				        version, registered_at, registered_by_json
				 FROM inventory_skus
				 WHERE pool_id = ? AND inventory_sku_id = ?`,
				query.poolId,
				query.skuId,
			),
		);
	}

	async readStockTransfer(
		query: ReadStockTransferInput,
	): Promise<StockTransferRecord | null> {
		if (query.poolId !== this.#poolId) {
			throw new Error("A store cannot read across inventory pools.");
		}
		return stockTransferFrom(
			first(
				this.#storage,
				`SELECT transfer_json
				 FROM inventory_transfers
				 WHERE pool_id = ? AND transfer_id = ?`,
				query.poolId,
				query.transferId,
			),
		);
	}

	async readSkuActiveLocationSnapshot(
		query: ReadSkuActiveLocationSnapshotQuery,
	): Promise<readonly ActiveLocationBalanceSnapshot[]> {
		if (query.poolId !== this.#poolId) {
			throw new Error("A store cannot read across inventory pools.");
		}
		return this.#storage.sql
			.exec<SqlRow>(
				`SELECT location.pool_id, location.location_id, location.name,
				        location.name_key, location.status, location.version,
				        location.created_at, location.updated_at,
				        location.archived_at,
				        balance.sku_id AS balance_sku_id,
				        balance.on_hand_value AS balance_on_hand_value,
				        balance.reserved_value AS balance_reserved_value,
				        balance.outgoing_transfer_committed_value AS balance_outgoing_transfer_committed_value,
				        balance.available_value AS balance_available_value,
				        balance.expected_value AS balance_expected_value,
				        balance.in_transit_value AS balance_in_transit_value,
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
				query.skuId,
				query.poolId,
			)
			.toArray()
			.map(activeLocationBalanceSnapshotFrom);
	}

	async readCommand<
		TResult extends InventoryCommandResult = InventoryCommandResult,
	>(commandId: string): Promise<StoredCommandResult<TResult> | null> {
		return commandFrom<TResult>(
			first(
				this.#storage,
				`SELECT command_id, command_digest, terminal_result_json
				 FROM inventory_command_results
				 WHERE command_id = ?`,
				commandId,
			),
		);
	}

	async readCommandByReceiptId<
		TResult extends InventoryCommandResult = InventoryCommandResult,
	>(
		receiptId: string,
	): Promise<StoredCommandResult<TResult> | null> {
		return commandFrom<TResult>(
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
	): Promise<InventoryReceiptV2 | null> {
		const row = first(
			this.#storage,
			"SELECT receipt_json FROM inventory_receipts WHERE receipt_id = ?",
			receiptId,
		);
		return row === undefined
			? null
			: json<InventoryReceiptV2>(row.receipt_json);
	}

	async listReceipts(
		query: ListReceiptsQuery,
	): Promise<readonly InventoryStockReceiptV2[]> {
		if (query.poolId !== this.#poolId) {
			throw new Error("A store cannot read across inventory pools.");
		}
		const clauses = [
			"json_extract(receipt_json, '$.context.poolId') = ?",
			"json_extract(receipt_json, '$.type') IN ('stock.opening_balance', 'stock.adjust', 'transfer.create', 'transfer.update', 'transfer.cancel', 'transfer.dispatch', 'transfer.receive', 'transfer.reopen')",
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
		return this.#storage.sql
			.exec<SqlRow>(
				`SELECT receipt_json
				 FROM inventory_receipts
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY json_extract(receipt_json, '$.committedAt') DESC,
				          receipt_id DESC
				 LIMIT ?`,
				...bindings,
			)
			.toArray()
			.map((row) => json<InventoryStockReceiptV2>(row.receipt_json));
	}

	async listLocations(
		query: ListLocationsQuery,
	): Promise<readonly LocationRecord[]> {
		if (query.poolId !== this.#poolId) {
			throw new Error("A store cannot read across inventory pools.");
		}
		return this.#storage.sql
			.exec<SqlRow>(
				`SELECT pool_id, location_id, name, name_key, status, version,
				        created_at, updated_at, archived_at
				 FROM inventory_locations
				 WHERE pool_id = ? AND status = ?
				 ORDER BY name_key, location_id`,
				query.poolId,
				query.status,
			)
			.toArray()
			.map((row) => locationFrom(row) as LocationRecord);
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
