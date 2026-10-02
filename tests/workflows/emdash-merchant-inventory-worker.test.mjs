import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("merchant proof backend verifies canonical signed issuer, kid, scope and exact site using a public-only provider", async () => {
	const keys = await generateKeyPair("ES256", { extractable: true });
	const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "test-only-kid", alg: "ES256" };
	let healthy = true;
	const observed = [];
	const compiled = await build({ entryPoints: [resolve("tools/emdash-merchant-inventory-worker.ts")], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], write: false });
	const mf = new Miniflare(convertV4MiniflareOptions({ name: "merchant-inventory-proof", modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2026-08-06",
		durableObjects: { INVENTORY_POOLS: { className: "InventoryPool", useSQLite: true }, INVENTORY_ACCOUNTS: { className: "InventoryAccount", useSQLite: true } },
		serviceBindings: { PROOF_MERCHANT_JWKS: async request => {
			observed.push({ url: request.url, method: request.method, authorizationPresent: request.headers.has("authorization") });
			return healthy ? Response.json({ keys: [publicKey] }) : new Response(null, { status: 503 });
		} },
	}));
	async function status({ issuer = "https://dinkuskit.com/account", kid = publicKey.kid, scope = "inventory:admin", site = "test-site-id", headerSite = site } = {}) {
		const token = await new SignJWT({ scope, site_id: site }).setProtectedHeader({ alg: "ES256", kid }).setIssuer(issuer).setAudience("inventory").setSubject("test-only-merchant").setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
		return mf.dispatchFetch("https://inventory.dinkuskit.invalid/v1/status", { headers: { authorization: `Bearer ${token}`, "x-inventory-site": headerSite } });
	}
	try {
		const valid = await status();
		assert.equal(valid.status, 200);
		assert.equal((await valid.json()).status, "unconnected");
		assert.equal((await status({ issuer: "https://accounts.dinkuskit.invalid" })).status, 401);
		assert.equal((await status({ kid: "unknown-test-key" })).status, 401);
		assert.equal((await status({ scope: "other:admin" })).status, 401);
		assert.equal((await status({ headerSite: "foreign-test-site" })).status, 401);
		healthy = false;
		assert.equal((await status()).status, 503);
		assert.ok(observed.every(row => row.url === "https://dinkuskit.com/account/.well-known/jwks.json" && row.method === "GET" && !row.authorizationPresent));
	} finally { await mf.dispose(); }
});
