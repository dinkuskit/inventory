import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

function versionedStore() {
	const items = new Map();
	return {
		async get(key) { return items.get(key)?.value ?? null; },
		async getVersioned(key) { return items.get(key) ?? null; },
		async compareAndSet(key, revision, value) {
			if ((items.get(key)?.revision ?? null) !== revision) return { applied: false };
			const next = String(Number(revision ?? 0) + 1);
			items.set(key, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(key, revision) {
			if (items.get(key)?.revision !== revision) return { applied: false };
			items.delete(key); return { applied: true };
		},
	};
}

test("v2 Connect omits local identity and freezes the returned canonical identity", async () => {
	const requests = [];
	const kv = versionedStore(), settings = versionedStore();
	const ctx = {
		site: { url: "https://shop.example.com" }, url: path => `https://shop.example.com${path}`,
		kv, settings,
		http: { async fetch(url, init) {
			requests.push(JSON.parse(init.body));
			return Response.json({ protocol_version: 2, site_id: "server-site-1", connection_id: "connection_test_1", challenge: "challenge_test_1", verification_uri: "https://accounts.dinkuskit.invalid/account/connect?connection_id=connection_test_1", expires_in: 300, expires_at: Date.now() + 300000, interval: 5 });
		} },
	};
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "connect" }, user: { id: "admin_test" } }, ctx);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].protocol_version, 2);
	assert.equal(Object.hasOwn(requests[0], "site_id"), false);
	assert.equal(requests[0].site_origin, "https://shop.example.com");
	assert.equal(await kv.get("state:site-id"), null);
	// A second administrator click resumes the same challenge and identity.
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "connect" }, user: { id: "admin_test" } }, ctx);
	assert.equal(requests.length, 1);
	assert.equal(await kv.get("state:site-id"), null);
});
