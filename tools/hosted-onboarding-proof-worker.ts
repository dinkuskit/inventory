/** Local proof only. Never a deploy target; accepts ephemeral synthetic issuer keys. */
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { createAccountAuthenticator } from "../src/cloudflare/account-auth.ts";
import { createHostedInventoryHandler, type HostedInventoryEnv, InventoryAccount, InventoryPool } from "../src/cloudflare/hosted-worker.ts";
export { InventoryAccount, InventoryPool };
export default {
	async fetch(request: Request, env: HostedInventoryEnv & { PROOF_JWKS: string }) {
		const auth = createAccountAuthenticator({ issuer: "https://accounts.dinkuskit.invalid", jwksUrl: "https://accounts.dinkuskit.invalid/jwks", audience: "inventory" }, createLocalJWKSet(JSON.parse(env.PROOF_JWKS) as JSONWebKeySet));
		return createHostedInventoryHandler(env, auth)(request);
	},
};
