import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createRegisterManagedSku } from "../../src/application/register-managed-sku.ts";
import {
	createExecuteLocationCommand,
	createListLocations,
} from "../../src/application/location-registry.ts";
import {
	createConfirmOpeningBalance,
	createPreviewOpeningBalance,
} from "../../src/application/preview-confirm-opening-balance.ts";
import * as readInventoryApplication from "../../src/application/read-inventory.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import {
	initializeCloudflareInventorySchema,
	readCloudflareInventorySchemaStatus,
} from "../../src/cloudflare/schema.ts";
import {
	archiveFixtureLocation,
	createFixtureLocation,
	restoreFixtureLocation,
} from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "principal_test_operator",
	displayName: "Test Operator",
	surface: "test",
});

function key(poolId = "pool_alpha", locationId = "location_north") {
	return { poolId, locationId, skuId: "sku_test_hat" };
}

function command({
	commandId = "cmd_opening_alpha",
	poolId = "pool_alpha",
	locationId = "location_north",
	value = "5",
} = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: { siteId: "site_test", poolId, locationId },
		payload: {
			skuId: "sku_test_hat",
			quantity: { value, unit: "each" },
		},
		reason: { code: "physical_count", note: "Test count" },
		references: [],
		expectedVersions: [
			{ skuId: "sku_test_hat", locationId, version: "0" },
		],
	};
}

