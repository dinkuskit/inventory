import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

// Exact current-main OAuth device session persisted in connectionSession.
const CURRENT_MAIN_DEVICE_SESSION = {
	phase: "device",
	deviceCode: "dev-code-1",
	userCode: "WDJB-MJHT",
	verificationUri: "https://accounts.dinkuskit.invalid/device",
	expiresAt: 9_000_000_000_000,
	interval: 5000,
	nextPoll: 1000,
};

const VALID_CHALLENGE_SESSION = {
	protocolVersion: 2,
	phase: "challenge",
	connectionId: "conn-valid",
	challenge: "chal-valid",
	verificationUri: "https://accounts.dinkuskit.invalid/account/connect?connection_id=conn-valid",
	expiresAt: 9_000_000_000_000,
	interval: 1000,
	nextPoll: 0,
	codeVerifier: "V".repeat(43),
	initiatingAdminId: "admin-1",
	siteId: "sim-site-1",
	siteOrigin: "https://shop.example.com",
	callbackUri: "https://shop.example.com/_emdash/admin/plugins/dinkus-inventory/inventory",
	codeChallenge: "C".repeat(43),
};

const VALID_PROOF_RECEIPT = {
	version: 2,
	connection_id: "conn-valid",
	challenge: "chal-valid",
	client_id: "dinkus-inventory-emdash",
	service: "inventory",
	site_id: "sim-site-1",
	site_origin: "https://shop.example.com",
	callback_uri: "https://shop.example.com/_emdash/admin/plugins/dinkus-inventory/inventory",
	code_challenge: "C".repeat(43),
	expires_at: 9_000_000_000_000,
};

