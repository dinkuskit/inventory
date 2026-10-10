import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";
import { createAccountAuthenticator } from "../../src/cloudflare/account-auth.ts";

// Independent consumer contract tests. The issuer here is a labeled simulation;
// installed-plugin and real website-route proof is recorded separately.
function store() {
	const records = new Map();
	let revision = 0;
	return {
		async get(k) { return records.get(k)?.value ?? null; },
		async getVersioned(k) { return records.get(k) ?? null; },
		async compareAndSet(k, expected, value) {
			if ((records.get(k)?.revision ?? null) !== expected) return { applied: false };
			const next = String(++revision); records.set(k, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(k, expected) {
			if (records.get(k)?.revision !== expected) return { applied: false };
			records.delete(k); return { applied: true };
		},
	};
}

const origin = "https://independent.example.test";
const canonicalId = "canonical_server_store_123";
const admin = { id: "local_admin" };
const action = (name, user = admin) => ({ input: { type: "block_action", action_id: name }, user });
const load = { input: { type: "page_load", page: "/inventory" }, user: admin };

function fixture({ first = "inventory", overrideStart = {}, exchangeError = null } = {}) {
	const kv = store(), settings = store(), requests = [];
	const grants = new Set(first === "payments" ? ["payments"] : []);
	let currentTime = Date.now();
	const ctx = {
		site: { url: origin }, url: path => origin + path, kv, settings,
		http: { async fetch(url, init = {}) {
			const path = new URL(url).pathname;
			const body = init.body ? JSON.parse(init.body) : null;
			requests.push({ path, body, headers: new Headers(init.headers) });
			if (path === "/api/store-connections") {
				assert.equal(body.protocol_version, 2);
				assert.equal(Object.hasOwn(body, "site_id"), false);
				assert.equal(body.service, "inventory");
				assert.equal(body.client_id, "dinkus-inventory-emdash");
				return Response.json({ protocol_version: 2, site_id: canonicalId,
					connection_id: "connection_independent", challenge: "challenge_independent",
					verification_uri: "https://accounts.dinkuskit.invalid/account/connect?connection_id=connection_independent",
					expires_in: 600, expires_at: currentTime + 600000, interval: 5, ...overrideStart });
			}
			if (path === "/api/store-connections/token") {
				if (exchangeError) return Response.json({ error: exchangeError }, { status: 400 });
				if (!grants.has("inventory")) return Response.json({ error: "authorization_pending", interval: 17 }, { status: 400 });
				return Response.json({ access_token: "synthetic_inventory_token", token_type: "Bearer", expires_in: 300, site_id: canonicalId });
			}
			assert.equal(new Headers(init.headers).get("X-Inventory-Site"), canonicalId);
			return Response.json({ status: "unconnected", operations: [] });
		} },
	};
	return { ctx, kv, settings, requests, grants,
		async readyToPoll() {
			const stored = await settings.getVersioned("connectionSession");
			const session = JSON.parse(stored.value); session.nextPoll = 1;
			await settings.compareAndSet("connectionSession", stored.revision, JSON.stringify(session));
		},
	};
}

for (const first of ["inventory", "payments"]) {
	test(`independent ${first}-first simulation: public proof and all Inventory calls use server identity`, async () => {
		const f = fixture({ first });
		await f.kv.compareAndSet("state:site-id", null, "obsolete_local_id");
		await plugin.routes.admin.handler(action("connect"), f.ctx);
		const proof = await plugin.routes["store-proof"].handler({ input: { connection_id: "connection_independent" } }, f.ctx);
		assert.equal(proof.status, 200);
		const receipt = JSON.parse(proof.body.value);
		assert.deepEqual(Object.keys(receipt).sort(), ["version", "connection_id", "challenge", "client_id", "service", "site_id", "site_origin", "callback_uri", "code_challenge", "expires_at"].sort());
		assert.equal(receipt.version, 2); assert.equal(receipt.site_id, canonicalId);
		assert.equal(receipt.service, "inventory"); assert.equal(receipt.site_origin, origin);
		assert.equal(receipt.callback_uri, origin + "/_emdash/admin/plugins/dinkus-inventory/inventory");
		await f.readyToPoll();
		await plugin.routes.admin.handler(load, f.ctx);
		assert.equal(JSON.parse(await f.settings.get("connectionSession")).phase, "challenge", "Payments grant cannot authorize Inventory");
		assert.equal(f.requests.filter(r => r.path.startsWith("/v1/")).length, 0);
		f.grants.add("inventory");
		await f.readyToPoll();
		await plugin.routes.admin.handler(load, f.ctx);
		assert.equal(JSON.parse(await f.settings.get("connectionSession")).siteId, canonicalId);
		assert.ok(f.requests.some(r => r.path === "/v1/status"));
		assert.equal(await f.kv.get("state:site-id"), "obsolete_local_id", "old identity is not rewritten");
	});
}

test("independent start rejection: v1 or missing canonical identity never publishes proof", async () => {
	for (const overrideStart of [{ protocol_version: 1 }, { site_id: "" }]) {
		const f = fixture({ overrideStart });
		await plugin.routes.admin.handler(action("connect"), f.ctx);
		assert.equal(await f.settings.get("connectionSession"), null);
		const proof = await plugin.routes["store-proof"].handler({ input: { connection_id: "connection_independent" } }, f.ctx);
		assert.equal(proof.status, 404);
	}
});

test("independent pending interval: issuer interval is honored; unknown errors stop polling", async () => {
	const pending = fixture();
	await plugin.routes.admin.handler(action("connect"), pending.ctx);
	await pending.readyToPoll(); const before = Date.now();
	await plugin.routes.admin.handler(load, pending.ctx);
	assert.ok(JSON.parse(await pending.settings.get("connectionSession")).nextPoll >= before + 17000);
	for (const exchangeError of ["integration_unavailable", "unknown_failure", "slow_down", "grant_revoked"]) {
		const f = fixture({ exchangeError });
		await plugin.routes.admin.handler(action("connect"), f.ctx);
		await f.readyToPoll(); await plugin.routes.admin.handler(load, f.ctx);
		const calls = f.requests.length;
		await plugin.routes.admin.handler(load, f.ctx);
		assert.equal(f.requests.length, calls, `${exchangeError} must not automatically retry`);
		assert.equal(f.requests.filter(r => r.path.startsWith("/v1/")).length, 0);
	}
});

test("independent signed authority: Payments and other-store credentials cannot authenticate Inventory", async () => {
	const { publicKey, privateKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const issuer = "https://dinkuskit.com/account";
	const auth = createAccountAuthenticator({ issuer, audience: "inventory", jwksUrl: issuer + "/.well-known/jwks.json" }, createLocalJWKSet({ keys: [{ ...jwk, alg: "ES256" }] }));
	async function request(audience, scope, claimId, headerId = canonicalId) {
		const token = await new SignJWT({ site_id: claimId, scope }).setProtectedHeader({ alg: "ES256" })
			.setIssuer(issuer).setAudience(audience).setSubject("org_authority").setIssuedAt().setExpirationTime("5m").sign(privateKey);
		return new Request("https://inventory.dinkuskit.invalid/v1/status", { headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": headerId } });
	}
	assert.equal((await auth(await request("inventory", "inventory:admin", canonicalId))).siteId, canonicalId);
	await assert.rejects(auth(await request("dinkus-payments", "payments:admin", canonicalId)));
	await assert.rejects(auth(await request("inventory", "payments:admin", canonicalId)));
	await assert.rejects(auth(await request("inventory", "inventory:admin", "other_store")));
	await assert.rejects(auth(await request("inventory", "inventory:admin", canonicalId, "other_store")));
});

test("independent legacy guard: page load neither reuses nor clears an old credential or provisioning intent", async () => {
	const f = fixture();
	const legacy = JSON.stringify({ phase: "token", token: "obsolete_dev_token", expiresAt: Date.now() + 300000 });
	const intent = { type: "create", requestId: "old-operation-request", locationName: "Legacy location" };
	await f.settings.compareAndSet("connectionSession", null, legacy);
	await f.kv.compareAndSet("state:site-id", null, "old-site");
	await f.kv.compareAndSet("state:connection-intent", null, intent);
	await plugin.routes.admin.handler(load, f.ctx);
	assert.equal(f.requests.length, 0, "old credentials never reach a network request");
	assert.equal(await f.settings.get("connectionSession"), legacy, "GET does not reset old state");
	assert.equal(await f.kv.get("state:site-id"), "old-site");
	assert.deepEqual(await f.kv.get("state:connection-intent"), intent);
});

test("independent unknown exchange outcome: malformed JSON and network loss require a fresh explicit connection", async () => {
	for (const failure of ["malformed", "network_loss"]) {
		const f = fixture();
		const original = f.ctx.http.fetch;
		let exchanges = 0;
		f.ctx.http.fetch = async (url, init) => {
			if (new URL(url).pathname === "/api/store-connections/token") {
				exchanges++;
				if (failure === "network_loss") throw new TypeError("test transport loss");
				return new Response("invalid-json", { status: 200 });
			}
			return original(url, init);
		};
		await plugin.routes.admin.handler(action("connect"), f.ctx);
		await f.readyToPoll();
		await plugin.routes.admin.handler(load, f.ctx);
		await plugin.routes.admin.handler(load, f.ctx);
		assert.equal(exchanges, 1);
		assert.equal(await f.settings.get("connectionSession"), null);
		const proof = await plugin.routes["store-proof"].handler({ input: { connection_id: "connection_independent" } }, f.ctx);
		assert.equal(proof.status, 404);
	}
});
