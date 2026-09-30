import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AccountPrincipal } from "../features/hosted-onboarding/index.ts";

export type AccountAuthConfig = { issuer: string; jwksUrl: string; audience: string };
export function createAccountAuthenticator(config: AccountAuthConfig, key?: JWTVerifyGetKey) {
	if (new URL(config.issuer).protocol !== "https:" || new URL(config.jwksUrl).protocol !== "https:") throw new Error("Account issuer and JWKS must use HTTPS");
	const resolveKey = key ?? createRemoteJWKSet(new URL(config.jwksUrl));
	return async (request: Request): Promise<AccountPrincipal> => {
		const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i);
		if (!match) throw new Error("unauthorized");
		const { payload } = await jwtVerify(match[1], resolveKey, {
			issuer: config.issuer, audience: config.audience, algorithms: ["RS256", "ES256"], requiredClaims: ["exp", "sub", "iat"],
		});
		if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 200 || typeof payload.site_id !== "string" || !payload.site_id.trim() || payload.site_id.length > 200 || typeof payload.scope !== "string" || !payload.scope.split(" ").includes("inventory:admin")) throw new Error("unauthorized");
		if (request.headers.get("x-inventory-site") !== payload.site_id) throw new Error("unauthorized");
		// Ownership comes from the signed issuer subject; body/query claims are never consulted.
		return { accountId: JSON.stringify([config.issuer, payload.sub]), siteId: payload.site_id };
	};
}
