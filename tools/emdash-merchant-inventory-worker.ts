/** Installed merchant test only. Trusts the actual Website public JWKS route;
 * never accepts the synthetic stock fixture signer or a supplied principal. */
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { createAccountAuthenticator } from "../src/cloudflare/account-auth.ts";
import { createHostedInventoryHandler, type HostedInventoryEnv, InventoryAccount, InventoryPool } from "../src/cloudflare/hosted-worker.ts";

export { InventoryAccount, InventoryPool };
type MerchantProofEnv = HostedInventoryEnv & { PROOF_MERCHANT_JWKS: Fetcher };
const issuer = "https://dinkuskit.com/account";
const jwksUrl = `${issuer}/.well-known/jwks.json`;

async function readPublicJwks(response: Response): Promise<JSONWebKeySet> {
	if (!response.ok || !response.body) throw new Error("public_jwks_unavailable");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0, text = "";
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > 8192) { await reader.cancel(); throw new Error("public_jwks_invalid"); }
		text += decoder.decode(chunk.value, { stream: true });
	}
	text += decoder.decode();
	const jwks = JSON.parse(text) as JSONWebKeySet;
	if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.some(key =>
		!key || key.kty !== "EC" || key.crv !== "P-256" || key.alg !== "ES256" || typeof key.kid !== "string" || !key.kid ||
		["d", "p", "q", "dp", "dq", "qi", "k"].some(field => field in key))) {
		throw new Error("public_jwks_invalid");
	}
	return jwks;
}

export default {
	async fetch(request: Request, env: MerchantProofEnv) {
		let jwks: JSONWebKeySet;
		try {
			jwks = await readPublicJwks(await env.PROOF_MERCHANT_JWKS.fetch(new Request(jwksUrl)));
		} catch {
			return Response.json({ error: "merchant_jwks_unavailable" }, { status: 503 });
		}
		const authenticate = createAccountAuthenticator({ issuer, jwksUrl, audience: "inventory" }, createLocalJWKSet(jwks));
		return createHostedInventoryHandler(env, authenticate)(request);
	},
};
