import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { ACCOUNT_OVERVIEW_AUDIENCE, createAccountOverviewVerifier } from "../../src/cloudflare/account-overview-auth.ts";

const issuer = "https://accounts.example.test";
const config = { issuer, jwksUrl: `${issuer}/.well-known/jwks.json` };

async function fixture(overrides = {}, options = {}) {
	const keys = options.keys ?? await generateKeyPair(options.alg ?? "ES256");
	const current = options.current ?? Math.floor(Date.now() / 1000);
	const verifier = createAccountOverviewVerifier(config, createLocalJWKSet({ keys: [{ ...(await exportJWK(keys.publicKey)), alg: options.alg ?? "ES256", kid: "fixture" }] }), () => current);
	const now = options.iat ?? current - 1;
	const payload = {
		iss: options.tokenIssuer ?? issuer,
		aud: options.audience ?? ACCOUNT_OVERVIEW_AUDIENCE,
		sub: options.subject ?? "operator-1",
		iat: now,
		exp: options.exp ?? now + 60,
		scope: "inventory:account-overview:read",
		organization_id: "org-1",
		organization_subject: "subject-1",
		...overrides,
	};
	const token = await new SignJWT(payload)
		.setProtectedHeader({ alg: options.alg ?? "ES256", kid: "fixture" })
		.sign(keys.privateKey);
	return { verifier, request: new Request("https://inventory.example/v1/account-overview", { headers: { Authorization: `Bearer ${token}` } }) };
}

test("verifies a real signed metadata-only overview token and derives the configured account key", async () => {
	const { verifier, request } = await fixture();
	assert.deepEqual(await verifier(request), {
		organizationId: "org-1",
		accountId: JSON.stringify([issuer, "subject-1"]),
		callerId: "operator-1",
	});
});

for (const [name, overrides, options] of [
	["admin scope", { scope: "inventory:admin" }],
	["extra scope", { scope: "inventory:account-overview:read inventory:admin" }],
	["missing organization id", { organization_id: undefined }],
	["missing organization subject", { organization_subject: undefined }],
	["blank organization id", { organization_id: "  " }],
	["whitespace in caller id", {}, { subject: " operator-1" }],
	["whitespace in organization id", { organization_id: " org-1" }],
	["whitespace in organization subject", { organization_subject: " subject-1" }],
]) {
	test(`rejects ${name}`, async () => {
		const { verifier, request } = await fixture(overrides, options);
		await assert.rejects(verifier(request), /unauthorized|JWT/);
	});
}

test("rejects wrong issuer, audience, expired, overlong, future-issued, and unsigned selector claims", async () => {
	const current = Math.floor(Date.now() / 1000);
	for (const options of [
		{ tokenIssuer: "https://other.example.test" },
		{ audience: "inventory" },
		{ current, iat: current - 2, exp: current - 1 },
		{ current, iat: current - 1, exp: current + 300 },
		{ current, iat: current + 1, exp: current + 61 },
	]) {
		const { verifier, request } = await fixture({}, options);
		await assert.rejects(verifier(request));
	}
	const { verifier, request } = await fixture({ accountId: "browser-selected", pool_id: "browser-pool" }, { current });
	const principal = await verifier(request);
	assert.equal(principal.accountId, JSON.stringify([issuer, "subject-1"]));
	assert.equal(principal.organizationId, "org-1");
	assert.equal(principal.callerId, "operator-1");
});

test("accepts RS256 and rejects a non-HTTPS trust configuration", async () => {
	const { verifier, request } = await fixture({}, { alg: "RS256" });
	assert.equal((await verifier(request)).organizationId, "org-1");
	assert.throws(() => createAccountOverviewVerifier({ issuer: "http://accounts.example.test", jwksUrl: config.jwksUrl }), /HTTPS/);
});

test("accepts the exact 300-second lifetime", async () => {
	const current = Math.floor(Date.now() / 1000);
	const { verifier, request } = await fixture({}, { current, iat: current - 1, exp: current + 299 });
	assert.equal((await verifier(request)).accountId, JSON.stringify([issuer, "subject-1"]));
});

test("rejects missing bearer, wrong signer, required claim gaps, wrong claim types, overlong claims, and multi-audience tokens", async () => {
	const current = Math.floor(Date.now() / 1000);
	const { verifier } = await fixture({}, { current });
	await assert.rejects(verifier(new Request("https://inventory.example/v1/account-overview")), /unauthorized/);

	const wrongSigner = await generateKeyPair("ES256");
	const wrong = await fixture({}, { current, keys: wrongSigner });
	await assert.rejects(verifier(wrong.request));

	for (const overrides of [
		{ exp: undefined },
		{ iat: undefined },
		{ sub: undefined },
		{ organization_id: 7 },
		{ organization_subject: 7 },
		{ scope: 7 },
		{ sub: "x".repeat(201) },
		{ organization_id: "x".repeat(201) },
		{ organization_subject: "x".repeat(201) },
	]) {
		const fixtureResult = await fixture(overrides, { current });
		await assert.rejects(fixtureResult.verifier(fixtureResult.request));
	}

	const multiAudience = await fixture({}, { current, audience: [ACCOUNT_OVERVIEW_AUDIENCE, "inventory"] });
	await assert.rejects(multiAudience.verifier(multiAudience.request));
});
