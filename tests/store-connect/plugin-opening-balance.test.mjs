import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

function mockKv() {
	const items = new Map();
	let rev = 0;
	return {
		async get(k) { return items.get(k)?.value ?? null; },
		async getVersioned(k) { return items.get(k) ?? null; },
		async compareAndSet(k, r, value) {
			if ((items.get(k)?.revision ?? null) !== r) return { applied: false };
			const revision = `r${++rev}`; items.set(k, { value, revision }); return { applied: true, revision };
		},
		async compareAndDelete(k, r) {
			if (!items.get(k) || items.get(k).revision !== r) return { applied: false };
			items.delete(k); return { applied: true };
		},
	};
}

const preview = {
	schema: "dinkuskit.inventory.opening-balance-preview/v1",
	type: "stock.opening_balance",
	context: { siteId: "site_1", poolId: "pool_1", locationId: "loc_1" },
	effect: {
		skuId: "sku_1", locationId: "loc_1",
		onHandDelta: { value: "7", unit: "each" }, reservedDelta: { value: "0", unit: "each" },
		balanceBefore: { onHand: { value: "0", unit: "each" }, reserved: { value: "0", unit: "each" }, outgoingTransferCommitted: { value: "0", unit: "each" }, available: { value: "0", unit: "each" }, expected: { value: "0", unit: "each" }, inTransit: { value: "0", unit: "each" }, version: "0" },
		balanceAfter: { onHand: { value: "7", unit: "each" }, reserved: { value: "0", unit: "each" }, outgoingTransferCommitted: { value: "0", unit: "each" }, available: { value: "7", unit: "each" }, expected: { value: "0", unit: "each" }, inTransit: { value: "0", unit: "each" }, version: "1" },
	},
	reason: { code: "physical_count", note: "Set Initial Stock" }, references: [],
	warning: "This opening balance permanently starts stock history for this SKU-location.",
	confirmation: { value: "confirm_1", expiresAt: new Date(Date.now() + 60_000).toISOString() },
};

function ctx(fetchHandler, kv = mockKv()) {
	return {
		site: { url: "https://shop.example.com" }, url: p => `https://shop.example.com${p}`,
		http: { fetch: async (url, init) => fetchHandler(new Request(url, init)) },
		kv, settings: {
			async get() { return JSON.stringify({ phase: "token", token: "token", expiresAt: Date.now() + 600_000 }); },
			async getVersioned() { return { value: JSON.stringify({ phase: "token", token: "token", expiresAt: Date.now() + 600_000 }), revision: "s1" }; },
			async compareAndSet() { return { applied: true, revision: "s2" }; },
			async compareAndDelete() { return { applied: true }; },
		},
	};
}

test("opening stock requires authoritative no-history read and retries original command after lost acknowledgement", async () => {
	const kv = mockKv();
	let confirms = 0;
	const fetchHandler = async req => {
		const path = new URL(req.url).pathname;
		if (path === "/v1/status") return Response.json({ status: "ready", operation: { poolId: "pool_1", operationId: "op", locationName: "Warehouse", locationId: "loc_1", status: "ready", failureCode: null } });
		if (path === "/v1/locations") return Response.json({ locations: [{ locationId: "loc_1", name: "Warehouse" }] });
		if (path === "/v1/stock/opening/eligibility") return Response.json({ schema: "dinkuskit.inventory.opening-balance-eligibility-read-result/v1", key: { poolId: "pool_1", skuId: "sku_1", locationId: "loc_1" }, eligibility: "eligible", sku: { inventorySkuId: "sku_1", sku: "SKU-1", unit: "each" }, location: { locationId: "loc_1", status: "active" }, balance: null, hasStockHistory: false });
		if (path === "/v1/stock/opening/preview") return Response.json(preview);
		if (path === "/v1/stock/opening/confirm") {
			confirms++;
			if (confirms === 1) throw new Error("lost acknowledgement");
			return Response.json({ outcome: "committed", commandId: (await req.clone().json()).command.commandId, receipt: { receiptId: "receipt_1", committedAt: "2026-10-06T20:00:00Z" } });
		}
		throw new Error(path);
	};
	const request = { type: "form_submit", action_id: "preview_opening_balance", values: { location_id: "loc_1", sku_id: "sku_1", quantity_value: "7" } };
	const c = ctx(fetchHandler, kv);
	await plugin.routes.admin.handler({ input: request, user: { id: "admin_a" } }, c);
	const frozen = await kv.get("state:opening-balance-intent");
	assert.equal(frozen.status, "preview");
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "confirm_opening_balance", value: frozen.command.commandId }, user: { id: "admin_a" } }, c);
	const pending = await kv.get("state:opening-balance-intent");
	assert.equal(pending.status, "pending");
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "retry_opening_balance", value: frozen.command.commandId }, user: { id: "admin_a" } }, c);
	assert.equal(confirms, 2);
	assert.equal((await kv.get("state:opening-balance-intent")).status, "committed");
});

