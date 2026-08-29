import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createReadReceiptHistory } from "../../src/application/read-inventory.ts";
import {
	createConfirmStockAdjustment,
	createPreviewStockAdjustment,
} from "../../src/features/stock-adjustment/index.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_adjustment",
	displayName: "Adjustment Operator",
	surface: "emdash",
});

describe("stock adjustment Cloudflare parity", () => {
	it("commits the same oversell receipt atomically without a schema migration", async ({ expect }) => {
		const poolId = "pool_stock_adjustment_parity";
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
				now: () => new Date("2026-08-29T10:00:00.000Z"),
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
			state.storage.sql
				.exec(
					`UPDATE inventory_balances
					 SET reserved_value = '8', available_value = '2'
					 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
					poolId,
					"location_north",
					"sku_hat",
				)
				.toArray();

			const input = {
				schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1",
				type: "stock.adjust",
				context: { siteId: "site_test", poolId, locationId: "location_north" },
				payload: { skuId: "sku_hat", delta: { value: "-5", unit: "each" } },
				reason: { note: "Five hats damaged" },
				references: [],
			};
			const preview = await createPreviewStockAdjustment({
				store,
				now: () => new Date("2026-08-29T12:00:00.000Z"),
				createConfirmation: () => "confirm_cf_adjustment",
			})(input, { principal });
			expect(preview.warnings[0]).toMatchObject({
				code: "negative_available",
				oversoldBy: { value: "3", unit: "each" },
			});
			const command = {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_cf_adjustment",
				type: input.type,
				context: input.context,
				payload: input.payload,
				reason: input.reason,
				references: input.references,
				expectedVersions: [
					{ skuId: "sku_hat", locationId: "location_north", version: "1" },
				],
			};
			const confirm = createConfirmStockAdjustment({
				store,
				now: () => new Date("2026-08-29T12:00:01.000Z"),
				createReceiptId: () => "rcpt_cf_adjustment",
			});
			const result = await confirm(preview.confirmation.value, command, { principal });
			expect(result.outcome).toBe("committed");
			expect(await confirm(preview.confirmation.value, command, { principal })).toEqual(result);
			expect(await store.readBalance({
				poolId,
				locationId: "location_north",
				skuId: "sku_hat",
			})).toMatchObject({
				onHand: { value: "5", unit: "each" },
				reserved: { value: "8", unit: "each" },
				available: { value: "-3", unit: "each" },
				version: "2",
			});
			const history = await createReadReceiptHistory({ store })({
				poolId,
				scope: { kind: "location", locationId: "location_north" },
			});
			expect(history.receipts.map((receipt) => receipt.type)).toEqual([
				"stock.adjust",
				"stock.opening_balance",
			]);
			expect(
				state.storage.sql
					.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
					.toArray()
					.map((row) => Number(row.version)),
			).toEqual([4]);
		});
	});
});
