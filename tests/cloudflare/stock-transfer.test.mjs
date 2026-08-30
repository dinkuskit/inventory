import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import {
	createConfirmOpeningBalance,
	createPreviewOpeningBalance,
} from "../../src/application/preview-confirm-opening-balance.ts";
import { createReadReceiptHistory } from "../../src/application/read-inventory.ts";
import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import {
	createExecuteStockTransferCommand,
	createReadStockTransfer,
} from "../../src/features/stock-transfer/index.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_transfer_cloudflare",
	displayName: "Cloudflare Transfer Operator",
	surface: "emdash",
});

describe("stock transfer Cloudflare parity", () => {
	it("persists Created commitments, expected stock, receipt, and replay in one transaction", async ({ expect }) => {
		const poolId = "pool_stock_transfer_parity";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureLocation(store, {
				poolId,
				locationId: "location_origin",
				name: "Origin",
			});
			await createFixtureLocation(store, {
				poolId,
				locationId: "location_destination",
				name: "Destination",
			});
			await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
			await createSetOpeningBalance({
				store,
				now: () => new Date("2026-08-29T10:00:00.000Z"),
				createReceiptId: () => "rcpt_cf_transfer_opening",
			})(
				{
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_cf_transfer_opening",
					type: "stock.opening_balance",
					context: { siteId: "site_test", poolId, locationId: "location_origin" },
					payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
					reason: { code: "opening_balance", note: "Set Initial Stock" },
					references: [],
					expectedVersions: [
						{ skuId: "sku_hat", locationId: "location_origin", version: "0" },
					],
				},
				{ principal },
			);

			let ids = 0;
			let receipts = 0;
			const execute = createExecuteStockTransferCommand({
				store,
				now: () => new Date("2026-08-29T12:00:00.000Z"),
				createTransferId: () => {
					ids += 1;
					return "transfer_cf_hat";
				},
				createTransferReference: () => "ST-147",
				createReceiptId: () => {
					receipts += 1;
					return `rcpt_cf_transfer_${receipts}`;
				},
			});
			const command = {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_cf_transfer",
				type: "transfer.create",
				context: { siteId: "site_test", poolId },
				payload: {
					reference: null,
					originLocationId: "location_origin",
					destinationLocationId: "location_destination",
					lines: [{ skuId: "sku_hat", quantity: { value: "4", unit: "each" } }],
					note: "Restock",
					expectedDispatchDate: "2026-09-01",
					expectedArrivalDate: "2026-09-03",
				},
				references: [],
				expectedVersions: [],
			};
			const first = await execute(command, { principal });
			const replay = await execute(command, { principal });

			expect(first.outcome).toBe("committed");
			expect(replay).toEqual(first);
			expect({ ids, receipts }).toEqual({ ids: 1, receipts: 1 });
			expect(await store.readBalance({ poolId, locationId: "location_origin", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "10", unit: "each" },
				outgoingTransferCommitted: { value: "4", unit: "each" },
				available: { value: "6", unit: "each" },
			});
			expect(await store.readBalance({ poolId, locationId: "location_destination", skuId: "sku_hat" })).toMatchObject({
				expected: { value: "4", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			});
			const preview = await createPreviewOpeningBalance({
				store,
				now: () => new Date("2026-08-29T12:01:00.000Z"),
				createConfirmation: () => "confirm_cf_destination_opening",
			})({
				schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
				type: "stock.opening_balance",
				context: {
					siteId: "site_test",
					poolId,
					locationId: "location_destination",
				},
				payload: { skuId: "sku_hat", quantity: { value: "3", unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
			}, { principal });
			expect(preview.effect.balanceBefore).toMatchObject({
				expected: { value: "4", unit: "each" },
				version: "1",
			});
			const destinationOpening = await createConfirmOpeningBalance({
				store,
				now: () => new Date("2026-08-29T12:02:00.000Z"),
				createReceiptId: () => "rcpt_cf_destination_opening",
			})(preview.confirmation.value, {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_cf_destination_opening",
				type: "stock.opening_balance",
				context: {
					siteId: "site_test",
					poolId,
					locationId: "location_destination",
				},
				payload: { skuId: "sku_hat", quantity: { value: "3", unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{
					skuId: "sku_hat",
					locationId: "location_destination",
					version: preview.effect.balanceBefore.version,
				}],
			}, { principal });
			expect(destinationOpening.outcome).toBe("committed");
			expect(await store.readBalance({ poolId, locationId: "location_destination", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "3", unit: "each" },
				expected: { value: "4", unit: "each" },
				version: "2",
				hasStockHistory: true,
			});

			const updated = await execute({
				...command,
				commandId: "cmd_cf_transfer_update",
				type: "transfer.update",
				payload: {
					...command.payload,
					transferId: first.transfer.transferId,
					reference: first.transfer.reference,
					lines: [{ skuId: "sku_hat", quantity: { value: "5", unit: "each" } }],
					note: "Restock updated",
				},
				expectedVersions: [{
					transferId: first.transfer.transferId,
					version: first.transfer.version,
				}],
			}, { principal });
			expect(updated.outcome).toBe("committed");
			expect(await store.readBalance({ poolId, locationId: "location_destination", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "3", unit: "each" },
				expected: { value: "5", unit: "each" },
			});
			const dispatched = await execute({
				schema: command.schema,
				commandId: "cmd_cf_transfer_dispatch",
				type: "transfer.dispatch",
				context: command.context,
				payload: { transferId: updated.transfer.transferId },
				references: [],
				expectedVersions: [{
					transferId: updated.transfer.transferId,
					version: updated.transfer.version,
				}],
			}, { principal });
			expect(dispatched).toMatchObject({
				outcome: "committed",
				transfer: {
					status: "in_transit",
					dispatchedDate: "2026-08-29T12:00:00.000Z",
				},
				receipt: {
					type: "transfer.dispatch",
					committedAt: "2026-08-29T12:00:00.000Z",
					principal,
				},
			});
			expect(await store.readBalance({ poolId, locationId: "location_origin", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "5", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
			});
			expect(await store.readBalance({ poolId, locationId: "location_destination", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "3", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "5", unit: "each" },
			});
			const reopened = await execute({
				schema: command.schema,
				commandId: "cmd_cf_transfer_reopen",
				type: "transfer.reopen",
				context: command.context,
				payload: {
					transferId: dispatched.transfer.transferId,
					reason: null,
				},
				references: [],
				expectedVersions: [{
					transferId: dispatched.transfer.transferId,
					version: dispatched.transfer.version,
				}],
			}, { principal });
			expect(reopened).toMatchObject({
				outcome: "committed",
				transfer: { status: "created", dispatchedDate: null },
				receipt: { type: "transfer.reopen", reason: null, principal },
			});
			expect(await store.readBalance({ poolId, locationId: "location_origin", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "10", unit: "each" },
				outgoingTransferCommitted: { value: "5", unit: "each" },
			});
			expect(await store.readBalance({ poolId, locationId: "location_destination", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "3", unit: "each" },
				expected: { value: "5", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			});
			const history = await createReadReceiptHistory({ store })({
				poolId,
				scope: { kind: "location", locationId: "location_origin" },
			});
			expect(history.receipts.slice(0, 2).map((receipt) => receipt.type)).toEqual([
				"transfer.reopen",
				"transfer.dispatch",
			]);
			const canceled = await execute({
				schema: command.schema,
				commandId: "cmd_cf_transfer_cancel",
				type: "transfer.cancel",
				context: command.context,
				payload: { transferId: reopened.transfer.transferId },
				references: [],
				expectedVersions: [{
					transferId: reopened.transfer.transferId,
					version: reopened.transfer.version,
				}],
			}, { principal });
			expect(canceled.outcome).toBe("committed");
			expect(await store.readBalance({ poolId, locationId: "location_destination", skuId: "sku_hat" })).toMatchObject({
				onHand: { value: "3", unit: "each" },
				expected: { value: "0", unit: "each" },
			});
			expect(await createReadStockTransfer({ store })({
				poolId,
				transferId: "transfer_cf_hat",
			})).toMatchObject({
				outcome: "found",
				transfer: { reference: "ST-147", status: "canceled" },
			});
			expect(await store.readReceipt("rcpt_cf_transfer_1")).toEqual(first.receipt);
			expect(
				state.storage.sql
					.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
					.toArray()
					.map((row) => Number(row.version)),
			).toEqual([4]);
		});
	});

	it("receives every line with physical history, scoped audit, replay, and rollback parity", async ({ expect }) => {
		const poolId = "pool_stock_transfer_receive_parity";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await createFixtureLocation(store, {
				poolId,
				locationId: "location_origin",
				name: "Origin",
			});
			await createFixtureLocation(store, {
				poolId,
				locationId: "location_destination",
				name: "Destination",
			});
			for (const [skuId, quantity] of [
				["sku_hat", "10"],
				["sku_shirt", "7"],
			]) {
				await createFixtureManagedSku(store, { poolId, skuId });
				const opened = await createSetOpeningBalance({
					store,
					now: () => new Date("2026-08-30T08:00:00.000Z"),
					createReceiptId: () => `rcpt_cf_receive_opening_${skuId}`,
				})({
					schema: "dinkuskit.inventory.command/v1",
					commandId: `cmd_cf_receive_opening_${skuId}`,
					type: "stock.opening_balance",
					context: {
						siteId: "site_test",
						poolId,
						locationId: "location_origin",
					},
					payload: { skuId, quantity: { value: quantity, unit: "each" } },
					reason: { code: "opening_balance", note: "Set Initial Stock" },
					references: [],
					expectedVersions: [{
						skuId,
						locationId: "location_origin",
						version: "0",
					}],
				}, { principal });
				expect(opened.outcome).toBe("committed");
			}

			let currentTime = "2026-08-30T09:00:00.000Z";
			let ids = 0;
			let receipts = 0;
			const execute = createExecuteStockTransferCommand({
				store,
				now: () => new Date(currentTime),
				createTransferId: () => `transfer_cf_received_${++ids}`,
				createTransferReference: () => `ST-CF-${ids + 1}`,
				createReceiptId: () => `rcpt_cf_receive_${++receipts}`,
			});
			const createCommand = (commandId, reference, lines) => ({
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "transfer.create",
				context: { siteId: "site_test", poolId },
				payload: {
					reference,
					originLocationId: "location_origin",
					destinationLocationId: "location_destination",
					lines,
					note: "Cloudflare whole receipt",
					expectedDispatchDate: "2026-09-01",
					expectedArrivalDate: "2026-09-03",
				},
				references: [],
				expectedVersions: [],
			});
			const transition = (type, transfer, commandId) => ({
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type,
				context: { siteId: "site_test", poolId },
				payload: { transferId: transfer.transferId },
				references: [],
				expectedVersions: [{
					transferId: transfer.transferId,
					version: transfer.version,
				}],
			});

			const created = await execute(createCommand(
				"cmd_cf_receive_create",
				"ST-CF-RECEIVE",
				[
					{ skuId: "sku_shirt", quantity: { value: "3", unit: "each" } },
					{ skuId: "sku_hat", quantity: { value: "4", unit: "each" } },
				],
			), { principal });
			currentTime = "2026-08-30T10:15:00.000Z";
			const dispatched = await execute(
				transition(
					"transfer.dispatch",
					created.transfer,
					"cmd_cf_receive_dispatch",
				),
				{ principal },
			);
			const originBefore = await Promise.all([
				store.readBalance({
					poolId,
					locationId: "location_origin",
					skuId: "sku_hat",
				}),
				store.readBalance({
					poolId,
					locationId: "location_origin",
					skuId: "sku_shirt",
				}),
			]);
			currentTime = "2026-08-30T12:34:56.000Z";
			const receiveCommand = transition(
				"transfer.receive",
				dispatched.transfer,
				"cmd_cf_receive_commit",
			);
			const received = await execute(receiveCommand, { principal });
			expect(received).toMatchObject({
				outcome: "committed",
				transfer: {
					status: "received",
					dispatchedDate: "2026-08-30T10:15:00.000Z",
					receivedDate: "2026-08-30T12:34:56.000Z",
					version: "3",
				},
				receipt: {
					type: "transfer.receive",
					committedAt: "2026-08-30T12:34:56.000Z",
					principal,
				},
				warnings: [],
			});
			expect("reason" in received.receipt).toBe(false);
			expect(received.receipt.effects.map((effect) => effect.locationId)).toEqual([
				"location_destination",
				"location_destination",
			]);
			expect(await Promise.all([
				store.readBalance({
					poolId,
					locationId: "location_origin",
					skuId: "sku_hat",
				}),
				store.readBalance({
					poolId,
					locationId: "location_origin",
					skuId: "sku_shirt",
				}),
			])).toEqual(originBefore);
			expect(await store.readBalance({
				poolId,
				locationId: "location_destination",
				skuId: "sku_hat",
			})).toMatchObject({
				onHand: { value: "4", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
				hasStockHistory: true,
			});
			expect(await store.readBalance({
				poolId,
				locationId: "location_destination",
				skuId: "sku_shirt",
			})).toMatchObject({
				onHand: { value: "3", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
				hasStockHistory: true,
			});
			currentTime = "2026-08-31T00:00:00.000Z";
			expect(await execute(receiveCommand, { principal })).toEqual(received);
			expect({ ids, receipts }).toEqual({ ids: 1, receipts: 3 });
			const destinationHistory = await createReadReceiptHistory({ store })({
				poolId,
				scope: { kind: "location", locationId: "location_destination" },
			});
			expect(
				destinationHistory.receipts.slice(0, 3).map((receipt) => receipt.type),
			).toEqual(["transfer.receive", "transfer.dispatch", "transfer.create"]);
			const originHistory = await createReadReceiptHistory({ store })({
				poolId,
				scope: { kind: "location", locationId: "location_origin" },
			});
			expect(
				originHistory.receipts.some((receipt) => receipt.type === "transfer.receive"),
			).toBe(false);
			expect(await createReadStockTransfer({ store })({
				poolId,
				transferId: received.transfer.transferId,
			})).toMatchObject({
				outcome: "found",
				transfer: {
					status: "received",
					receivedDate: "2026-08-30T12:34:56.000Z",
				},
			});

			currentTime = "2026-08-31T01:00:00.000Z";
			const secondCreated = await execute(createCommand(
				"cmd_cf_receive_second_create",
				"ST-CF-ROLLBACK",
				[{ skuId: "sku_hat", quantity: { value: "1", unit: "each" } }],
			), { principal });
			currentTime = "2026-08-31T02:00:00.000Z";
			const secondDispatched = await execute(
				transition(
					"transfer.dispatch",
					secondCreated.transfer,
					"cmd_cf_receive_second_dispatch",
				),
				{ principal },
			);
			const beforeFailedReceive = await store.readBalance({
				poolId,
				locationId: "location_destination",
				skuId: "sku_hat",
			});
			const failOnExistingReceipt = createExecuteStockTransferCommand({
				store,
				now: () => new Date("2026-08-31T03:00:00.000Z"),
				createTransferId: () => "transfer_should_not_exist",
				createTransferReference: () => "ST-SHOULD-NOT-EXIST",
				createReceiptId: () => received.receipt.receiptId,
			});
			await expect(failOnExistingReceipt(
				transition(
					"transfer.receive",
					secondDispatched.transfer,
					"cmd_cf_receive_collision",
				),
				{ principal },
			)).rejects.toThrow();
			expect(await store.readBalance({
				poolId,
				locationId: "location_destination",
				skuId: "sku_hat",
			})).toEqual(beforeFailedReceive);
			expect(await createReadStockTransfer({ store })({
				poolId,
				transferId: secondDispatched.transfer.transferId,
			})).toMatchObject({
				outcome: "found",
				transfer: { status: "in_transit" },
			});
			expect(await store.readCommand("cmd_cf_receive_collision")).toBeNull();
			expect(
				state.storage.sql
					.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
					.toArray()
					.map((row) => Number(row.version)),
			).toEqual([4]);
		});
	});
});
