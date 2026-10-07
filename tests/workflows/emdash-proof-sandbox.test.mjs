import assert from "node:assert/strict";
import test from "node:test";
import { installInventoryProofTransport, inventoryProofFetch } from "../../tools/emdash-proof-sandbox.mjs";

test("finite test bridge rejects foreign authority, unsupported routes and query widening", async () => {
	let calls = 0;
	const uninstall = installInventoryProofTransport(async () => { calls++; return new Response("ok"); });
	try {
		for (const url of ["http://dinkuskit.com/v1/status", "https://foreign.invalid/v1/status", "https://dinkuskit.com:8443/v1/status", "https://dinkuskit.com/v1/status?x=1", "https://dinkuskit.com/v1/status#x", "https://dinkuskit.com/v1/other", "https://dinkuskit.com/v1/skus?pool_id=foreign", "https://dinkuskit.com/v1/stock?sku_id=s&location_id=l&sku_id=extra"]) {
			await assert.rejects(inventoryProofFetch(url), /Proof .* rejected/);
		}
		await assert.rejects(inventoryProofFetch("https://dinkuskit.com/v1/status", { method: "POST" }), /route rejected/);
		assert.equal(calls, 0);
	} finally { uninstall(); }
	await assert.rejects(inventoryProofFetch("https://dinkuskit.com/v1/status"), /unavailable/);
});

test("valid synthetic bridge preserves request method, bytes and headers", async () => {
	let captured;
	const uninstall = installInventoryProofTransport(async request => {
		captured = { url: request.url, method: request.method, body: await request.text(), marker: request.headers.get("x-proof-marker") };
		return new Response("unchanged", { status: 409 });
	});
	try {
		const body = '{ "synthetic": true }';
		const response = await inventoryProofFetch("https://dinkuskit.com/v1/stock/adjust/confirm", { method: "POST", headers: { "x-proof-marker": "test" }, body });
		assert.deepEqual(captured, { url: "https://dinkuskit.com/v1/stock/adjust/confirm", method: "POST", body, marker: "test" });
		assert.equal(response.status, 409);
		assert.equal(await response.text(), "unchanged");
		assert.equal((await inventoryProofFetch("https://dinkuskit.com/v1/stock?sku_id=s&location_id=l")).status, 409);
		assert.equal((await inventoryProofFetch("https://dinkuskit.com/v1/skus")).status, 409);
	} finally { uninstall(); }
});
