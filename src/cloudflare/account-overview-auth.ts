import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export const ACCOUNT_OVERVIEW_AUDIENCE = "inventory-account-overview";
const ACCOUNT_OVERVIEW_SCOPE = "inventory:account-overview:read";
const MAX_TOKEN_LIFETIME_SECONDS = 300;

export type AccountOverviewPrincipal = Readonly<{
	accountId: string;
	organizationId: string;
	callerId: string;
}>;

export type AccountOverviewAuthConfig = Readonly<{
	issuer: string;
	jwksUrl: string;
}>;

export function createAccountOverviewVerifier(
	config: AccountOverviewAuthConfig,
	key?: JWTVerifyGetKey,
	now: () => number = () => Math.floor(Date.now() / 1000),
) {
	if (new URL(config.issuer).protocol !== "https:" || new URL(config.jwksUrl).protocol !== "https:") {
		throw new Error("Account issuer and JWKS must use HTTPS");
	}
	const resolveKey = key ?? createRemoteJWKSet(new URL(config.jwksUrl));
	return async (request: Request): Promise<AccountOverviewPrincipal> => {
		const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i);
		if (!match) throw new Error("unauthorized");
		const { payload } = await jwtVerify(match[1], resolveKey, {
			issuer: config.issuer,
			audience: ACCOUNT_OVERVIEW_AUDIENCE,
			algorithms: ["RS256", "ES256"],
			requiredClaims: ["exp", "iat", "sub"],
		});
		if (
			typeof payload.aud !== "string" || payload.aud !== ACCOUNT_OVERVIEW_AUDIENCE ||
			typeof payload.sub !== "string" || !payload.sub || payload.sub !== payload.sub.trim() || payload.sub.length > 200 ||
			typeof payload.scope !== "string" || payload.scope !== ACCOUNT_OVERVIEW_SCOPE ||
			typeof payload.organization_id !== "string" || !payload.organization_id || payload.organization_id !== payload.organization_id.trim() || payload.organization_id.length > 200 ||
			typeof payload.organization_subject !== "string" || !payload.organization_subject || payload.organization_subject !== payload.organization_subject.trim() || payload.organization_subject.length > 200 ||
			typeof payload.iat !== "number" || !Number.isInteger(payload.iat) ||
			typeof payload.exp !== "number" || !Number.isInteger(payload.exp)
		) throw new Error("unauthorized");
		const current = now();
		if (payload.iat > current || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_TOKEN_LIFETIME_SECONDS) {
			throw new Error("unauthorized");
		}
		return {
			organizationId: payload.organization_id,
			accountId: JSON.stringify([config.issuer, payload.organization_subject]),
			callerId: payload.sub,
		};
	};
}
