import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccountAuthenticator } from "../../src/cloudflare/account-auth.ts";

test("JWT resource boundary validates issuer, audience, signature, expiry, scope and site binding", async () => {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const other = await generateKeyPair("ES256");
	const key = await exportJWK(publicKey);
	const config = { issuer: "https://accounts.dinkuskit.invalid", audience: "inventory", jwksUrl: "https://accounts.dinkuskit.invalid/jwks" };
	const authenticate = createAccountAuthenticator(config, createLocalJWKSet({ keys: [{ ...key, alg: "ES256" }] }));
	async function token(overrides = {}, signingKey = privateKey) {
		return new SignJWT({ scope: "inventory:admin", site_id: "site-1", ...overrides }).setProtectedHeader({ alg: "ES256" }).setIssuer(config.issuer).setAudience(config.audience).setSubject("account-1").setIssuedAt().setExpirationTime("5m").sign(signingKey);
	}
	const request = value => new Request("https://inventory.dinkuskit.invalid/v1/status", { headers: { Authorization: `Bearer ${value}`, "X-Inventory-Site": "site-1" } });
	assert.deepEqual(await authenticate(request(await token())), { accountId: JSON.stringify([config.issuer, "account-1"]), siteId: "site-1" });
	await assert.rejects(authenticate(request(await token({}, other.privateKey))));
	await assert.rejects(authenticate(request(await token({ scope: "profile" }))));
	await assert.rejects(authenticate(request(await token({ site_id: "site-2" }))));
	for (const property of ["iss", "aud", "exp", "sub", "iat"]) {
		const payload = { iss: config.issuer, aud: config.audience, sub: "account-1", scope: "inventory:admin", site_id: "site-1", exp: Math.floor(Date.now()/1000)+300, iat: Math.floor(Date.now()/1000) };
		if (property === "iss" || property === "aud") payload[property] = "wrong";
		else if (property === "exp") payload[property] = 1;
		else delete payload[property];
		await assert.rejects(authenticate(request(await new SignJWT(payload).setProtectedHeader({ alg: "ES256" }).sign(privateKey))));
	}
	await assert.rejects(authenticate(new Request("https://inventory.dinkuskit.invalid/v1/status")));
});
