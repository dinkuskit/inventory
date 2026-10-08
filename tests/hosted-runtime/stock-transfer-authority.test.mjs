import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { createHostedInventoryHandler } from "../../src/cloudflare/hosted-worker.ts";

function transferRequest(context) {
	return new Request("https://inventory.invalid/v1/transfers", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			command: {
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_transfer_forbidden",
				type: "transfer.create",
				context,
				payload: {
					reference: null,
					originLocationId: "loc_origin",
					destinationLocationId: "loc_destination",
					lines: [{ skuId: "sku_hat", quantity: { value: "1", unit: "each" } }],
					note: null,
					expectedDispatchDate: "2026-10-08",
					expectedArrivalDate: "2026-10-08",
				},
				references: [],
				expectedVersions: [],
			},
		}),
	});
}

describe("hosted transfer authority", () => {
	it("rejects unauthenticated, unready, and foreign site or pool before pool transfer I/O", async () => {
		const unauthenticated = createHostedInventoryHandler(env, async () => {
			throw new Error("unauthorized");
		});
		const unauthenticatedResponse = await unauthenticated(transferRequest({ siteId: "site_x", poolId: "pool_x" }));
		expect(unauthenticatedResponse.status).toBe(401);
		expect(await unauthenticatedResponse.json()).toEqual({ error: "unauthorized" });

		const unready = createHostedInventoryHandler(env, async () => ({
			accountId: "acct_transfer_unready",
			siteId: "site_transfer_unready",
		}));
		const unreadyResponse = await unready(transferRequest({ siteId: "site_transfer_unready", poolId: "pool_missing" }));
		expect(unreadyResponse.status).toBe(409);
		expect((await unreadyResponse.json()).error).toBe("inventory_not_ready");

		const principal = { accountId: "acct_transfer_authority", siteId: "site_transfer_authority" };
		const connected = await env.INVENTORY_ACCOUNTS.getByName(principal.accountId).connectAccount(principal, {
			type: "create",
			requestId: "req_transfer_authority",
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

		const foreignSite = await handler(transferRequest({
			siteId: "foreign_site",
			poolId: connected.operation.poolId,
		}));
		expect(foreignSite.status).toBe(403);
		expect(await foreignSite.json()).toEqual({ error: "unauthorized_context" });

		const foreignPool = await handler(transferRequest({
			siteId: principal.siteId,
			poolId: "foreign_pool",
		}));
		expect(foreignPool.status).toBe(403);
		expect(await foreignPool.json()).toEqual({ error: "unauthorized_context" });
		expect(poolReads).toBe(0);
	});
});
