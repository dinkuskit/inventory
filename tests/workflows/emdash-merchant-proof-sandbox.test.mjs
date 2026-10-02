import assert from "node:assert/strict";
import test from "node:test";
import { installMerchantProofTransport, merchantProofFetch } from "../../tools/emdash-merchant-proof-sandbox.mjs";

const start = {
	site_id: "test-site-id", site_origin: "http://127.0.0.1:47631",
	callback_uri: "http://127.0.0.1:47631/_emdash/admin/plugins/dinkus-inventory/inventory",
	client_id: "dinkus-inventory-emdash", service: "inventory",
	code_challenge: "test-only-challenge", code_challenge_method: "S256",
};
const url = "https://dinkuskit.com/api/store-connections";
const request = body => new Request(url, { method: "POST", body: JSON.stringify(body) });

test("merchant fixture rejects widening and malformed public identities before dispatch", async () => {
	let calls = 0;
	const uninstall = installMerchantProofTransport(async () => { calls++; return new Response("ok"); });
	try {
		for (const target of ["http://dinkuskit.com/api/store-connections", "https://foreign.invalid/api/store-connections", "https://dinkuskit.com:8443/api/store-connections", `${url}?extra=1`, `${url}#extra`, "https://dinkuskit.com/api/other"]) {
			await assert.rejects(merchantProofFetch(target, { method: "POST", body: "{}" }), /route rejected/);
		}
		await assert.rejects(merchantProofFetch(url), /route rejected/);
		for (const body of [null, { ...start, site_id: undefined }, { ...start, site_id: 123 }, { ...start, site_id: "https://shop.example.com" }, { ...start, site_origin: "http://127.0.0.1:47633" }, { ...start, callback_uri: "http://127.0.0.1:47631/other" }]) {
			await assert.rejects(merchantProofFetch(request(body)), /prerequisites differ/);
		}
		assert.equal(calls, 0);
	} finally { uninstall(); }
	await assert.rejects(merchantProofFetch(`${url}/token`, { method: "POST", body: "{}" }), /transport unavailable/);
});

test("merchant fixture preserves protocol bytes and response, observing only five public fields", async () => {
	const originalLog = console.log;
	const logs = [];
	console.log = value => logs.push(value);
	let captured;
	const response = new Response("unchanged", { status: 202 });
	const uninstall = installMerchantProofTransport(async req => {
		captured = { url: req.url, method: req.method, marker: req.headers.get("x-proof-marker"), body: await req.text() };
		return response;
	});
	try {
		const bytes = JSON.stringify(start, null, 1);
		assert.equal(await merchantProofFetch(url, { method: "POST", headers: { "x-proof-marker": "test" }, body: bytes }), response);
		assert.deepEqual(captured, { url, method: "POST", marker: "test", body: bytes });
		assert.equal(logs.length, 1);
		assert.deepEqual(JSON.parse(logs[0].slice("PEER_START_PREREQUISITES ".length)), { siteId: start.site_id, siteOrigin: start.site_origin, callbackUri: start.callback_uri, clientId: start.client_id, service: start.service });
		logs.length = 0;
		await merchantProofFetch(`${url}/token`, { method: "POST", body: '{ "test_verifier": "do-not-observe" }' });
		assert.equal(logs.length, 0);
	} finally { uninstall(); console.log = originalLog; }
});