test("foreign admin cannot confirm or replace opening intent", async () => {
	const kv = mockKv();
	const c = ctx(async req => {
		const path = new URL(req.url).pathname;
		if (path === "/v1/status") return Response.json({ status: "ready", operation: { poolId: "pool_1", operationId: "op", locationName: "Warehouse", locationId: "loc_1", status: "ready", failureCode: null } });
		if (path === "/v1/locations") return Response.json({ locations: [{ locationId: "loc_1", name: "Warehouse" }] });
		if (path === "/v1/stock") return Response.json({ ok: true, balance: { outcome: "not_found" } });
		throw new Error(path);
	}, kv);
	await kv.compareAndSet("state:opening-balance-intent", null, { status: "pending", initiatingAdminId: "admin_a", preview, command: { schema: "dinkuskit.inventory.command/v1", commandId: "cmd_1", type: "stock.opening_balance", context: preview.context, payload: { skuId: "sku_1", quantity: preview.effect.onHandDelta }, reason: preview.reason, references: [], expectedVersions: [{ skuId: "sku_1", locationId: "loc_1", version: "0" }] }, expiresAt: Date.now() + 60_000 });
	const before = structuredClone(await kv.getVersioned("state:opening-balance-intent"));
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "retry_opening_balance", value: "cmd_1" }, user: { id: "admin_b" } }, c);
	assert.deepEqual(await kv.getVersioned("state:opening-balance-intent"), before);
});

