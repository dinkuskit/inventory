import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createReadSkuLocationBalance } from "../../src/application/read-inventory.ts";
import {
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
});
