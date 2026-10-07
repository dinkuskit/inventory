import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccountAuthenticator } from "../../src/cloudflare/account-auth.ts";
import { createAccountOverviewVerifier } from "../../src/cloudflare/account-overview-auth.ts";
import { createHostedInventoryHandler } from "../../src/cloudflare/hosted-worker.ts";

describe("hosted control plane in real SQLite Durable Objects", () => {
	it("fails closed until account configuration exists", async () => {
		const response = await exports.default.fetch(new Request("https://inventory.invalid/v1/status"));
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "account_service_unconfigured" });
		const overviewResponse = await exports.default.fetch(new Request("https://inventory.invalid/v1/account-overview"));
		expect(overviewResponse.status).toBe(503);
		expect(await overviewResponse.json()).toMatchObject({
			error: "account_service_unconfigured",
			overview: { metadata: { availability: "unavailable", reason: "service_unconfigured" }, counts: null, pools: null, sites: null },
		});
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
	it("projects account metadata without reading stock or live pool health", async () => {
		const account = env.INVENTORY_ACCOUNTS.getByName("overview-account");
		const first = await account.connectAccount(
			{ accountId: "overview-account", siteId: "overview-site-one" },
			{ type: "create", requestId: "overview-one", locationName: "Private location one" },
		);
		expect(first.status).toBe("ready");
		const second = await account.connectAccount(
			{ accountId: "overview-account", siteId: "overview-site-two" },
			{ type: "reconnect", requestId: "overview-two", operationId: first.operation.operationId },
		);
		expect(second.status).toBe("ready");
		const third = await account.connectAccount(
			{ accountId: "overview-account", siteId: "overview-site-three" },
			{ type: "create", requestId: "overview-three", locationName: "Private location three" },
		);
		expect(third.status).toBe("ready");

		await runInDurableObject(account, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE account_connections SET value = json_set(value, '$.status', 'pending', '$.locationId', NULL) WHERE kind='operation' AND id=?",
				third.operation.operationId,
			);
			state.storage.sql.exec(
				"UPDATE account_connections SET value = json_set(value, '$.status', 'failed', '$.failureCode', 'provisioning_failed') WHERE kind='operation' AND id=?",
				first.operation.operationId,
			);
		});
		const poolCountsBefore = await env.INVENTORY_POOLS.getByName(first.operation.poolId).recordCounts();
		const overview = await account.readOverview();
		const poolCountsAfter = await env.INVENTORY_POOLS.getByName(first.operation.poolId).recordCounts();

		expect(overview).toEqual({
			schema: "dinkuskit.inventory.account-overview/v1",
			snapshot: {
				sampledAt: expect.any(String),
				asOf: expect.any(String),
				health: { availability: "unavailable", reason: "live_pool_health_not_read" },
			},
			metadata: { availability: "available" },
			counts: { pools: 2, sites: 3 },
			pools: [
				{ poolId: first.operation.poolId, siteCount: 2, provisioning: "failed" },
				{ poolId: third.operation.poolId, siteCount: 1, provisioning: "pending" },
			].sort((a, b) => a.poolId.localeCompare(b.poolId)),
			sites: [
				{ siteId: "overview-site-one", poolId: first.operation.poolId, provisioning: "failed" },
				{ siteId: "overview-site-three", poolId: third.operation.poolId, provisioning: "pending" },
				{ siteId: "overview-site-two", poolId: first.operation.poolId, provisioning: "failed" },
			],
		});
		expect(poolCountsAfter).toEqual(poolCountsBefore);
		expect(JSON.stringify(overview)).not.toContain("Private location");
		expect(JSON.stringify(overview)).not.toContain("provisioning_failed");

		const reconstructedOverview = await runInDurableObject(account, async (instance, state) => {
			const restarted = new instance.constructor(state, env);
			return restarted.readOverview();
		});
		expect(reconstructedOverview.metadata).toEqual({ availability: "available" });
		expect(reconstructedOverview.pools).toEqual(overview.pools);
		expect(reconstructedOverview.sites).toEqual(overview.sites);

		const foreign = env.INVENTORY_ACCOUNTS.getByName("overview-foreign-account");
		const foreignResult = await foreign.connectAccount(
			{ accountId: "overview-foreign-account", siteId: "overview-foreign-site" },
			{ type: "create", requestId: "overview-foreign", locationName: "Foreign location" },
		);
		const foreignOverview = await foreign.readOverview();
		expect(foreignOverview.counts).toEqual({ pools: 1, sites: 1 });
		expect(foreignOverview.pools[0].poolId).toBe(foreignResult.operation.poolId);
		expect(foreignOverview.pools[0].poolId).not.toBe(first.operation.poolId);
	});
	it("fails unavailable for a broken site-to-operation relation", async () => {
		const account = env.INVENTORY_ACCOUNTS.getByName("overview-broken-account");
		await account.connectAccount(
			{ accountId: "overview-broken-account", siteId: "overview-broken-site" },
			{ type: "create", requestId: "overview-broken", locationName: "Broken test location" },
		);
		await runInDurableObject(account, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE account_connections SET value = ? WHERE kind='site' AND id=?",
				JSON.stringify({ operationId: "missing-operation", intent: "[\"create\",\"broken\"]" }),
				"overview-broken-site",
			);
		});
		await expect(account.readOverview()).resolves.toMatchObject({
			metadata: { availability: "unavailable", reason: "invalid_metadata" },
			counts: null,
			pools: null,
			sites: null,
		});
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
	it("serves signed organization metadata only, isolates organizations, and distinguishes zero from unavailable", async () => {
		const issuer = "https://overview.accounts.test";
		const keys = await generateKeyPair("ES256");
		const jwk = { ...await exportJWK(keys.publicKey), alg: "ES256", kid: "overview-fixture" };
		const overviewVerifier = createAccountOverviewVerifier(
			{ issuer, jwksUrl: `${issuer}/jwks` },
			createLocalJWKSet({ keys: [jwk] }),
		);
		const merchantVerifier = createAccountAuthenticator(
			{ issuer, jwksUrl: `${issuer}/jwks`, audience: "inventory" },
			createLocalJWKSet({ keys: [jwk] }),
		);
		const handle = createHostedInventoryHandler(env, merchantVerifier, overviewVerifier);
		const accountId = subject => JSON.stringify([issuer, subject]);
		const token = async (subject, scope = "inventory:account-overview:read", audience = "inventory-account-overview") => new SignJWT({
			scope, organization_id: `org-${subject}`, organization_subject: subject,
		}).setProtectedHeader({ alg: "ES256", kid: "overview-fixture" }).setIssuer(issuer).setAudience(audience).setSubject(`operator-${subject}`).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
		const request = async (subject, path = "/v1/account-overview", extra = {}) => handle(new Request(`https://inventory.invalid${path}`, {
			headers: { Authorization: `Bearer ${await token(subject)}`, ...extra },
		}));
		const alpha = env.INVENTORY_ACCOUNTS.getByName(accountId("alpha"));
		const first = await alpha.connectAccount({ accountId: accountId("alpha"), siteId: "alpha-site-one" }, { type: "create", requestId: "alpha-one", locationName: "private" });
		await alpha.connectAccount({ accountId: accountId("alpha"), siteId: "alpha-site-two" }, { type: "reconnect", requestId: "alpha-two", operationId: first.operation.operationId });
		await evictDurableObject(alpha);
		const beta = env.INVENTORY_ACCOUNTS.getByName(accountId("beta"));
		await beta.connectAccount({ accountId: accountId("beta"), siteId: "beta-site-one" }, { type: "create", requestId: "beta-one", locationName: "private" });
		await beta.connectAccount({ accountId: accountId("beta"), siteId: "beta-site-two" }, { type: "create", requestId: "beta-two", locationName: "private" });
		const alphaResponse = await request("alpha");
		expect(alphaResponse.status).toBe(200);
		expect(await alphaResponse.json()).toMatchObject({ organizationId: "org-alpha", overview: { counts: { pools: 1, sites: 2 } } });
		const betaResponse = await request("beta");
		expect(await betaResponse.json()).toMatchObject({ overview: { counts: { pools: 2, sites: 2 } } });
		expect((await request("alpha", "/v1/account-overview?organization_id=org-beta")).status).toBe(400);
		expect((await request("alpha", "/v1/status")).status).toBe(401);
		expect((await handle(new Request("https://inventory.invalid/v1/account-overview", { headers: { Authorization: `Bearer ${await token("alpha", "inventory:admin")}` } }))).status).toBe(401);
		const zeroResponse = await request("empty");
		expect(zeroResponse.status).toBe(200);
		expect((await zeroResponse.json()).overview.counts).toEqual({ pools: 0, sites: 0 });
		const broken = env.INVENTORY_ACCOUNTS.getByName(accountId("broken"));
		await broken.connectAccount({ accountId: accountId("broken"), siteId: "broken-site" }, { type: "create", requestId: "broken-one", locationName: "private" });
		await runInDurableObject(broken, async (_instance, state) => {
			state.storage.sql.exec("UPDATE account_connections SET value = ? WHERE kind='site' AND id=?", JSON.stringify({ operationId: "missing", intent: "private" }), "broken-site");
		});
		const unavailable = await request("broken");
		expect(unavailable.status).toBe(503);
		expect((await unavailable.json()).overview.counts).toBeNull();
		const failingRpc = createHostedInventoryHandler(
			{ ...env, INVENTORY_ACCOUNTS: { getByName: () => { throw new Error("rpc unavailable"); } } },
			undefined,
			async () => ({ accountId: accountId("rpc"), organizationId: "org-rpc", callerId: "caller-rpc" }),
		);
		const rpcUnavailable = await failingRpc(new Request("https://inventory.invalid/v1/account-overview"));
		expect(rpcUnavailable.status).toBe(503);
		expect((await rpcUnavailable.json()).overview).toMatchObject({
			metadata: { availability: "unavailable", reason: "read_unavailable" },
			counts: null,
			pools: null,
			sites: null,
		});
	});
});
