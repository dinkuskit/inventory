import assert from "node:assert/strict";
import test from "node:test";
import {
	STORE_CONNECT_CLIENT_ID,
	STORE_CONNECT_SERVICE,
	STORE_CONNECT_VERIFICATION_PATH,
	approvedCallbackUri,
	assertStartResponseBounds,
	assertVerificationUri,
	canonicalizeSiteOrigin,
	createPkcePair,
	createProofReceipt,
	pkceMatches,
	proofReceiptSchema,
	publicProofFor,
	requireBoundAdministrator,
	requireOriginatingAdministrator,
	resumeActiveChallenge,
	s256Challenge,
	startRequestSchema,
	startResponseSchema,
} from "../../src/features/store-connect/index.ts";

test("site origin is host-configured HTTPS or labeled loopback only", () => {
	assert.equal(canonicalizeSiteOrigin("https://shop.example.com"), "https://shop.example.com");
	assert.equal(canonicalizeSiteOrigin("http://localhost:4329", { allowLoopback: true }), "http://localhost:4329");
	assert.equal(canonicalizeSiteOrigin("http://127.0.0.1:4329", { allowLoopback: true }), "http://127.0.0.1:4329");
	assert.throws(() => canonicalizeSiteOrigin("http://localhost:4329"), /invalid_site_origin/);
	assert.throws(() => canonicalizeSiteOrigin("http://shop.example.com", { allowLoopback: true }), /invalid_site_origin/);
	assert.throws(() => canonicalizeSiteOrigin("https://user:pass@shop.example.com"), /invalid_site_origin/);
	assert.throws(() => canonicalizeSiteOrigin("https://shop.example.com/?q=1"), /invalid_site_origin/);
	assert.throws(() => canonicalizeSiteOrigin("https://shop.example.com/#frag"), /invalid_site_origin/);
	assert.throws(() => canonicalizeSiteOrigin("not-a-url"), /invalid_site_origin/);
	assert.throws(() => canonicalizeSiteOrigin(""), /invalid_site_origin/);
});

test("callback is the frozen Inventory admin return path", () => {
	assert.equal(
		approvedCallbackUri("https://shop.example.com"),
		"https://shop.example.com/_emdash/admin/plugins/dinkus-inventory/inventory",
	);
});

test("PKCE S256 matches only the original verifier", async () => {
	const pair = await createPkcePair();
	assert.equal(await pkceMatches(pair.verifier, pair.challenge), true);
	assert.equal(await pkceMatches("tampered-verifier-that-is-long-enough-to-parse", pair.challenge), false);
	assert.equal(await s256Challenge(pair.verifier), pair.challenge);
});

test("proof receipt is public-safe and expires", () => {
	const receipt = createProofReceipt({
		connectionId: "conn-1",
		challenge: "chal-1",
		siteId: "site-1",
		siteOrigin: "http://localhost:4329",
		callbackUri: "http://localhost:4329/_emdash/admin/plugins/dinkus-inventory/inventory",
		codeChallenge: "abc",
		expiresAt: 2_000,
	});
	assert.equal(receipt.client_id, STORE_CONNECT_CLIENT_ID);
	assert.equal(receipt.service, STORE_CONNECT_SERVICE);
	assert.equal(publicProofFor(receipt, "conn-1", 1_000)?.connection_id, "conn-1");
	assert.equal(publicProofFor(receipt, "other", 1_000), null);
	assert.equal(publicProofFor(receipt, "conn-1", 2_000), null);
	const serialized = JSON.stringify(receipt);
	assert.doesNotMatch(serialized, /code_verifier|codeVerifier|access_token|email|initiating_admin|initiatingAdmin/);
	assert.throws(() => proofReceiptSchema.parse({ ...receipt, initiating_admin_id: "admin-1" }));
});

test("start request rejects caller-supplied extras and wrong client", () => {
	const valid = {
		protocol_version: 2,
		client_id: STORE_CONNECT_CLIENT_ID,
		service: STORE_CONNECT_SERVICE,
		site_origin: "https://shop.example.com",
		callback_uri: "https://shop.example.com/_emdash/admin/plugins/dinkus-inventory/inventory",
		code_challenge: "abc",
		code_challenge_method: "S256",
	};
	assert.deepEqual(startRequestSchema.parse(valid), valid);
	assert.throws(() => startRequestSchema.parse({ ...valid, site_origin: "https://attacker.example" , extra: true }));
	assert.throws(() => startRequestSchema.parse({ ...valid, client_id: "other-client" }));
});

