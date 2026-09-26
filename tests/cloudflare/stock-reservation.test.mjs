import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createReadSkuLocationBalance } from "../../src/application/read-inventory.ts";
import { initializeCloudflareInventorySchema } from "../../src/cloudflare/schema.ts";
import {
	createPackAllStock,
	createPackSomeStock,
	createPackStock,
	createReleaseStock,
	createReserveStock,
} from "../../src/features/stock-reservation/index.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_reservation",
	displayName: "Reservation Operator",
	surface: "emdash",
});

describe("stock reservation Cloudflare parity", () => {
	it("reserves and releases against schema v5 without a Worker route", async ({
		expect,
	}) => {
		const poolId = "pool_stock_reservation_parity";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureLocation(store, { poolId });
			await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
			const opening = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-09-25T10:00:00.000Z"),
				createReceiptId: () => "rcpt_cf_opening",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_opening",
					type: "stock.opening_balance",
					context: { siteId: "site_test", poolId, locationId: "location_north" },
					payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
					reason: { code: "opening_balance", note: "Set Initial Stock" },
					references: [],
					expectedVersions: [
						{ skuId: "sku_hat", locationId: "location_north", version: "0" },
					],
				},
				{ principal },
			);
			expect(opening.outcome).toBe("committed");

			const reserve = createReserveStock({
				store,
				now: () => new Date("2026-09-25T12:00:00.000Z"),
				createReservationId: () => "rsv_cf_hat",
				createReceiptId: () => "rcpt_cf_reserve",
			});
			const command = {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_cf_reserve",
				type: "stock.reserve",
				context: { siteId: "site_test", poolId, locationId: "location_north" },
				payload: {
					skuId: "sku_hat",
					quantity: { value: "3", unit: "each" },
					orderLine: { kind: "commerce.order_line", id: "OL-1842" },
				},
				references: [],
			};
			const held = await reserve(command, { principal });
			expect(held.outcome).toBe("reserved");
			expect(await reserve(command, { principal })).toEqual(held);
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance,
			).toMatchObject({
				reserved: { value: "3", unit: "each" },
				available: { value: "7", unit: "each" },
			});

			const release = createReleaseStock({
				store,
				now: () => new Date("2026-09-25T12:05:00.000Z"),
				createReceiptId: () => "rcpt_cf_release",
			});
			const released = await release(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_release",
					type: "stock.release",
					context: { siteId: "site_test", poolId },
					payload: { reservationId: "rsv_cf_hat" },
					references: [],
				},
				{ principal },
			);
			expect(released.outcome).toBe("released");
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance,
			).toMatchObject({
				reserved: { value: "0", unit: "each" },
				available: { value: "10", unit: "each" },
			});
		});
	});

	it("backfills a v5 hold, packs it, and replays the packed result", async ({
		expect,
	}) => {
		const poolId = "pool_stock_pack_upgrade";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureLocation(store, { poolId });
			await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
			const opening = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-09-25T10:00:00.000Z"),
				createReceiptId: () => "rcpt_cf_pack_opening",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_pack_opening",
					type: "stock.opening_balance",
					context: { siteId: "site_test", poolId, locationId: "location_north" },
					payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
					reason: { code: "opening_balance", note: "Set Initial Stock" },
					references: [],
					expectedVersions: [
						{ skuId: "sku_hat", locationId: "location_north", version: "0" },
					],
				},
				{ principal },
			);
			expect(opening.outcome).toBe("committed");

			const v5Reservation = {
				schema: "dinkuskit.inventory.reservation/v1",
				reservationId: "rsv_cf_pack",
				poolId,
				locationId: "location_north",
				skuId: "sku_hat",
				quantity: { value: "3", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-1842" },
				status: "active",
				version: "1",
				createdAt: "2026-09-25T12:00:00.000Z",
				canceledAt: null,
				createdBy: principal,
				canceledBy: null,
			};
			state.storage.transactionSync(() => {
				state.storage.sql.exec("DROP TABLE inventory_reservations").toArray();
				state.storage.sql
					.exec(
						`CREATE TABLE inventory_reservations (
							pool_id TEXT NOT NULL,
							reservation_id TEXT NOT NULL,
							order_line_key TEXT NOT NULL,
							status TEXT NOT NULL CHECK (status IN ('active', 'canceled')),
							version INTEGER NOT NULL CHECK (version >= 1),
							reservation_json TEXT NOT NULL,
							PRIMARY KEY (pool_id, reservation_id)
						) STRICT`,
					)
					.toArray();
				state.storage.sql
					.exec(
						`CREATE UNIQUE INDEX inventory_reservations_active_order_line
						 ON inventory_reservations (pool_id, order_line_key)
						 WHERE status = 'active'`,
					)
					.toArray();
				state.storage.sql
					.exec(
						`INSERT INTO inventory_reservations
						   (pool_id, reservation_id, order_line_key, status, version, reservation_json)
						 VALUES (?, ?, ?, 'active', 1, ?)`,
						poolId,
						"rsv_cf_pack",
						JSON.stringify(["commerce.order_line", "OL-1842"]),
						JSON.stringify(v5Reservation),
					)
					.toArray();
				state.storage.sql
					.exec(
						`UPDATE inventory_balances
						 SET reserved_value = '3', available_value = '7', version = 2
						 WHERE pool_id = ? AND location_id = 'location_north' AND sku_id = 'sku_hat'`,
						poolId,
					)
					.toArray();
				state.storage.sql.exec("DELETE FROM inventory_schema_migrations").toArray();
				state.storage.sql
					.exec(
						"INSERT INTO inventory_schema_migrations (version, applied_at) VALUES (5, 'v5')",
					)
					.toArray();
			});

			initializeCloudflareInventorySchema(state.storage);
			const upgraded = JSON.parse(
				String(
					state.storage.sql
						.exec(
							"SELECT reservation_json FROM inventory_reservations WHERE reservation_id = 'rsv_cf_pack'",
						)
						.one().reservation_json,
					),
			);
			expect(upgraded.packedAt).toBe(null);
			expect(upgraded.packedBy).toBe(null);
			expect(upgraded.status).toBe("active");
			expect(upgraded.originalQuantity).toEqual({ value: "3", unit: "each" });

			const pack = createPackStock({
				store,
				now: () => new Date("2026-09-25T12:05:00.000Z"),
				createReceiptId: () => "rcpt_cf_pack",
			});
			const command = {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_cf_pack",
				type: "stock.pack",
				context: { siteId: "site_test", poolId },
				payload: { reservationId: "rsv_cf_pack" },
				references: [],
			};
			const packed = await pack(command, { principal });
			expect(packed.outcome).toBe("packed");
			expect(packed.reservation.packedAt).toBe("2026-09-25T12:05:00.000Z");
			expect(await pack(command, { principal })).toEqual(packed);
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance,
			).toMatchObject({
				onHand: { value: "7", unit: "each" },
				reserved: { value: "0", unit: "each" },
				available: { value: "7", unit: "each" },
			});
		});
	});

	it("packs every named hold in one Durable Object transaction", async ({
		expect,
	}) => {
		const poolId = "pool_stock_pack_all";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureLocation(store, { poolId });
			await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
			await createFixtureManagedSku(store, { poolId, skuId: "sku_shirt" });
			for (const [skuId, quantity, commandId, receiptId] of [
				["sku_hat", "10", "cmd_cf_pack_all_open_hat", "rcpt_cf_pack_all_open_hat"],
				["sku_shirt", "6", "cmd_cf_pack_all_open_shirt", "rcpt_cf_pack_all_open_shirt"],
			]) {
				const opening = await createSetOpeningBalance({
					store,
					now: () => new Date("2026-09-25T10:00:00.000Z"),
					createReceiptId: () => receiptId,
				})(
					{
						schema: "dinkuskit.inventory.command/v1",
						commandId,
						type: "stock.opening_balance",
						context: {
							siteId: "site_test",
							poolId,
							locationId: "location_north",
						},
						payload: { skuId, quantity: { value: quantity, unit: "each" } },
						reason: { code: "opening_balance", note: "Set Initial Stock" },
						references: [],
						expectedVersions: [
							{ skuId, locationId: "location_north", version: "0" },
						],
					},
					{ principal },
				);
				expect(opening.outcome).toBe("committed");
			}
			const hat = await createReserveStock({
				store,
				now: () => new Date("2026-09-25T12:00:00.000Z"),
				createReservationId: () => "rsv_cf_hat",
				createReceiptId: () => "rcpt_cf_reserve_hat",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_reserve_hat",
					type: "stock.reserve",
					context: {
						siteId: "site_test",
						poolId,
						locationId: "location_north",
					},
					payload: {
						skuId: "sku_hat",
						quantity: { value: "3", unit: "each" },
						orderLine: { kind: "commerce.order_line", id: "OL-1842-hat" },
					},
					references: [],
				},
				{ principal },
			);
			const shirt = await createReserveStock({
				store,
				now: () => new Date("2026-09-25T12:00:00.000Z"),
				createReservationId: () => "rsv_cf_shirt",
				createReceiptId: () => "rcpt_cf_reserve_shirt",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_reserve_shirt",
					type: "stock.reserve",
					context: {
						siteId: "site_test",
						poolId,
						locationId: "location_north",
					},
					payload: {
						skuId: "sku_shirt",
						quantity: { value: "2", unit: "each" },
						orderLine: { kind: "commerce.order_line", id: "OL-1842-shirt" },
					},
					references: [],
				},
				{ principal },
			);
			expect(hat.outcome).toBe("reserved");
			expect(shirt.outcome).toBe("reserved");
			const packed = await createPackAllStock({
				store,
				now: () => new Date("2026-09-25T12:05:00.000Z"),
				createReceiptId: () => "rcpt_cf_pack_all",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_pack_all",
					type: "stock.pack_all",
					context: { siteId: "site_test", poolId },
					payload: { reservationIds: ["rsv_cf_hat", "rsv_cf_shirt"] },
					references: [],
				},
				{ principal },
			);
			expect(packed.outcome).toBe("packed_all");
			expect(packed.reservations).toHaveLength(2);
		});
	});

	it("packs some of a hold and leaves leftover reserved", async ({ expect }) => {
		const poolId = "pool_stock_pack_some";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureLocation(store, { poolId });
			await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
			const opening = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-09-25T10:00:00.000Z"),
				createReceiptId: () => "rcpt_cf_pack_some_open",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_pack_some_open",
					type: "stock.opening_balance",
					context: {
						siteId: "site_test",
						poolId,
						locationId: "location_north",
					},
					payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
					reason: { code: "opening_balance", note: "Set Initial Stock" },
					references: [],
					expectedVersions: [
						{ skuId: "sku_hat", locationId: "location_north", version: "0" },
					],
				},
				{ principal },
			);
			expect(opening.outcome).toBe("committed");
			const held = await createReserveStock({
				store,
				now: () => new Date("2026-09-25T12:00:00.000Z"),
				createReservationId: () => "rsv_cf_pack_some",
				createReceiptId: () => "rcpt_cf_reserve_some",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_reserve_some",
					type: "stock.reserve",
					context: {
						siteId: "site_test",
						poolId,
						locationId: "location_north",
					},
					payload: {
						skuId: "sku_hat",
						quantity: { value: "3", unit: "each" },
						orderLine: { kind: "commerce.order_line", id: "OL-1842-some" },
					},
					references: [],
				},
				{ principal },
			);
			expect(held.outcome).toBe("reserved");
			const packed = await createPackSomeStock({
				store,
				now: () => new Date("2026-09-25T12:05:00.000Z"),
				createReceiptId: () => "rcpt_cf_pack_some",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_pack_some",
					type: "stock.pack_some",
					context: { siteId: "site_test", poolId },
					payload: {
						reservationId: "rsv_cf_pack_some",
						quantity: { value: "1", unit: "each" },
					},
					references: [],
				},
				{ principal },
			);
			expect(packed.outcome).toBe("packed_some");
			expect(packed.reservation.status).toBe("partially_packed");
			expect(packed.reservation.quantity.value).toBe("2");
			const again = await createReserveStock({
				store,
				now: () => new Date("2026-09-25T12:06:00.000Z"),
				createReservationId: () => "must_not_mint",
				createReceiptId: () => "must_not_write",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_reserve_some_retry",
					type: "stock.reserve",
					context: {
						siteId: "site_test",
						poolId,
						locationId: "location_north",
					},
					payload: {
						skuId: "sku_hat",
						quantity: { value: "3", unit: "each" },
						orderLine: { kind: "commerce.order_line", id: "OL-1842-some" },
					},
					references: [],
				},
				{ principal },
			);
			expect(again.outcome).toBe("existing");
			expect(again.reservation.reservationId).toBe("rsv_cf_pack_some");
			expect(again.reservation.quantity.value).toBe("2");
			expect(again.reservation.originalQuantity.value).toBe("3");
		});
	});
});
