import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createHostedInventoryHandler } from "../../src/cloudflare/hosted-worker.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";
import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";

const SYNTHETIC_SKU = "sku_synthetic_hat";

describe("hosted stock read and adjustment in SQLite Durable Objects", () => {
	it("fails closed on unauthenticated or wrong-site requests", async () => {
		const unauthHandler = createHostedInventoryHandler(env, async () => {
			throw new Error("unauthorized");
		});

		const stockReq = new Request("https://inventory.invalid/v1/stock?sku_id=" + SYNTHETIC_SKU);
		const unauthStock = await unauthHandler(stockReq);
		expect(unauthStock.status).toBe(401);
		expect(await unauthStock.json()).toEqual({ error: "unauthorized" });

		const previewReq = new Request("https://inventory.invalid/v1/stock/adjust/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				locationId: "loc_main",
				skuId: SYNTHETIC_SKU,
				delta: { value: "5", unit: "each" },
				reason: { note: "Restock" },
			}),
		});
		const unauthPreview = await unauthHandler(previewReq);
		expect(unauthPreview.status).toBe(401);

		// Authenticated but account connection unconnected
		const unconnectedHandler = createHostedInventoryHandler(env, async () => ({
			accountId: "acct_unconnected",
			siteId: "site_unconnected",
		}));
		const notReadyStock = await unconnectedHandler(stockReq);
		expect(notReadyStock.status).toBe(409);
		const notReadyJson = await notReadyStock.json();
		expect(notReadyJson.error).toBe("inventory_not_ready");
	});

	it("reads canonical stock, previews adjustment, confirms with idempotency, and rejects foreign contexts", async () => {
		const principal = { accountId: "acct_stock_test", siteId: "site_stock_test" };
		const account = env.INVENTORY_ACCOUNTS.getByName(principal.accountId);

		// Connect account and create initial location
		const connectResult = await account.connectAccount(principal, {
			type: "create",
			requestId: "req_conn_1",
			locationName: "Main Warehouse",
		});
		expect(connectResult.status).toBe("ready");
		const operation = connectResult.operation;
		const poolId = operation.poolId;
		const locationId = operation.locationId;
		expect(locationId).toBeTruthy();

		const pool = env.INVENTORY_POOLS.getByName(poolId);

		// Seed managed SKU and opening balance in pool
		await runInDurableObject(pool, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureManagedSku(store, { poolId, skuId: SYNTHETIC_SKU });
			const opening = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-09-30T10:00:00.000Z"),
				createReceiptId: () => "rcpt_seed_opening",
			})({
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_seed_opening",
				type: "stock.opening_balance",
				context: { siteId: principal.siteId, poolId, locationId },
				payload: { skuId: SYNTHETIC_SKU, quantity: { value: "10", unit: "each" } },
				reason: { code: "opening_balance", note: "Initial stock" },
				references: [],
				expectedVersions: [
					{ skuId: SYNTHETIC_SKU, locationId, version: "0" },
				],
			}, {
				principal: { kind: "human", id: principal.accountId, displayName: "Admin", surface: "emdash" },
			});
			expect(opening.outcome).toBe("committed");
		});

		const handler = createHostedInventoryHandler(env, async () => principal);

		// 1. Read stock balance via GET /v1/stock
		const stockRes = await handler(new Request(`https://inventory.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`));
		expect(stockRes.status).toBe(200);
		const stockData = await stockRes.json();
		expect(stockData.ok).toBe(true);
		expect(stockData.balance.outcome).toBe("found");
		expect(stockData.balance.balance.onHand.value).toBe("10");
		expect(stockData.balance.balance.available.value).toBe("10");
		expect(stockData.balance.balance.version).toBe("1");

		// 2. Preview signed-delta adjustment via POST /v1/stock/adjust/preview
		const previewRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				locationId,
				skuId: SYNTHETIC_SKU,
				delta: { value: "-3", unit: "each" },
				reason: { note: "Damaged inventory" },
			}),
		}));
		expect(previewRes.status).toBe(200);
		const preview = await previewRes.json();
		expect(preview.schema).toBe("dinkuskit.inventory.stock-adjustment-preview/v1");
		expect(preview.effect.balanceBefore.onHand.value).toBe("10");
		expect(preview.effect.balanceAfter.onHand.value).toBe("7");
		expect(preview.confirmation.value).toBeTruthy();

		// 3. Confirm adjustment with matching context
		const commandId = "cmd_adjust_001";
		const confirmPayload = {
			confirmation: preview.confirmation.value,
			command: {
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.adjust",
				context: {
					siteId: principal.siteId,
					poolId,
					locationId,
				},
				payload: {
					skuId: SYNTHETIC_SKU,
					delta: { value: "-3", unit: "each" },
				},
				reason: { note: "Damaged inventory" },
				references: [],
				expectedVersions: [
					{ skuId: SYNTHETIC_SKU, locationId, version: "1" },
				],
			},
		};

		// Test: Tampered siteId or poolId rejected with 403 unauthorized_context
		const tamperedRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...confirmPayload,
				command: {
					...confirmPayload.command,
					context: {
						...confirmPayload.command.context,
						siteId: "foreign_site",
					},
				},
			}),
		}));
		expect(tamperedRes.status).toBe(403);
		expect(await tamperedRes.json()).toEqual({ error: "unauthorized_context" });

		// Confirm with authentic context
		const confirmRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(confirmPayload),
		}));
		expect(confirmRes.status).toBe(200);
		const confirmData = await confirmRes.json();
		expect(confirmData.outcome).toBe("committed");
		expect(confirmData.commandId).toBe(commandId);
		expect(confirmData.receipt.receiptId).toBeTruthy();

		// Verify stock balance was reduced to 7
		const stockAfter = await handler(new Request(`https://inventory.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`));
		const stockAfterJson = await stockAfter.json();
		expect(stockAfterJson.balance.balance.onHand.value).toBe("7");
		expect(stockAfterJson.balance.balance.version).toBe("2");

		// 4. Exact retry: returns original receipt with NO second balance change
		const retryRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(confirmPayload),
		}));
		expect(retryRes.status).toBe(200);
		const retryData = await retryRes.json();
		expect(retryData.outcome).toBe("committed");
		expect(retryData.commandId).toBe(commandId);
		expect(retryData.receipt.receiptId).toBe(confirmData.receipt.receiptId);

		// Stock remains 7 (no second movement!)
		const stockAfterRetry = await handler(new Request(`https://inventory.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`));
		const stockAfterRetryJson = await stockAfterRetry.json();
		expect(stockAfterRetryJson.balance.balance.onHand.value).toBe("7");
		expect(stockAfterRetryJson.balance.balance.version).toBe("2");

		// 5. Changed contents under same commandId returns 409 command_id_conflict
		const conflictRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...confirmPayload,
				command: {
					...confirmPayload.command,
					payload: {
						skuId: SYNTHETIC_SKU,
						delta: { value: "-5", unit: "each" },
					},
				},
			}),
		}));
		expect(conflictRes.status).toBe(409);
		const conflictData = await conflictRes.json();
		expect(conflictData.outcome).toBe("rejected");
		expect(conflictData.code).toBe("command_id_conflict");

		// 5b. Stale version returns HTTP 409 canonical rejected StockAdjustmentResult
		// First generate preview while balance is at version "2"
		const stalePreviewRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				locationId,
				skuId: SYNTHETIC_SKU,
				delta: { value: "-1", unit: "each" },
				reason: { note: "Stale version test preview" },
			}),
		}));
		expect(stalePreviewRes.status).toBe(200);
		const stalePreviewData = await stalePreviewRes.json();
		expect(stalePreviewData.effect.balanceBefore.version).toBe("2");

		// Concurrent adjustment executes and advances balance version from 2 to 3!
		const concurrentPreviewRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/preview", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				locationId,
				skuId: SYNTHETIC_SKU,
				delta: { value: "+2", unit: "each" },
				reason: { note: "Concurrent adjustment" },
			}),
		}));
		const concurrentPreview = await concurrentPreviewRes.json();
		const concurrentConfirmRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				confirmation: concurrentPreview.confirmation.value,
				command: {
					schema: "dinkuskit.inventory.command/v1",
					commandId: `cmd_concurrent_${Date.now()}`,
					type: "stock.adjust",
					context: { siteId: principal.siteId, poolId, locationId },
					payload: { skuId: SYNTHETIC_SKU, delta: { value: "+2", unit: "each" } },
					reason: { note: "Concurrent adjustment" },
					references: [],
					expectedVersions: [{ skuId: SYNTHETIC_SKU, locationId, version: "2" }],
				},
			}),
		}));
		expect(concurrentConfirmRes.status).toBe(200);

		// Now confirm original preview which expected version "2", but balance is now "3"
		const staleCommandId = `cmd_stale_ver_${Date.now()}`;
		const staleConfirmPayload = {
			confirmation: stalePreviewData.confirmation.value,
			command: {
				schema: "dinkuskit.inventory.command/v1",
				commandId: staleCommandId,
				type: "stock.adjust",
				context: {
					siteId: principal.siteId,
					poolId,
					locationId,
				},
				payload: {
					skuId: stalePreviewData.effect.skuId,
					delta: stalePreviewData.effect.onHandDelta,
				},
				reason: stalePreviewData.reason,
				references: stalePreviewData.references,
				expectedVersions: [
					{ skuId: SYNTHETIC_SKU, locationId, version: "2" },
				],
			},
		};
		const staleConfirmRes = await handler(new Request("https://inventory.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(staleConfirmPayload),
		}));
		expect(staleConfirmRes.status).toBe(409);
		const staleConfirmData = await staleConfirmRes.json();
		expect(staleConfirmData.schema).toBe("dinkuskit.inventory.command-result/v1");
		expect(staleConfirmData.outcome).toBe("rejected");
		expect(staleConfirmData.commandId).toBe(staleCommandId);
		expect(staleConfirmData.code).toBe("stale_version");
		expect(typeof staleConfirmData.message).toBe("string");

		// 6. Read receipt history
		const receiptsRes = await handler(new Request(`https://inventory.invalid/v1/receipts?location_id=${locationId}`));
		expect(receiptsRes.status).toBe(200);
		const receiptsData = await receiptsRes.json();
		expect(receiptsData.receipts.length).toBeGreaterThanOrEqual(2); // opening + adjustment
		const adjustReceipt = receiptsData.receipts.find(r => r.receiptId === confirmData.receipt.receiptId);
		expect(adjustReceipt).toBeDefined();
		expect(adjustReceipt.receiptId).toBe(confirmData.receipt.receiptId);
	});
});
