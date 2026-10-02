import assert from "node:assert/strict";
import test from "node:test";
import { createMerchantLoopbackTransport } from "../../tools/emdash-merchant-loopback-transport.mjs";

const start = "https://dinkuskit.com/api/store-connections";
const post = (url, body = "{}") => new Request(url, { method: "POST", headers: { "content-type": "application/json", "x-proof-marker": "test" }, body });

test("local merchant adapter preserves bytes and redirect response on the two fixed endpoints", async () => {
	let target, options;
	const unchanged = new Response(null, { status: 303, headers: { location: "http://127.0.0.1:47631/_emdash/admin/plugins/dinkus-inventory/inventory" } });
	const dispatch = createMerchantLoopbackTransport({ fetch: async (url, init) => { target = url; options = init; return unchanged; } });
	const bytes = '{ "synthetic": "test-only" }';
	assert.equal(await dispatch(post(start, bytes)), unchanged);
	assert.equal(target, "http://127.0.0.1:47632/api/store-connections");
	assert.equal(options.method, "POST");
	assert.equal(new TextDecoder().decode(options.body), bytes);
	assert.equal(options.headers.get("x-proof-marker"), "test");
	assert.equal(options.redirect, "manual");
	assert.equal(options.signal.aborted, false);
	await dispatch(post(`${start}/token`));
	assert.equal(target, "http://127.0.0.1:47632/api/store-connections/token");
});

test("local merchant adapter rejects authority, method, path, query and size widening before dispatch", async () => {
	let calls = 0;
	const dispatch = createMerchantLoopbackTransport({ fetch: async () => { calls++; return new Response("ok"); } });
	for (const url of ["http://dinkuskit.com/api/store-connections", "https://dinkuskit.com:8443/api/store-connections", "https://other.invalid/api/store-connections", "http://127.0.0.1:47632/api/store-connections", `${start}?extra=1`, `${start}#extra`, "https://dinkuskit.com/account"] ) {
		await assert.rejects(dispatch(post(url)), /route rejected/);
	}
	await assert.rejects(dispatch(new Request(start)), /route rejected/);
	await assert.rejects(dispatch(post(start, "x".repeat(8193))), /body rejected/);
	assert.equal(calls, 0);
});
