import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
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
			version: 2,
			tables: [
				"inventory_balances",
				"inventory_command_results",
				"inventory_locations",
				"inventory_opening_balance_confirmations",
				"inventory_receipts",
				"inventory_schema_migrations",
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
				version: 2,
				tables: [
					"inventory_balances",
					"inventory_command_results",
					"inventory_locations",
					"inventory_opening_balance_confirmations",
					"inventory_receipts",
					"inventory_schema_migrations",
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
			expect(versions).toEqual([2]);
			expect(() => initializeCloudflareInventorySchema(state.storage)).not.toThrow();
			expect(readCloudflareInventorySchemaStatus(state.storage).version).toBe(2);
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

	it("commits and exactly replays through the production transaction adapter", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_commit");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_commit",
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

	it("persists and consumes the five-minute confirmation through the production adapter", async ({
		expect,
	}) => {
		const stub = env.INVENTORY_POOLS.getByName("pool_confirm");
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: "pool_confirm",
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
