import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createHostedInventoryHandler } from "../../src/cloudflare/hosted-worker.ts";

describe("hosted control plane in real SQLite Durable Objects", () => {
	it("fails closed until account configuration exists", async () => {
		const response = await exports.default.fetch(new Request("https://inventory.invalid/v1/status"));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "account_service_unconfigured" });
	});
	it("provisions once under concurrent retries, reconnects owned pools and preserves kernel receipts", async () => {
		const principal = { accountId: "test-owned-account", siteId: "test-site" };
		const account = env.INVENTORY_ACCOUNTS.getByName(principal.accountId);
		const input = { type: "create", requestId: "first-connect", locationName: "Test stock room" };
		const results = await Promise.all(Array.from({ length: 10 }, () => account.connectAccount(principal, input)));
		expect(results.every(result => result.status === "ready")).toBe(true);
		const operation = results[0].operation;
		expect(await account.operations()).toHaveLength(1);
		const pool = env.INVENTORY_POOLS.getByName(operation.poolId);
		const locations = await pool.listLocations(operation.poolId);
		expect(locations.locations).toHaveLength(1);
		expect(locations.locations[0].name).toBe(input.locationName);
		const counts = await pool.recordCounts();
		expect(counts.receipts).toBe(1);
		expect(counts.balances).toBe(0);
		expect(counts.commandResults).toBe(1);
		const reconnect = { type: "reconnect", requestId: "reconnect", operationId: operation.operationId };
		expect((await account.connectAccount({ ...principal, siteId: "reinstalled-site" }, reconnect)).operation).toEqual(operation);
		expect(await env.INVENTORY_ACCOUNTS.getByName("foreign-account").connectAccount({ accountId: "foreign-account", siteId: "foreign-site" }, reconnect)).toEqual({ status: "rejected", error: "operation_not_found" });
		expect(await account.connectAccount(principal, { ...input, locationName: "Changed" })).toEqual({ status: "rejected", error: "request_id_conflict" });
		// Control metadata can restart independently; canonical location and receipt remain intact.
		await runInDurableObject(account, async (instance, state) => {
			expect(state.storage.sql.exec("SELECT count(*) AS n FROM account_connections WHERE kind='operation'").one().n).toBe(1);
			// Model a pool commit whose acknowledgement did not persist in the control plane.
			const pending = { ...operation, status: "pending", locationId: null };
			state.storage.sql.exec("UPDATE account_connections SET value = ? WHERE kind='operation' AND id=?", JSON.stringify(pending), operation.operationId);
		});
		expect((await account.connectAccount({ ...principal, siteId: "reinstalled-site" }, reconnect)).status).toBe("ready");
		expect(await pool.recordCounts()).toEqual(counts);
	});
	it("HTTP never takes account ownership or pool selection from browser input", async () => {
		const principal = { accountId: "http-account", siteId: "http-site" };
		const handle = createHostedInventoryHandler(env, async () => principal);
		const request = body => new Request("https://inventory.invalid/v1/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		expect((await handle(request({ type: "create", requestId: "one", locationName: "North", accountId: "foreign" }))).status).toBe(400);
		expect((await handle(request({ type: "reconnect", requestId: "two", operationId: "arbitrary" }))).status).toBe(404);
		expect((await handle(request({ type: "create", requestId: "three", locationName: "North" }))).status).toBe(200);
		expect((await handle(request({ type: "create", requestId: "four", locationName: "South" }))).status).toBe(409);
		expect((await handle(new Request("https://inventory.invalid/v1/locations"))).status).toBe(200);
		expect((await handle(request({ type: "create", requestId: "x".repeat(5000), locationName: "North" }))).status).toBe(413);
		expect((await createHostedInventoryHandler(env, async () => { throw new Error("bad token"); })(new Request("https://inventory.invalid/v1/status"))).status).toBe(401);
	});
});