describe("Inventory Cloudflare storage boundary", () => {
	it("keeps the default Worker HTTP surface closed", async ({ expect }) => {
		const response = await exports.default.fetch(
			new Request("https://inventory.invalid/"),
		);
		expect(response.status).toBe(404);
	});

	it("initializes schema once, returns not_found, and isolates pools", async ({
		expect,
	}) => {
		const alpha = env.INVENTORY_POOLS.getByName("pool_alpha");
		const beta = env.INVENTORY_POOLS.getByName("pool_beta");

		expect(await alpha.schemaStatus()).toEqual({
			schema: "dinkuskit.inventory.cloudflare-schema-status/v1",
			version: 3,
			tables: [
				"inventory_balances",
				"inventory_command_results",
				"inventory_locations",
				"inventory_opening_balance_confirmations",
				"inventory_receipts",
				"inventory_schema_migrations",
				"inventory_skus",
			],
		});
		expect(await alpha.schemaStatus()).toEqual(await alpha.schemaStatus());
		expect(await alpha.readSkuLocationBalance(key())).toMatchObject({
			outcome: "not_found",
			key: key(),
		});
		expect(
			await beta.readSkuLocationBalance(key("pool_beta")),
		).toMatchObject({ outcome: "not_found", key: key("pool_beta") });
		expect(await exports.default.inspectSkuLocation(key("pool_probe"))).toEqual({
			schema: {
				schema: "dinkuskit.inventory.cloudflare-schema-status/v1",
				version: 3,
				tables: [
					"inventory_balances",
					"inventory_command_results",
					"inventory_locations",
					"inventory_opening_balance_confirmations",
					"inventory_receipts",
					"inventory_schema_migrations",
					"inventory_skus",
				],
			},
			balance: {
				schema: "dinkuskit.inventory.balance-read-result/v1",
				outcome: "not_found",
				key: key("pool_probe"),
			},
			recordCounts: {
				balances: 0,
				commandResults: 0,
				confirmations: 0,
				receipts: 0,
				skus: 0,
			},
		});
	});

	it("records only the complete current version for a fresh database", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_fresh_schema_history");
		await runInDurableObject(stub, async (_instance, state) => {
			const versions = state.storage.sql
				.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
				.toArray()
				.map((row) => Number(row.version));
			expect(versions).toEqual([3]);
			expect(() => initializeCloudflareInventorySchema(state.storage)).not.toThrow();
			expect(readCloudflareInventorySchemaStatus(state.storage).version).toBe(3);
		});
	});

	it("atomically upgrades an exact v2 pool and preserves its durable records", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_v2_upgrade");
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.transactionSync(() => {
				state.storage.sql.exec("DROP TABLE inventory_skus").toArray();
				state.storage.sql
					.exec("DELETE FROM inventory_schema_migrations")
					.toArray();
				state.storage.sql
					.exec(
						"INSERT INTO inventory_schema_migrations (version, applied_at) VALUES (2, 'v2')",
					)
					.toArray();
				state.storage.sql
					.exec(
						`INSERT INTO inventory_locations (
							pool_id, location_id, name, name_key, status, version,
							created_at, updated_at, archived_at
						) VALUES (?, ?, ?, ?, 'active', 1, ?, ?, NULL)`,
						"pool_v2_upgrade",
						"location_legacy",
						"Legacy Warehouse",
						"legacy warehouse",
						"2026-08-28T16:00:00.000Z",
						"2026-08-28T16:00:00.000Z",
					)
					.toArray();
				state.storage.sql
					.exec(
						`INSERT INTO inventory_balances (
							pool_id, location_id, sku_id, on_hand_value, reserved_value,
							available_value, unit, version, has_stock_history
						) VALUES (?, ?, ?, '7', '2', '5', 'each', 4, 1)`,
						"pool_v2_upgrade",
						"location_legacy",
						"legacy_inventory_sku",
					)
					.toArray();
				state.storage.sql
					.exec(
						`INSERT INTO inventory_command_results (
							command_id, command_digest, terminal_result_json
						) VALUES ('legacy_command', 'legacy_digest', '{"outcome":"legacy"}')`,
					)
					.toArray();
				state.storage.sql
					.exec(
						`INSERT INTO inventory_receipts (
							receipt_id, command_id, receipt_json
						) VALUES ('legacy_receipt', 'legacy_command', '{"receipt":"legacy"}')`,
					)
					.toArray();
				state.storage.sql
					.exec(
						`INSERT INTO inventory_opening_balance_confirmations (
							confirmation_digest, pool_id, action_digest, principal_digest,
							issued_at, expires_at, command_id
						) VALUES (
							'legacy_confirmation', 'pool_v2_upgrade', 'legacy_action',
							'legacy_principal', '2026-08-28T16:00:00.000Z',
							'2026-08-28T16:05:00.000Z', 'legacy_command'
						)`,
					)
					.toArray();
			});

			initializeCloudflareInventorySchema(state.storage);

			expect(
				state.storage.sql
					.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
					.toArray()
					.map((row) => Number(row.version)),
			).toEqual([2, 3]);
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_v2_upgrade",
			});
			expect(
				await store.readManagedSku({
					poolId: "pool_v2_upgrade",
					skuId: "legacy_inventory_sku",
				}),
			).toEqual({
				poolId: "pool_v2_upgrade",
				inventorySkuId: "legacy_inventory_sku",
				sku: "legacy_inventory_sku",
				displayName: "legacy_inventory_sku",
				unit: "each",
				version: "1",
				registeredAt: "2026-08-28T22:38:50.000Z",
				registeredBy: {
					kind: "system",
					id: "inventory_schema_migration_v3",
					surface: "cloudflare_durable_object",
				},
			});
			expect(
				await store.readBalance({
					poolId: "pool_v2_upgrade",
					locationId: "location_legacy",
					skuId: "legacy_inventory_sku",
				}),
			).toMatchObject({
				onHand: { value: "7", unit: "each" },
				reserved: { value: "2", unit: "each" },
				available: { value: "5", unit: "each" },
				version: "4",
			});
			expect(
				state.storage.sql
					.exec(
						`SELECT
							(SELECT count(*) FROM inventory_command_results) AS commands,
							(SELECT count(*) FROM inventory_receipts) AS receipts,
							(SELECT count(*) FROM inventory_opening_balance_confirmations) AS confirmations`,
					)
					.one(),
			).toEqual({ commands: 1, receipts: 1, confirmations: 1 });
			expect(() => initializeCloudflareInventorySchema(state.storage)).not.toThrow();
		});
	});

	it("rolls back the v2 upgrade when one legacy identity has conflicting units", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_v2_conflicting_units");
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.transactionSync(() => {
				state.storage.sql.exec("DROP TABLE inventory_skus").toArray();
				state.storage.sql
					.exec("DELETE FROM inventory_schema_migrations")
					.toArray();
				state.storage.sql
					.exec(
						"INSERT INTO inventory_schema_migrations (version, applied_at) VALUES (2, 'v2')",
					)
					.toArray();
				for (const [locationId, unit] of [
					["location_each", "each"],
					["location_case", "case"],
				]) {
					state.storage.sql
						.exec(
							`INSERT INTO inventory_balances (
								pool_id, location_id, sku_id, on_hand_value,
								reserved_value, available_value, unit, version,
								has_stock_history
							) VALUES (?, ?, 'legacy_conflict', '1', '0', '1', ?, 1, 1)`,
							"pool_v2_conflicting_units",
							locationId,
							unit,
						)
						.toArray();
				}
			});

			expect(() => initializeCloudflareInventorySchema(state.storage)).toThrow(
				/each-only SKU registry/iu,
			);
			expect(
				state.storage.sql
					.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
					.toArray()
					.map((row) => Number(row.version)),
			).toEqual([2]);
			expect(
				state.storage.sql
					.exec(
						"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'inventory_skus'",
					)
					.toArray(),
			).toEqual([]);
			expect(
				Number(
					state.storage.sql
						.exec("SELECT count(*) AS count FROM inventory_balances")
						.one().count,
				),
			).toBe(2);
		});
	});

	it("rejects version-1-shaped storage without modifying it", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_legacy_schema");
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.transactionSync(() => {
				state.storage.sql.exec("DROP TABLE inventory_locations").toArray();
				state.storage.sql
					.exec("DELETE FROM inventory_schema_migrations")
					.toArray();
				state.storage.sql
					.exec(
						"INSERT INTO inventory_schema_migrations (version, applied_at) VALUES (1, 'legacy')",
					)
					.toArray();
			});

			expect(() => initializeCloudflareInventorySchema(state.storage)).toThrow(
				/older or incompatible/iu,
			);
			expect(
				state.storage.sql
					.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
					.toArray()
					.map((row) => Number(row.version)),
			).toEqual([1]);
			expect(
				state.storage.sql
					.exec(
						"SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'inventory_locations'",
					)
					.toArray(),
			).toEqual([]);
		});
	});

	it("persists and exactly replays the location lifecycle through Cloudflare SQLite", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_locations");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_locations",
			});
			let locationIds = 0;
			let receiptIds = 0;
			const execute = createExecuteLocationCommand({
				store,
				now: () => new Date("2026-08-28T16:00:00.000Z"),
				createLocationId: () => {
					locationIds += 1;
					return "location_cloudflare";
				},
				createReceiptId: () => {
					receiptIds += 1;
					return "rcpt_location_cloudflare";
				},
			});
			const input = {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_location_cloudflare",
				type: "location.create",
				context: { siteId: "site_test", poolId: "pool_locations" },
				payload: { name: "Warehouse" },
				references: [],
			};
			const first = await execute(input, { principal });
			const replay = await execute(input, { principal });

			expect(first.outcome).toBe("committed");
			expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
			expect({ locationIds, receiptIds }).toEqual({
				locationIds: 1,
				receiptIds: 1,
			});
			expect(
				await createListLocations({ store })({
					poolId: "pool_locations",
					status: "active",
				}),
			).toMatchObject({
				locations: [
					{
						locationId: "location_cloudflare",
						name: "Warehouse",
						status: "active",
						version: "1",
					},
				],
			});
		});
	});

	it("persists and exactly replays managed SKU registration through Cloudflare SQLite", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_managed_sku");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_managed_sku",
			});
			let inventorySkuIds = 0;
			const execute = createRegisterManagedSku({
				store,
				now: () => new Date("2026-08-28T17:00:00.000Z"),
				createInventorySkuId: () => {
					inventorySkuIds += 1;
					return "inventory_sku_cloudflare_hat";
				},
			});
			const input = {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_cloudflare_register",
				type: "sku.register",
				context: {
					siteId: "site_smokyclub",
					poolId: "pool_managed_sku",
				},
				payload: {
					sku: "HAT-BLACK",
					displayNameIfNew: "Black Logo Hat",
					unit: "each",
				},
				references: [],
			};
			const first = await execute(input, { principal });
			const replay = await execute(input, { principal });

			expect(first).toEqual({
				schema: "dinkuskit.inventory.command-result/v1",
				outcome: "registered",
				commandId: "cmd_cloudflare_register",
				inventorySku: {
					inventorySkuId: "inventory_sku_cloudflare_hat",
					sku: "HAT-BLACK",
					displayName: "Black Logo Hat",
				},
			});
			expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
			expect(inventorySkuIds).toBe(1);
			expect(
				await store.readManagedSku({
					poolId: "pool_managed_sku",
					skuId: "inventory_sku_cloudflare_hat",
				}),
			).toEqual({
				poolId: "pool_managed_sku",
				inventorySkuId: "inventory_sku_cloudflare_hat",
				sku: "HAT-BLACK",
				displayName: "Black Logo Hat",
				unit: "each",
				version: "1",
				registeredAt: "2026-08-28T17:00:00.000Z",
				registeredBy: principal,
			});
			expect(
				await store.readManagedSku({
					poolId: "pool_managed_sku",
					skuId: "inventory_sku_missing",
				}),
			).toBeNull();
		});
	});

	it("admits Cloudflare opening balances only for active locations", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_location_admission");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_location_admission",
			});
			await createFixtureLocation(store, {
				poolId: "pool_location_admission",
				locationId: "location_active",
			});
			await createFixtureLocation(store, {
				poolId: "pool_location_admission",
				locationId: "location_archived",
			});
			await createFixtureManagedSku(store, {
				poolId: "pool_location_admission",
				skuId: "sku_test_hat",
			});
			await archiveFixtureLocation(store, {
				poolId: "pool_location_admission",
				locationId: "location_archived",
			});
			const execute = (receiptId) =>
				createSetOpeningBalance({
					store,
					now: () => new Date("2026-08-28T12:00:00.000Z"),
					createReceiptId: () => receiptId,
				});

			const active = await execute("rcpt_active")(
				command({
					commandId: "cmd_active",
					poolId: "pool_location_admission",
					locationId: "location_active",
				}),
				{ principal },
			);
			const archivedCommand = command({
				commandId: "cmd_archived",
				poolId: "pool_location_admission",
				locationId: "location_archived",
			});
			const archived = await execute("rcpt_archived_should_not_exist")(
				archivedCommand,
				{ principal },
			);
			const unknown = await execute("rcpt_unknown_should_not_exist")(
				command({
					commandId: "cmd_unknown",
					poolId: "pool_location_admission",
					locationId: "location_unknown",
				}),
				{ principal },
			);

			expect(active.outcome).toBe("committed");
			expect(archived).toMatchObject({
				outcome: "rejected",
				code: "location_not_active",
			});
			expect(unknown).toMatchObject({
				outcome: "rejected",
				code: "location_not_found",
			});
			expect(
				await store.readBalance(
					key("pool_location_admission", "location_archived"),
				),
			).toBeNull();
			expect(
				await store.readBalance(
					key("pool_location_admission", "location_unknown"),
				),
			).toBeNull();
			expect(await store.readReceipt("rcpt_archived_should_not_exist")).toBeNull();
			expect(await store.readReceipt("rcpt_unknown_should_not_exist")).toBeNull();

			await restoreFixtureLocation(store, {
				poolId: "pool_location_admission",
				locationId: "location_archived",
			});
			const replay = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-08-28T13:00:00.000Z"),
				createReceiptId: () => {
					throw new Error("replay must not request a receipt ID");
				},
			})(archivedCommand, { principal });
			expect(JSON.stringify(replay)).toBe(JSON.stringify(archived));
		});
	});

	it("commits and exactly replays through the production transaction adapter", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_commit");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_commit",
			});
			await createFixtureLocation(store, {
				poolId: "pool_commit",
				locationId: "location_north",
			});
			await createFixtureManagedSku(store, {
				poolId: "pool_commit",
				skuId: "sku_test_hat",
			});
			let receipts = 0;
			const setOpeningBalance = createSetOpeningBalance({
				store,
				now: () => new Date("2026-08-28T12:00:00.000Z"),
				createReceiptId: () => {
					receipts += 1;
					return "rcpt_commit";
				},
			});
			const input = command({ poolId: "pool_commit" });
			const first = await setOpeningBalance(input, { principal });
			const replay = await setOpeningBalance(input, { principal });

			expect(first.outcome).toBe("committed");
			expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
			expect(receipts).toBe(1);
				expect(await store.readBalance(key("pool_commit"))).toMatchObject({
				onHand: { value: "5", unit: "each" },
				version: "1",
				hasStockHistory: true,
				});
			});
			expect(
				await env.INVENTORY_POOLS.getByName(
					"pool_commit_isolated",
				).readSkuLocationBalance(key("pool_commit_isolated")),
			).toMatchObject({
				outcome: "not_found",
				key: key("pool_commit_isolated"),
			});
	});

	it("reads one SKU across active locations through the Durable Object service", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_aggregate");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_aggregate",
			});
			await createFixtureLocation(store, {
				poolId: "pool_aggregate",
				locationId: "location_home",
				name: "Home",
			});
			await createFixtureLocation(store, {
				poolId: "pool_aggregate",
				locationId: "location_warehouse",
				name: "Warehouse",
			});
			await createFixtureManagedSku(store, {
				poolId: "pool_aggregate",
				skuId: "sku_test_hat",
			});
			await createSetOpeningBalance({
				store,
				now: () => new Date("2026-08-28T12:00:00.000Z"),
				createReceiptId: () => "rcpt_aggregate",
			})(
				command({
					commandId: "cmd_aggregate",
					poolId: "pool_aggregate",
					locationId: "location_home",
					value: "5",
				}),
				{ principal },
			);
		});

		const input = {
			poolId: "pool_aggregate",
			skuId: "sku_test_hat",
			scope: { kind: "all_locations" },
		};
		const expected = {
			schema: "dinkuskit.inventory.sku-stock-read-result/v1",
			outcome: "found",
			poolId: "pool_aggregate",
			skuId: "sku_test_hat",
			scope: { kind: "all_locations" },
			stock: {
				onHand: { value: "5", unit: "each" },
				reserved: { value: "0", unit: "each" },
				available: { value: "5", unit: "each" },
			},
			locations: [
				{
					locationId: "location_home",
					name: "Home",
					stock: {
						onHand: { value: "5", unit: "each" },
						reserved: { value: "0", unit: "each" },
						available: { value: "5", unit: "each" },
					},
				},
				{
					locationId: "location_warehouse",
					name: "Warehouse",
					stock: {
						onHand: { value: "0", unit: "each" },
						reserved: { value: "0", unit: "each" },
						available: { value: "0", unit: "each" },
					},
				},
			],
		};

		expect(await stub.readSkuStock(input)).toEqual(expected);
		expect(await exports.default.readSkuStock(input)).toEqual(expected);
	});

	it("persists and consumes the five-minute confirmation through the production adapter", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_confirm");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_confirm",
			});
			await createFixtureLocation(store, {
				poolId: "pool_confirm",
				locationId: "location_north",
			});
			await createFixtureManagedSku(store, {
				poolId: "pool_confirm",
				skuId: "sku_test_hat",
			});
			const now = () => new Date("2026-08-28T12:00:00.000Z");
			const preview = createPreviewOpeningBalance({
				store,
				now,
				createConfirmation: () => "confirm_cloudflare",
			});
			const confirm = createConfirmOpeningBalance({
				store,
				now,
				createReceiptId: () => "rcpt_cloudflare_confirm",
			});
			const input = {
				schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
				type: "stock.opening_balance",
				context: {
					siteId: "site_test",
					poolId: "pool_confirm",
					locationId: "location_north",
				},
				payload: {
					skuId: "sku_test_hat",
					quantity: { value: "5", unit: "each" },
				},
				reason: { code: "physical_count", note: "Test count" },
				references: [],
			};
			const proposed = await preview(input, { principal });
			expect(proposed.confirmation.expiresAt).toBe(
				"2026-08-28T12:05:00.000Z",
			);
			expect(await store.readBalance(key("pool_confirm"))).toBeNull();

			const result = await confirm(
				proposed.confirmation.value,
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_confirmed",
					type: input.type,
					context: input.context,
					payload: input.payload,
					reason: input.reason,
					references: input.references,
					expectedVersions: [
						{
							skuId: input.payload.skuId,
							locationId: input.context.locationId,
							version: "0",
						},
					],
				},
				{ principal },
			);
			expect(result.outcome).toBe("committed");
			expect(await store.readReceipt("rcpt_cloudflare_confirm")).toEqual(
				result.receipt,
			);
		});
	});

	it("rolls back balance and command when an immutable receipt conflicts", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_rollback");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_rollback",
			});
			await createFixtureLocation(store, {
				poolId: "pool_rollback",
				locationId: "location_north",
			});
			await createFixtureLocation(store, {
				poolId: "pool_rollback",
				locationId: "location_south",
			});
			await createFixtureManagedSku(store, {
				poolId: "pool_rollback",
				skuId: "sku_test_hat",
			});
			const execute = (receiptId) =>
				createSetOpeningBalance({
					store,
					now: () => new Date("2026-08-28T12:00:00.000Z"),
					createReceiptId: () => receiptId,
				});

			await execute("rcpt_duplicate")(
				command({ commandId: "cmd_north", poolId: "pool_rollback" }),
				{ principal },
			);
			await expect(
				execute("rcpt_duplicate")(
					command({
						commandId: "cmd_south",
						poolId: "pool_rollback",
						locationId: "location_south",
					}),
					{ principal },
				),
			).rejects.toThrow();
			expect(
				await store.readBalance(key("pool_rollback", "location_south")),
			).toBeNull();
			expect(await store.readCommand("cmd_south")).toBeNull();
		});
	});

	it("reads the same receipt ledger by one location or all locations", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_history");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_history",
			});
			await createFixtureLocation(store, {
				poolId: "pool_history",
				locationId: "location_north",
			});
			await createFixtureLocation(store, {
				poolId: "pool_history",
				locationId: "location_south",
			});
			await createFixtureManagedSku(store, {
				poolId: "pool_history",
				skuId: "sku_test_hat",
			});
			const execute = (receiptId, committedAt) =>
				createSetOpeningBalance({
					store,
					now: () => new Date(committedAt),
					createReceiptId: () => receiptId,
				});
			await execute("rcpt_history_north", "2026-08-28T12:00:00.000Z")(
				command({
					commandId: "cmd_history_north",
					poolId: "pool_history",
					locationId: "location_north",
				}),
				{ principal },
			);
			await execute("rcpt_history_south", "2026-08-28T12:01:00.000Z")(
				command({
					commandId: "cmd_history_south",
					poolId: "pool_history",
					locationId: "location_south",
				}),
				{ principal },
			);

			const readHistory = readInventoryApplication.createReadReceiptHistory({
				store,
			});
			const north = await readHistory({
				poolId: "pool_history",
				scope: { kind: "location", locationId: "location_north" },
			});
			const all = await readHistory({
				poolId: "pool_history",
				scope: { kind: "all_locations" },
			});

			expect(north.receipts.map((receipt) => receipt.receiptId)).toEqual([
				"rcpt_history_north",
			]);
			expect(all.receipts.map((receipt) => receipt.receiptId)).toEqual([
				"rcpt_history_south",
				"rcpt_history_north",
			]);
			await expect(
				readHistory({
					poolId: "pool_other",
					scope: { kind: "all_locations" },
				}),
			).rejects.toThrow("A store cannot read across inventory pools.");
		});
	});
});