function createSettings(initial) {
	const items = new Map();
	let rev = 0;
	let mutationCount = 0;
	if (initial !== undefined && initial !== null) {
		const value = typeof initial === "string" ? initial : JSON.stringify(initial);
		items.set("connectionSession", { value, revision: `r${++rev}` });
	}
	return {
		async get(key) {
			return items.get(key)?.value ?? null;
		},
		async getVersioned(key) {
			return items.get(key) ?? null;
		},
		async compareAndSet(key, revision, value) {
			mutationCount++;
			const cur = items.get(key);
			if ((cur?.revision ?? null) !== revision) return { applied: false };
			const next = `r${++rev}`;
			items.set(key, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(key, revision) {
			mutationCount++;
			const cur = items.get(key);
			if (!cur || cur.revision !== revision) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
		snapshot() {
			const stored = items.get("connectionSession");
			return stored ? JSON.parse(stored.value) : null;
		},
		mutationCount() {
			return mutationCount;
		},
	};
}

function createKv(initialMap = new Map()) {
	const items = new Map(initialMap);
	let rev = 0;
	let mutationCount = 0;
	return {
		async get(key) {
			const stored = items.get(key);
			if (!stored) return null;
			return typeof stored === "object" && "value" in stored ? stored.value : stored;
		},
		async getVersioned(key) {
			const stored = items.get(key);
			if (!stored) return null;
			return typeof stored === "object" && "revision" in stored ? stored : { value: stored, revision: "r1" };
		},
		async compareAndSet(key, revision, value) {
			mutationCount++;
			const cur = items.get(key);
			const curRev = cur && typeof cur === "object" && "revision" in cur ? cur.revision : null;
			if (curRev !== revision) return { applied: false };
			const next = `r${++rev}`;
			items.set(key, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(key, revision) {
			mutationCount++;
			const cur = items.get(key);
			const curRev = cur && typeof cur === "object" && "revision" in cur ? cur.revision : null;
			if (!cur || curRev !== revision) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
		mutationCount() {
			return mutationCount;
		},
	};
}

function createCtx(settings, kv) {
	return {
		site: { url: "https://shop.example.com" },
		url(path) {
			return `https://shop.example.com${path}`;
		},
		http: {
			fetch: async () => {
				throw new Error("network must not run for public proof read");
			},
		},
		settings,
		kv,
	};
}

test("page load preserves an obsolete device session and offers explicit discard", async () => {
	const settings = createSettings(CURRENT_MAIN_DEVICE_SESSION);
	const ctx = {
		site: { url: "https://shop.example.com" },
		url(path) {
			return `https://shop.example.com${path}`;
		},
		http: {
			fetch: async () => {
				throw new Error("network must not run for leftover device clearance");
			},
		},
		settings,
		kv: createKv(),
	};
	const result = await plugin.routes.admin.handler(
		{ input: { type: "page_load", page: "/inventory" }, user: { id: "admin-1" } },
		ctx,
	);
	const text = JSON.stringify(result);
	assert.ok(settings.snapshot());
	assert.match(text, /Reconnect required/);
	assert.match(text, /Discard obsolete connection/);
	assert.doesNotMatch(text, /Connection could not be confirmed/);
	const discarded = await plugin.routes.admin.handler(
		{ input: { type: "block_action", action_id: "discard_obsolete_connection" }, user: { id: "admin-1" } },
		ctx,
	);
	assert.equal(settings.snapshot(), null);
	assert.match(JSON.stringify(discarded), /Connect Inventory/);
});

test("public store-proof GET leaves legacy device session and settings/KV untouched and returns 404", async () => {
	const settings = createSettings(CURRENT_MAIN_DEVICE_SESSION);
	const kv = createKv();
	const ctx = createCtx(settings, kv);

	const beforeSession = await settings.getVersioned("connectionSession");
	assert.ok(beforeSession, "initial legacy device session must exist");

	for (const id of ["conn-1", "any-random-id", "dev-code-1", "WDJB-MJHT"]) {
		const result = await plugin.routes["store-proof"].handler(
			{ input: { connection_id: id } },
			ctx,
		);
		assert.equal(result.status, 404);
		assert.deepEqual(JSON.parse(result.body.value), { error: "not_found" });
	}

	const afterSession = await settings.getVersioned("connectionSession");
	assert.equal(afterSession?.revision, beforeSession.revision, "connectionSession revision must remain unchanged");
	assert.equal(afterSession?.value, beforeSession.value, "connectionSession value must remain unchanged");
	assert.equal(settings.mutationCount(), 0, "settings must not be mutated by public store-proof GET");
	assert.equal(kv.mutationCount(), 0, "KV must not be mutated by public store-proof GET");
});

test("public store-proof GET fails closed on malformed session JSON with zero mutations and returns 404", async () => {
	const settings = createSettings("not-valid-json{{{");
	const kv = createKv();
	const ctx = createCtx(settings, kv);

	const beforeSession = await settings.getVersioned("connectionSession");
	assert.ok(beforeSession, "initial malformed session must exist");

	const result = await plugin.routes["store-proof"].handler(
		{ input: { connection_id: "conn-1" } },
		ctx,
	);
	assert.equal(result.status, 404);
	assert.deepEqual(JSON.parse(result.body.value), { error: "not_found" });

	const afterSession = await settings.getVersioned("connectionSession");
	assert.equal(afterSession?.revision, beforeSession.revision, "connectionSession revision must remain unchanged");
	assert.equal(afterSession?.value, beforeSession.value, "connectionSession value must remain unchanged");
	assert.equal(settings.mutationCount(), 0, "settings must not be mutated on malformed session JSON");
	assert.equal(kv.mutationCount(), 0, "KV must not be mutated on malformed session JSON");
});

test("public store-proof GET publishes 200 for valid bound active challenge with zero writes", async () => {
	const settings = createSettings(VALID_CHALLENGE_SESSION);
	const kv = createKv(new Map([[`state:store-proof:${VALID_PROOF_RECEIPT.connection_id}`, VALID_PROOF_RECEIPT]]));
	const ctx = createCtx(settings, kv);

	const result = await plugin.routes["store-proof"].handler(
		{ input: { connection_id: VALID_PROOF_RECEIPT.connection_id } },
		ctx,
	);
	assert.equal(result.status, 200);
	const body = JSON.parse(result.body.value);
	assert.equal(body.connection_id, VALID_PROOF_RECEIPT.connection_id);
	assert.equal(body.challenge, VALID_PROOF_RECEIPT.challenge);
	assert.equal(body.client_id, "dinkus-inventory-emdash");
	assert.equal(settings.mutationCount(), 0, "settings must not be mutated on valid public proof read");
	assert.equal(kv.mutationCount(), 0, "KV must not be mutated on valid public proof read");
});

test("public store-proof GET returns 404 with zero writes for stale, unbound, or expired proof", async () => {
	// Case 1: Expired proof receipt
	const expiredReceipt = { ...VALID_PROOF_RECEIPT, expires_at: 1000 };
	const expiredSession = { ...VALID_CHALLENGE_SESSION, expiresAt: 1000 };
	const settings1 = createSettings(expiredSession);
	const kv1 = createKv(new Map([[`state:store-proof:${expiredReceipt.connection_id}`, expiredReceipt]]));
	const ctx1 = createCtx(settings1, kv1);

	const res1 = await plugin.routes["store-proof"].handler(
		{ input: { connection_id: expiredReceipt.connection_id } },
		ctx1,
	);
	assert.equal(res1.status, 404);
	assert.equal(settings1.mutationCount(), 0);
	assert.equal(kv1.mutationCount(), 0);

	// Case 2: Unbound proof (challenge mismatch)
	const settings2 = createSettings({ ...VALID_CHALLENGE_SESSION, challenge: "other-challenge" });
	const kv2 = createKv(new Map([[`state:store-proof:${VALID_PROOF_RECEIPT.connection_id}`, VALID_PROOF_RECEIPT]]));
	const ctx2 = createCtx(settings2, kv2);

	const res2 = await plugin.routes["store-proof"].handler(
		{ input: { connection_id: VALID_PROOF_RECEIPT.connection_id } },
		ctx2,
	);
	assert.equal(res2.status, 404);
	assert.equal(settings2.mutationCount(), 0);
	assert.equal(kv2.mutationCount(), 0);

	// Case 3: Stale / no session in settings
	const settings3 = createSettings(null);
	const kv3 = createKv(new Map([[`state:store-proof:${VALID_PROOF_RECEIPT.connection_id}`, VALID_PROOF_RECEIPT]]));
	const ctx3 = createCtx(settings3, kv3);

	const res3 = await plugin.routes["store-proof"].handler(
		{ input: { connection_id: VALID_PROOF_RECEIPT.connection_id } },
		ctx3,
	);
	assert.equal(res3.status, 404);
	assert.equal(settings3.mutationCount(), 0);
	assert.equal(kv3.mutationCount(), 0);
});
