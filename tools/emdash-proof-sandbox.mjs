// Test fixture only. EmDash validates allowed hosts, DNS and redirects before
// invoking this supported httpFetch hook. Production authority is untouched.
import { createSandboxRunner as standardRunner } from "@emdash-cms/sandbox-workerd/sandbox";

const registry = Symbol.for("dinkuskit.inventory.proof.httpFetch");
const reads = new Set(["/v1/status", "/v1/operations", "/v1/locations"]);
const writes = new Set(["/v1/connect", "/v1/stock/adjust/preview", "/v1/stock/adjust/confirm"]);

export function installInventoryProofTransport(dispatch) {
	if (typeof dispatch !== "function") throw new Error("Proof dispatch must be callable");
	globalThis[registry] = dispatch;
	return () => { if (globalThis[registry] === dispatch) delete globalThis[registry]; };
}

export async function inventoryProofFetch(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	if (url.origin !== "https://dinkuskit.com" || url.username || url.password || url.hash) {
		throw new Error("Proof target rejected");
	}
	let allowed = request.method === "GET" && reads.has(url.pathname) && !url.search;
	allowed ||= request.method === "POST" && writes.has(url.pathname) && !url.search;
	if (request.method === "GET" && url.pathname === "/v1/stock") {
		const entries = [...url.searchParams];
		allowed = entries.length === 2 && ["sku_id", "location_id"].every(key => {
			const values = url.searchParams.getAll(key);
			return values.length === 1 && values[0].length > 0 && values[0].length <= 200;
		});
	}
	if (!allowed) throw new Error("Proof route rejected");
	const dispatch = globalThis[registry];
	if (typeof dispatch !== "function") throw new Error("Proof transport unavailable");
	return dispatch(request);
}

export function createSandboxRunner(options) {
	return standardRunner({ ...options, httpFetch: inventoryProofFetch });
}
