// Distinct compiled merchant integration fixture, never production transport.
import { createSandboxRunner as standardRunner } from "@emdash-cms/sandbox-workerd/sandbox";
import { inventoryProofFetch } from "./emdash-proof-sandbox.mjs";

const registry = Symbol.for("dinkuskit.inventory.proof.websiteFetch");
export function installMerchantProofTransport(dispatch) {
	if (typeof dispatch !== "function") throw new Error("Merchant proof dispatch must be callable");
	globalThis[registry] = dispatch;
	return () => { if (globalThis[registry] === dispatch) delete globalThis[registry]; };
}

export async function merchantProofFetch(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.pathname.startsWith("/v1/")) return inventoryProofFetch(request);
	if (url.origin !== "https://dinkuskit.com" || url.username || url.password || url.search || url.hash || request.method !== "POST" || !["/api/store-connections", "/api/store-connections/token"].includes(url.pathname)) {
		throw new Error("Merchant proof route rejected");
	}
	if (url.pathname === "/api/store-connections") {
		const start = await request.clone().json();
		if (!start || typeof start.site_id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(start.site_id) || start.site_origin !== "http://127.0.0.1:47631" || start.callback_uri !== "http://127.0.0.1:47631/_emdash/admin/plugins/dinkus-inventory/inventory" || start.client_id !== "dinkus-inventory-emdash" || start.service !== "inventory") {
			throw new Error("Merchant proof prerequisites differ");
		}
		// These five fields are public receipt identifiers. Never log token,
		// verifier, challenge, cookies, headers or an entire request/response.
		console.log(`PEER_START_PREREQUISITES ${JSON.stringify({ siteId: start.site_id, siteOrigin: start.site_origin, callbackUri: start.callback_uri, clientId: start.client_id, service: start.service })}`);
	}
	const dispatch = globalThis[registry];
	if (typeof dispatch !== "function") throw new Error("Merchant proof transport unavailable");
	return dispatch(request);
}

export function createSandboxRunner(options) {
	return standardRunner({ ...options, httpFetch: merchantProofFetch });
}
