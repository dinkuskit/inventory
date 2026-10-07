import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

function mockKv() {
	const items = new Map();
	let revision = 0;
	return {
		async get(key) { return items.get(key)?.value ?? null; },
		async getVersioned(key) { return items.get(key) ?? null; },
		async compareAndSet(key, expected, value) {
			if ((items.get(key)?.revision ?? null) !== expected) return { applied: false };
			const next = { value, revision: `r${++revision}` };
			items.set(key, next);
			return { applied: true, revision: next.revision };
		},
		async compareAndDelete(key, expected) {
			if (items.get(key)?.revision !== expected) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
	};
}

function context(fetchHandler, kv = mockKv()) {
	return {
		kv,
		site: { url: "https://shop.example.com" },
		url: path => `https://shop.example.com${path}`,
		http: { fetch: async (url, init) => fetchHandler(new Request(url, init)) },
		settings: {
			async getVersioned() { return { value: JSON.stringify({ phase: "token", token: "token", expiresAt: Date.now() + 600000 }), revision: "s1" }; },
			async get() { return JSON.stringify({ phase: "token", token: "token", expiresAt: Date.now() + 600000 }); },
		},
	};
}

const ready = path => {
	if (path === "/v1/status") return Response.json({ status: "ready", operation: { poolId: "pool_1", operationId: "op", locationName: "Warehouse", locationId: "loc_1", status: "ready", failureCode: null } });
	if (path === "/v1/locations") return Response.json({ locations: [{ locationId: "loc_1", name: "Warehouse" }] });
	if (path === "/v1/skus") return Response.json({ skus: [] });
	throw new Error(path);
};

test("registration persists the original command through unknown outcome and exact retry", async () => {
	const kv = mockKv();
	let attempts = 0;
	const ctx = context(async request => {
		const path = new URL(request.url).pathname;
		if (path === "/v1/skus/register") {
			attempts++;
			if (attempts === 1) throw new Error("lost acknowledgement");
			const body = await request.json();
			return Response.json({ schema: "dinkuskit.inventory.command-result/v1", outcome: "registered", commandId: body.commandId, inventorySku: { inventorySkuId: "inventory_sku_1", sku: "HAT-BLACK", displayName: "Black Hat" } });
		}
		return ready(path);
	}, kv);
	await plugin.routes.admin.handler({ input: { type: "form_submit", action_id: "register_sku", values: { sku: "HAT-BLACK", display_name: "Black Hat" } }, user: { id: "admin_a" } }, ctx);
	const pending = await kv.get("state:sku-registration-intent");
	assert.equal(pending.status, "pending");
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "retry_registration", value: pending.commandId }, user: { id: "admin_a" } }, ctx);
	assert.equal((await kv.get("state:sku-registration-intent")).status, "committed");
	assert.equal(attempts, 2);
});

test("foreign administrator cannot retry or clear a pending registration", async () => {
	const kv = mockKv();
	const ctx = context(async request => {
		const path = new URL(request.url).pathname;
		if (path === "/v1/skus/register") throw new Error("must not send");
		return ready(path);
	}, kv);
	await kv.compareAndSet("state:sku-registration-intent", null, { status: "pending", initiatingAdminId: "admin_a", commandId: "cmd_register", sku: "HAT-BLACK", displayNameIfNew: "Black Hat" });
	const before = await kv.getVersioned("state:sku-registration-intent");
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "retry_registration", value: "cmd_register" }, user: { id: "admin_b" } }, ctx);
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "clear_registration_result", value: "cmd_register" }, user: { id: "admin_b" } }, ctx);
	assert.deepEqual(await kv.getVersioned("state:sku-registration-intent"), before);
});

test("unqualified replies cannot terminalize registration or overwrite the original intent", async () => {
 for (const [status, commandId] of [[503, "original"], [200, "foreign"]]) {
  const kv = mockKv();
  const original = { status: "pending", initiatingAdminId: "admin_a", commandId: "original", sku: "HAT-BLACK", displayNameIfNew: "Black Hat" };
  await kv.compareAndSet("state:sku-registration-intent", null, original);
  const ctx = context(async request => new URL(request.url).pathname === "/v1/skus/register"
   ? Response.json({ outcome: "registered", commandId, inventorySku: { inventorySkuId: "inventory_sku_1", sku: "HAT-BLACK", displayName: "Black Hat" } }, { status }) : ready(new URL(request.url).pathname), kv);
  await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "retry_registration", value: "original" }, user: { id: "admin_a" } }, ctx);
  assert.deepEqual(await kv.get("state:sku-registration-intent"), original);
 }
});

test("existing registration never promises a zero stock balance", async () => {
 const kv = mockKv();
 const ctx = context(async request => {
  if (new URL(request.url).pathname === "/v1/skus/register") {
   const body = await request.json();
   return Response.json({ outcome: "existing", commandId: body.commandId, inventorySku: { inventorySkuId: "inventory_sku_1", sku: "HAT-BLACK", displayName: "Original Hat" } });
  }
  return ready(new URL(request.url).pathname);
 }, kv);
 const result = await plugin.routes.admin.handler({ input: { type: "form_submit", action_id: "register_sku", values: { sku: "HAT-BLACK", display_name: "New name" } }, user: { id: "admin_a" } }, ctx);
 assert.equal((await kv.get("state:sku-registration-intent")).status, "committed");
 assert.match(JSON.stringify(result), /Stock was unchanged/);
 assert.doesNotMatch(JSON.stringify(result), /logical zero/);
});

test("a fresh connected pool has a registration form and no empty stock selector", async () => {
 const ctx = context(async request => ready(new URL(request.url).pathname));
 const result = await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "refresh" }, user: { id: "admin_a" } }, ctx);
 assert.match(JSON.stringify(result), /register_sku/);
 assert.doesNotMatch(JSON.stringify(result), /select-stock-view/);
});