function openingIntent(status = 'preview', admin = 'admin_a') {
 return { status, initiatingAdminId: admin, preview, command: { schema: 'dinkuskit.inventory.command/v1', commandId: 'cmd_1', type: 'stock.opening_balance', context: preview.context, payload: { skuId: 'sku_1', quantity: preview.effect.onHandDelta }, reason: preview.reason, references: [], expectedVersions: [{ skuId: 'sku_1', locationId: 'loc_1', version: '0' }] }, expiresAt: Date.now() + 60_000 };
}
const openingRequest = { type: 'form_submit', action_id: 'preview_opening_balance', values: { location_id: 'loc_1', sku_id: 'sku_1', quantity_value: '7' } };
function readyResponse(req) {
 const path = new URL(req.url).pathname;
 if (path === '/v1/status') return Response.json({ status: 'ready', operation: { poolId: 'pool_1', operationId: 'op', locationName: 'Warehouse', locationId: 'loc_1', status: 'ready', failureCode: null } });
 if (path === '/v1/locations') return Response.json({ locations: [{ locationId: 'loc_1', name: 'Warehouse' }] });
 if (path === '/v1/stock/opening/eligibility') return Response.json({ schema: 'dinkuskit.inventory.opening-balance-eligibility-read-result/v1', key: { poolId: 'pool_1', skuId: 'sku_1', locationId: 'loc_1' }, eligibility: 'eligible', sku: { inventorySkuId: 'sku_1', sku: 'SKU-1', unit: 'each' }, location: { locationId: 'loc_1', status: 'active' }, balance: null, hasStockHistory: false });
 if (path === '/v1/stock') return Response.json({ ok: true, balance: { schema: 'dinkuskit.inventory.balance-read-result/v1', outcome: 'not_found', key: { poolId: 'pool_1', skuId: 'sku_1', locationId: 'loc_1' } } });
 return undefined;
}
test('delayed preview cannot overwrite a concurrent pending or foreign-admin request', async () => {
 for (const admin of ['admin_a', 'admin_b']) {
  const kv = mockKv();
  await kv.compareAndSet('state:opening-balance-intent', null, openingIntent());
  let release, started;
  const gate = new Promise(r => release = r), observed = new Promise(r => started = r);
  const c = ctx(async req => {
   if (new URL(req.url).pathname === '/v1/stock/opening/preview') { started(); await gate; return Response.json(preview); }
   return readyResponse(req);
  }, kv);
  const delayed = plugin.routes.admin.handler({ input: openingRequest, user: { id: 'admin_a' } }, c);
  await observed;
  const old = await kv.getVersioned('state:opening-balance-intent');
  await kv.compareAndSet('state:opening-balance-intent', old.revision, openingIntent('pending', admin));
  const pending = structuredClone(await kv.getVersioned('state:opening-balance-intent'));
  release(); await delayed;
  assert.deepEqual(await kv.getVersioned('state:opening-balance-intent'), pending);
 }
});
test('only authoritative confirmation failures terminate; uncertain/mismatched status outcomes preserve pending', async () => {
 for (const [status, body, terminal] of [
  [409, { error: 'confirmation_expired' }, true],
  [401, { error: 'unauthorized' }, false],
  [403, { error: 'unauthorized_context' }, false],
  [503, { error: 'confirmation_expired' }, false],
  [200, { unexpected: true }, false],
  [200, { outcome: 'committed', commandId: 'other', receipt: { receiptId: 'r', committedAt: '2026-10-06' } }, false],
  [503, { outcome: 'committed', commandId: 'cmd_1', receipt: { receiptId: 'r', committedAt: '2026-10-06' } }, false],
 ]) {
  const kv = mockKv(); await kv.compareAndSet('state:opening-balance-intent', null, openingIntent('pending'));
  const frozen = structuredClone(await kv.getVersioned('state:opening-balance-intent'));
  const c = ctx(async req => new URL(req.url).pathname === '/v1/stock/opening/confirm' ? Response.json(body, { status }) : readyResponse(req), kv);
  await plugin.routes.admin.handler({ input: { type: 'block_action', action_id: 'retry_opening_balance', value: 'cmd_1' }, user: { id: 'admin_a' } }, c);
  if (terminal) assert.equal((await kv.get('state:opening-balance-intent')).status, 'rejected');
  else assert.deepEqual(await kv.getVersioned('state:opening-balance-intent'), frozen);
 }
});
test('unknown, unavailable, and historical stock never permit a new opening preview', async () => {
 for (const response of [() => Response.json({ error: 'sku_not_registered' }, { status: 404 }), () => Response.json({ error: 'service_unavailable' }, { status: 503 }), () => Response.json({ schema: 'dinkuskit.inventory.opening-balance-eligibility-read-result/v1', key: { poolId: 'pool_1', skuId: 'sku_1', locationId: 'loc_1' }, eligibility: 'eligible', location: { locationId: 'loc_1', status: 'active' }, balance: null, hasStockHistory: true })]) {
  const kv = mockKv(); let previews = 0;
  const c = ctx(async req => {
   if (new URL(req.url).pathname === '/v1/stock/opening/eligibility') return response();
   if (new URL(req.url).pathname === '/v1/stock/opening/preview') { previews++; return Response.json(preview); }
   return readyResponse(req);
  }, kv);
  await plugin.routes.admin.handler({ input: openingRequest, user: { id: 'admin_a' } }, c);
  assert.equal(previews, 0); assert.equal(await kv.get('state:opening-balance-intent'), null);
 }
});