test("bound administrator and originating-admin checks fail closed", () => {
	assert.equal(requireBoundAdministrator({ id: "admin-1" }), "admin-1");
	assert.throws(() => requireBoundAdministrator(undefined), /unbound_administrator/);
	assert.throws(() => requireBoundAdministrator({}), /unbound_administrator/);
	requireOriginatingAdministrator("admin-1", "admin-1");
	assert.throws(() => requireOriginatingAdministrator("admin-1", "admin-2"), /wrong_originating_admin/);
	const session = {
		phase: "challenge",
		connectionId: "c1",
		challenge: "ch",
		verificationUri: "https://accounts.dinkuskit.invalid/account/connect?connection_id=c1",
		expiresAt: 5_000,
		interval: 1000,
		nextPoll: 0,
		codeVerifier: "a".repeat(43),
		initiatingAdminId: "admin-1",
		siteId: "site-1",
		siteOrigin: "http://localhost:4329",
		callbackUri: "http://localhost:4329/_emdash/admin/plugins/dinkus-inventory/inventory",
		codeChallenge: "abc",
	};
	assert.equal(resumeActiveChallenge(session, "admin-1", 1_000)?.connectionId, "c1");
	assert.throws(() => resumeActiveChallenge(session, "admin-2", 1_000), /wrong_originating_admin/);
	assert.equal(resumeActiveChallenge(session, "admin-1", 5_000), null);
});

test("verification URI is frozen to /account/connect with the exact connection_id", () => {
	const origin = "https://accounts.dinkuskit.invalid";
	const connectionId = "conn-exact";
	assert.equal(STORE_CONNECT_VERIFICATION_PATH, "/account/connect");
	assertVerificationUri(`${origin}/account/connect?connection_id=${connectionId}`, origin, connectionId);
	assert.throws(() => assertVerificationUri("not-a-url", origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/tokens?connection_id=${connectionId}`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/connect/extra?connection_id=${connectionId}`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`https://attacker.example/account/connect?connection_id=${connectionId}`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`https://user:pass@accounts.dinkuskit.invalid/account/connect?connection_id=${connectionId}`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/connect?connection_id=${connectionId}#frag`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/connect?connection_id=${connectionId}&foo=1`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/connect?connection_id=${connectionId}&connection_id=other`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/connect?connection_id=other`, origin, connectionId), /unexpected_website_response/);
	assert.throws(() => assertVerificationUri(`${origin}/account/connect`, origin, connectionId), /unexpected_website_response/);
});

test("start response binds authoritative expires_at and rejects expired or too-far-future values", () => {
	const now = 1_000_000;
	const valid = {
		protocol_version: 2,
		connection_id: "conn-1",
		challenge: "chal-1",
		site_id: "site-1",
		verification_uri: "https://accounts.dinkuskit.invalid/account/connect?connection_id=conn-1",
		expires_in: 600,
		expires_at: now + 60_000,
		interval: 1,
	};
	assert.deepEqual(startResponseSchema.parse(valid), valid);
	assert.equal(assertStartResponseBounds(valid, now), valid.expires_at);
	assert.throws(() => startResponseSchema.parse({ ...valid, extra: true }));
	assert.throws(() => startResponseSchema.parse({ connection_id: valid.connection_id, challenge: valid.challenge, verification_uri: valid.verification_uri, expires_in: valid.expires_in, interval: valid.interval }));
	assert.throws(() => assertStartResponseBounds({ ...valid, expires_at: now }, now), /unexpected_website_response/);
	assert.throws(() => assertStartResponseBounds({ ...valid, expires_at: now - 1 }, now), /unexpected_website_response/);
	assert.throws(() => assertStartResponseBounds({ ...valid, expires_at: now + 601_000 }, now), /unexpected_website_response/);
	assert.throws(() => startResponseSchema.parse({ ...valid, expires_in: 601 }), /expires_in/);
});
