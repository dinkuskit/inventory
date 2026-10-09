import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createHostedInventoryHandler } from "../../src/cloudflare/hosted-worker.ts";
import { createCheckoutInventoryPort } from "../../src/features/checkout-inventory/index.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

function packRequest(body) {
	return new Request("https://inventory.invalid/v1/stock/pack", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const packAllBody = {
	commandId: "pack_hats_and_shirts",
	type: "stock.pack_all",
	reservationIds: ["ticket_hat", "ticket_shirt"],
};

const packOneBody = {
	commandId: "pack_one_hat",
	type: "stock.pack",
	reservationId: "ticket_hat_only",
};

describe("hosted pack route", () => {
	it("rejects unauthenticated, unready, and foreign site or pool before pool I/O", async () => {
		const unauthenticated = createHostedInventoryHandler(env, async () => {
			throw new Error("unauthorized");
		});
		const unauthenticatedResponse = await unauthenticated(packRequest({
			...packAllBody,
			context: { siteId: "site_x", poolId: "pool_x" },
		}));
		expect(unauthenticatedResponse.status).toBe(401);
		expect(await unauthenticatedResponse.json()).toEqual({ error: "unauthorized" });

		const unready = createHostedInventoryHandler(env, async () => ({
			accountId: "acct_pack_unready",
			siteId: "site_pack_unready",
		}));
		const unreadyResponse = await unready(packRequest({
			...packOneBody,
			context: { siteId: "site_pack_unready", poolId: "pool_missing" },
		}));
		expect(unreadyResponse.status).toBe(409);
		expect((await unreadyResponse.json()).error).toBe("inventory_not_ready");

		const principal = { accountId: "acct_pack_authority", siteId: "site_pack_authority" };
		const connected = await env.INVENTORY_ACCOUNTS.getByName(principal.accountId).connectAccount(principal, {
			type: "create",
			requestId: "req_pack_authority",
			locationName: "Main",
		});
		expect(connected.status).toBe("ready");

		let poolReads = 0;
		const handler = createHostedInventoryHandler({
			...env,
			INVENTORY_POOLS: {
				getByName(name) {
					poolReads += 1;
					return env.INVENTORY_POOLS.getByName(name);
				},
			},
		}, async () => principal);

		const foreignSite = await handler(packRequest({
			...packAllBody,
			context: { siteId: "foreign_site", poolId: connected.operation.poolId },
		}));
		expect(foreignSite.status).toBe(403);
		expect(await foreignSite.json()).toEqual({ error: "unauthorized_context" });

		const foreignPool = await handler(packRequest({
			...packOneBody,
			siteId: principal.siteId,
			poolId: "foreign_pool",
		}));
		expect(foreignPool.status).toBe(403);
		expect(await foreignPool.json()).toEqual({ error: "unauthorized_context" });

		const delivered = await handler(packRequest({
			commandId: "deliver_hats",
			type: "stock.deliver",
			reservationIds: ["ticket_hat"],
		}));
		expect(delivered.status).toBe(400);
		expect(await delivered.json()).toEqual({ error: "invalid_request" });

		const orderNumber = await handler(packRequest({
			...packOneBody,
			orderNumber: "1001",
		}));
		expect(orderNumber.status).toBe(400);
		expect(await orderNumber.json()).toEqual({ error: "invalid_request" });
		expect(poolReads).toBe(0);
	});

	it("packs the tickets reserve already minted and does not mark them delivered", async () => {
		const principal = { accountId: "acct_pack_success", siteId: "site_pack_success" };
		const handler = createHostedInventoryHandler(env, async () => principal);
		const connected = await env.INVENTORY_ACCOUNTS.getByName(principal.accountId).connectAccount(principal, {
			type: "create",
			requestId: "req_pack_success",
			locationName: "Main",
		});
		expect(connected.status).toBe("ready");
		const pool = env.INVENTORY_POOLS.getByName(connected.operation.poolId);
		const binding = {
			providerRef: "dinkuskit.inventory",
			poolId: connected.operation.poolId,
			defaultFulfillmentLocationId: connected.operation.locationId,
		};
		const actor = {
			kind: "human",
			id: principal.accountId,
			displayName: "Site Administrator",
			surface: "emdash",
		};
		const held = await runInDurableObject(pool, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: connected.operation.poolId,
			});
			await createFixtureManagedSku(store, { poolId: connected.operation.poolId, skuId: "sku_hat" });
			await createFixtureManagedSku(store, { poolId: connected.operation.poolId, skuId: "sku_shirt" });
			for (const [skuId, quantity] of [["sku_hat", "10"], ["sku_shirt", "4"]]) {
				const opening = await createSetOpeningBalance({
					store,
					now: () => new Date("2026-10-08T15:00:00.000Z"),
					createReceiptId: () => `rcpt_opening_${skuId}`,
				})({
					schema: "dinkuskit.inventory.command/v1",
					commandId: `cmd_opening_${skuId}`,
					type: "stock.opening_balance",
					context: {
						siteId: principal.siteId,
						poolId: connected.operation.poolId,
						locationId: connected.operation.locationId,
					},
					payload: { skuId, quantity: { value: quantity, unit: "each" } },
					reason: { code: "opening_balance", note: "Set Initial Stock" },
					references: [],
					expectedVersions: [{ skuId, locationId: connected.operation.locationId, version: "0" }],
				}, { principal: actor });
				if (opening.outcome !== "committed") throw new Error(opening.code);
			}
			const names = ["ticket_hat", "ticket_shirt", "ticket_hat_only"];
			let next = 0;
			const port = createCheckoutInventoryPort({
				store,
				binding,
				now: () => new Date("2026-10-08T16:00:00.000Z"),
				createReservationId: () => names[next++],
				createReceiptId: () => `rcpt_reserve_${next}`,
				principal: actor,
				siteId: principal.siteId,
			});
			return {
				basket: await port.reserve({
					operationId: "op_hats_and_shirts",
					binding,
					requirements: [
						{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
						{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
					],
				}),
				hatOnly: await port.reserve({
					operationId: "op_hat_only",
					binding,
					requirements: [
						{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
					],
				}),
			};
		});
		expect(held.basket).toEqual({
			outcome: "reserved",
			ticketIds: ["ticket_hat", "ticket_shirt"],
		});
		expect(held.hatOnly).toEqual({
			outcome: "reserved",
			ticketIds: ["ticket_hat_only"],
		});

		const packedAll = await handler(packRequest(packAllBody));
		expect(packedAll.status).toBe(200);
		const packedAllResult = await packedAll.json();
		expect(packedAllResult.outcome).toBe("packed_all");
		expect(packedAllResult.reservations.map((ticket) => ticket.status)).toEqual(["packed", "packed"]);
		expect(packedAllResult.reservations.map((ticket) => ticket.originalQuantity.value).sort()).toEqual(["2", "3"]);
		expect(packedAllResult.reservations.map((ticket) => ticket.quantity.value)).toEqual(["0", "0"]);
		expect(JSON.stringify(packedAllResult)).not.toContain("orderNumber");
		expect(JSON.stringify(packedAllResult)).not.toContain("delivered");

		const replay = await handler(packRequest(packAllBody));
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual(packedAllResult);

		const packedOne = await handler(packRequest(packOneBody));
		expect(packedOne.status).toBe(200);
		const packedOneResult = await packedOne.json();
		expect(packedOneResult.outcome).toBe("packed");
		expect(packedOneResult.reservation.reservationId).toBe("ticket_hat_only");
		expect(packedOneResult.reservation.status).toBe("packed");
		expect(packedOneResult.reservation.originalQuantity.value).toBe("3");
		expect(packedOneResult.reservation.quantity.value).toBe("0");

		const delivered = await handler(packRequest({
			commandId: "deliver_hats",
			type: "stock.deliver",
			reservationIds: ["ticket_hat", "ticket_shirt"],
		}));
		expect(delivered.status).toBe(400);

		const rows = await runInDurableObject(pool, async (_instance, state) =>
			state.storage.sql.exec(
				"SELECT reservation_id, status FROM inventory_reservations ORDER BY reservation_id",
			).toArray(),
		);
		expect(rows).toEqual([
			{ reservation_id: "ticket_hat", status: "packed" },
			{ reservation_id: "ticket_hat_only", status: "packed" },
			{ reservation_id: "ticket_shirt", status: "packed" },
		]);
	});
	it("refuses tickets another site reserved in the same pool and packs nothing", async () => {
		const principal = { accountId: "acct_pack_shared", siteId: "site_pack_shared" };
		const handler = createHostedInventoryHandler(env, async () => principal);
		const connected = await env.INVENTORY_ACCOUNTS.getByName(principal.accountId).connectAccount(principal, {
			type: "create",
			requestId: "req_pack_shared",
			locationName: "Main",
		});
		expect(connected.status).toBe("ready");
		const pool = env.INVENTORY_POOLS.getByName(connected.operation.poolId);
		const binding = {
			providerRef: "dinkuskit.inventory",
			poolId: connected.operation.poolId,
			defaultFulfillmentLocationId: connected.operation.locationId,
		};
		const actor = { kind: "human", id: principal.accountId, displayName: "Site Administrator", surface: "emdash" };
		await runInDurableObject(pool, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({ storage: state.storage, poolId: connected.operation.poolId });
			await createFixtureManagedSku(store, { poolId: connected.operation.poolId, skuId: "sku_hat" });
			const opening = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-10-08T15:00:00.000Z"),
				createReceiptId: () => "rcpt_opening_shared",
			})({
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_opening_shared",
				type: "stock.opening_balance",
				context: { siteId: principal.siteId, poolId: connected.operation.poolId, locationId: connected.operation.locationId },
				payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{ skuId: "sku_hat", locationId: connected.operation.locationId, version: "0" }],
			}, { principal: actor });
			if (opening.outcome !== "committed") throw new Error(opening.code);
			for (const [siteId, ticket] of [[principal.siteId, "ticket_own_hat"], ["site_other_shop", "ticket_other_hat"]]) {
				const port = createCheckoutInventoryPort({
					store,
					binding,
					now: () => new Date("2026-10-08T16:00:00.000Z"),
					createReservationId: () => ticket,
					createReceiptId: () => `rcpt_reserve_${ticket}`,
					principal: actor,
					siteId,
				});
				const held = await port.reserve({
					operationId: `op_${ticket}`,
					binding,
					requirements: [{ skuId: "sku_hat", quantity: 1, allowBackorders: false }],
				});
				if (held.outcome !== "reserved") throw new Error("reserve failed");
			}
		});

		const foreignOne = await handler(packRequest({ commandId: "pack_other_hat", type: "stock.pack", reservationId: "ticket_other_hat" }));
		expect(foreignOne.status).toBe(403);
		expect(await foreignOne.json()).toEqual({ error: "unauthorized_ticket" });

		const mixed = await handler(packRequest({
			commandId: "pack_own_and_other",
			type: "stock.pack_all",
			reservationIds: ["ticket_own_hat", "ticket_other_hat"],
		}));
		expect(mixed.status).toBe(403);
		expect(await mixed.json()).toEqual({ error: "unauthorized_ticket" });

		const missing = await handler(packRequest({ commandId: "pack_missing_hat", type: "stock.pack", reservationId: "ticket_never_minted" }));
		expect(missing.status).toBe(403);
		expect(await missing.json()).toEqual({ error: "unauthorized_ticket" });

		const ownAndMissing = await handler(packRequest({
			commandId: "pack_own_and_missing",
			type: "stock.pack_all",
			reservationIds: ["ticket_own_hat", "ticket_never_minted"],
		}));
		expect(ownAndMissing.status).toBe(403);
		expect(await ownAndMissing.json()).toEqual({ error: "unauthorized_ticket" });

		const rows = await runInDurableObject(pool, async (_instance, state) =>
			state.storage.sql.exec(
				"SELECT reservation_id, status FROM inventory_reservations ORDER BY reservation_id",
			).toArray(),
		);
		const refusedCommands = await runInDurableObject(pool, async (_instance, state) =>
			state.storage.sql.exec(
				"SELECT command_id FROM inventory_command_results WHERE command_id LIKE 'pack_%'",
			).toArray(),
		);
		expect(refusedCommands).toEqual([]);
		expect(rows).toEqual([
			{ reservation_id: "ticket_other_hat", status: "not_shipped" },
			{ reservation_id: "ticket_own_hat", status: "not_shipped" },
		]);

		const own = await handler(packRequest({ commandId: "pack_own_hat", type: "stock.pack", reservationId: "ticket_own_hat" }));
		expect(own.status).toBe(200);
		expect((await own.json()).reservation.status).toBe("packed");
	});
});
