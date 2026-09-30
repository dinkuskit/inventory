import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

const WEBSITE = "https://accounts.dinkuskit.invalid";
const CALLBACK = "https://shop.example.com/_emdash/admin/plugins/dinkus-inventory/inventory";
const ADMIN_OLD = "sim-admin-1";
const ADMIN_NEW = "sim-admin-2";

function publicSession(snap) {
	if (!snap.present || !snap.session) {
		return { present: false, revision: null, phase: null, connectionId: null, initiatingAdminId: null };
	}
	const session = snap.session;
	return {
		present: true,
		revision: snap.revision,
		phase: session.phase ?? null,
		connectionId: session.phase === "challenge" ? session.connectionId : null,
		initiatingAdminId: session.phase === "challenge" ? session.initiatingAdminId : null,
	};
}

function createVersioned(casGate) {
	const items = new Map();
	let rev = 0;
	const reads = [];
	return {
		async get(key) {
			await Promise.resolve();
			return items.get(key)?.value ?? null;
		},
		async getVersioned(key) {
			await Promise.resolve();
			const stored = items.get(key) ?? null;
			if (key === "connectionSession") {
				const session = stored ? JSON.parse(stored.value) : null;
				reads.push({
					revision: stored?.revision ?? null,
					phase: session?.phase ?? null,
					connectionId: session?.phase === "challenge" ? session.connectionId : null,
					afterOldCasApplied: casGate.applied,
					afterOldCasReleased: casGate.released,
				});
			}
			return stored;
		},
		async compareAndSet(key, revision, value) {
			await Promise.resolve();
			const cur = items.get(key);
			if ((cur?.revision ?? null) !== revision) return { applied: false };
			const next = `r${++rev}`;
			items.set(key, { value, revision: next });
			const result = { applied: true, revision: next };
			if (key === "connectionSession" && casGate.accept && !casGate.armedOnce) {
				const session = JSON.parse(value);
				if (session.phase === "challenge" && session.connectionId === "conn-old") {
					casGate.armedOnce = true;
					casGate.applied = true;
					casGate.appliedRevision = next;
					casGate.appliedConnectionId = session.connectionId;
					await casGate.promise;
					casGate.released = true;
				}
			}
			return result;
		},
		async compareAndDelete(key, revision) {
			await Promise.resolve();
			const cur = items.get(key);
			if (!cur || cur.revision !== revision) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
		snapshot() {
			const stored = items.get("connectionSession");
			if (!stored) return { present: false, revision: null, session: null };
			return { present: true, revision: stored.revision, session: JSON.parse(stored.value) };
		},
		proofPresent(connectionId) {
			return items.has(`state:store-proof:${connectionId}`);
		},
		reads() {
			return reads.slice();
		},
	};
}

function createCtx(httpFetch, settings, kv) {
	return {
		site: { url: "https://shop.example.com" },
		url(path) {
			return `https://shop.example.com${path}`;
		},
		http: { fetch: httpFetch },
		settings,
		kv,
	};
}

async function invokeAdmin(ctx, input, adminId) {
	return plugin.routes.admin.handler({ input, user: { id: adminId } }, ctx);
}

async function proofAvailability(ctx, connectionId) {
	const result = await plugin.routes["store-proof"].handler({ input: { connection_id: connectionId } }, ctx);
	let error = null;
	let published = false;
	if (result?.body?.kind === "text" && typeof result.body.value === "string") {
		const parsed = JSON.parse(result.body.value);
		error = typeof parsed.error === "string" ? parsed.error : null;
		published = result.status === 200 && parsed.connection_id === connectionId;
	}
	return { status: result.status, published, error };
}

function startBody(connectionId, now) {
	return {
		connection_id: connectionId,
		challenge: `chal-${connectionId}`,
		verification_uri: `${WEBSITE}/account/connect?connection_id=${connectionId}`,
		expires_in: 600,
		expires_at: now + 60_000,
		interval: 1,
	};
}

function sessionOf(connectionId, now, adminId, expiresAt = now + 60_000) {
	return {
		phase: "challenge",
		connectionId,
		challenge: `chal-${connectionId}`,
		verificationUri: `${WEBSITE}/account/connect?connection_id=${connectionId}`,
		expiresAt,
		interval: 1_000,
		nextPoll: 0,
		codeVerifier: "V".repeat(43),
		initiatingAdminId: adminId,
		siteId: "sim-site-1",
		siteOrigin: "https://shop.example.com",
		callbackUri: CALLBACK,
		codeChallenge: "C".repeat(43),
	};
}

async function seedChallenge(settings, kv, now, connectionId, adminId, expiresAt = now + 60_000) {
	await kv.compareAndSet("state:site-id", null, "sim-site-1");
	const session = sessionOf(connectionId, now, adminId, expiresAt);
	await settings.compareAndSet("connectionSession", null, JSON.stringify(session));
	await kv.compareAndSet(`state:store-proof:${connectionId}`, null, {
		version: 1,
		connection_id: connectionId,
		challenge: session.challenge,
		client_id: "dinkus-inventory-emdash",
		service: "inventory",
		site_id: session.siteId,
		site_origin: session.siteOrigin,
		callback_uri: session.callbackUri,
		code_challenge: session.codeChallenge,
		expires_at: session.expiresAt,
	});
	return session;
}

async function waitUntil(predicate, label) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(`timeout waiting for ${label}`);
}

async function runGap(tokenError) {
	const casGate = {
		accept: false,
		armedOnce: false,
		applied: false,
		released: false,
		appliedRevision: null,
		appliedConnectionId: null,
	};
	casGate.promise = new Promise((resolve) => {
		casGate.release = resolve;
	});
	const settings = createVersioned(casGate);
	const kv = createVersioned({
		armedOnce: true,
		applied: false,
		released: false,
		promise: Promise.resolve(),
		release() {},
	});
	let now = 5_000_000;
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		const seeded = await seedChallenge(settings, kv, now, "conn-old", ADMIN_OLD);
		casGate.accept = true;
		const tokenRequests = [];
		const httpFetch = async (url, init) => {
			if (String(url).endsWith("/api/store-connections/token")) {
				const posted = JSON.parse(String(init?.body ?? "{}"));
				tokenRequests.push({ connection_id: posted.connection_id ?? null });
				return {
					ok: false,
					status: 400,
					json: async () => ({ error: tokenError }),
				};
			}
			if (String(url).endsWith("/api/store-connections")) {
				return { ok: true, status: 200, json: async () => startBody("conn-new", Date.now()) };
			}
			throw new Error(`unexpected fetch ${url}`);
		};
		const ctx = createCtx(httpFetch, settings, kv);
		const poll = invokeAdmin(ctx, { type: "block_action", action_id: "check_sign_in" }, ADMIN_OLD);
		await waitUntil(() => casGate.applied, "old nextPoll CAS applied");
		now = seeded.expiresAt + 1;
		await invokeAdmin(ctx, { type: "block_action", action_id: "connect" }, ADMIN_NEW);
		casGate.release();
		await poll;
		const final = publicSession(settings.snapshot());
		const proofs = {
			neu: {
				kvPresent: kv.proofPresent("conn-new"),
				...(await proofAvailability(ctx, "conn-new")),
			},
		};
		return { final, proofs };
	} finally {
		Date.now = originalNow;
	}
}

test("delayed poll CAS response does not delete newly connected session on expired_token", async () => {
	const result = await runGap("expired_token");
	assert.equal(result.final.present, true, "newly connected session must remain present in settings");
	assert.equal(result.final.connectionId, "conn-new", "connectionId must remain conn-new");
	assert.equal(result.final.initiatingAdminId, ADMIN_NEW, "initiatingAdminId must remain ADMIN_NEW");
	assert.equal(result.proofs.neu.published, true, "conn-new public proof route must remain published");
});

test("delayed poll CAS response does not overwrite newly connected session on slow_down", async () => {
	const result = await runGap("slow_down");
	assert.equal(result.final.present, true, "newly connected session must remain present in settings");
	assert.equal(result.final.connectionId, "conn-new", "connectionId must remain conn-new");
	assert.equal(result.final.initiatingAdminId, ADMIN_NEW, "initiatingAdminId must remain ADMIN_NEW");
	assert.equal(result.proofs.neu.published, true, "conn-new public proof route must remain published");
});

test("delayed SUCCESS response longer than polling interval retains token and permits only one exchange in flight", async () => {
	const settings = createVersioned({ accept: false, armedOnce: true, applied: false });
	const kv = createVersioned({ accept: false, armedOnce: true, applied: false });
	let now = 5_000_000;
	const originalNow = Date.now;
	Date.now = () => now;
	let tokenRequests = 0;
	let releaseToken;
	const tokenGate = new Promise((resolve) => {
		releaseToken = resolve;
	});
	try {
		await seedChallenge(settings, kv, now, "conn-old", ADMIN_OLD);

		const httpFetch = async (url) => {
			if (String(url).endsWith("/api/store-connections/token")) {
				tokenRequests++;
				if (tokenRequests === 1) {
					await tokenGate;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							access_token: "simulated-token",
							token_type: "Bearer",
							expires_in: 3600,
							site_id: "sim-site-1",
						}),
					};
				}
				return { ok: false, status: 400, json: async () => ({ error: "already_redeemed" }) };
			}
			return { ok: false, status: 503, json: async () => ({ error: "simulated_inventory_unavailable" }) };
		};
		const ctx = createCtx(httpFetch, settings, kv);
		assert.equal((await proofAvailability(ctx, "conn-old")).published, true, "seeded challenge has valid public proof");

		const input = { type: "block_action", action_id: "check_sign_in" };
		const first = invokeAdmin(ctx, input, ADMIN_OLD);
		await waitUntil(() => tokenRequests === 1, "first token redemption held");

		// Advance time past the polling interval (interval is 1000ms)
		now += 1_001;

		// Second poll from same admin arrives after nextPoll interval elapsed
		const second = invokeAdmin(ctx, input, ADMIN_OLD);
		await second;

		const beforeRelease = publicSession(settings.snapshot());
		assert.equal(tokenRequests, 1, "only one exchange may be in flight; cadence expiry must not admit overlapping exchange");
		assert.equal(beforeRelease.present, true, "session must remain present while first request is awaiting response");

		// Release first token response
		releaseToken();
		await first;

		const final = publicSession(settings.snapshot());
		assert.equal(tokenRequests, 1, "no second token exchange occurred");
		assert.equal(final.present, true, "session must be present after delayed success");
		assert.equal(final.phase, "token", "delayed success response must transition session to token phase");
		assert.equal(kv.proofPresent("conn-old"), false, "public proof must be deleted on success");
	} finally {
		releaseToken?.();
		Date.now = originalNow;
	}
});

test("simultaneous same-CAS poll requests result in exactly one exchange and final token session", async () => {
	const settings = createVersioned({ accept: false, armedOnce: true, applied: false });
	const kv = createVersioned({ accept: false, armedOnce: true, applied: false });
	let now = 5_000_000;
	let tokenRequests = 0;
	let casFailures = 0;
	const originalNow = Date.now;
	Date.now = () => now;
	let releaseToken;
	const tokenGate = new Promise((resolve) => {
		releaseToken = resolve;
	});
	try {
		await seedChallenge(settings, kv, now, "conn-old", ADMIN_OLD);
		const compare = settings.compareAndSet.bind(settings);
		settings.compareAndSet = async (...args) => {
			const r = await compare(...args);
			if (!r.applied) casFailures++;
			return r;
		};

		const httpFetch = async (url) => {
			if (String(url).endsWith("/api/store-connections/token")) {
				tokenRequests++;
				if (tokenRequests === 1) {
					await tokenGate;
					return {
						ok: true,
						status: 200,
						json: async () => ({
							access_token: "simulated-token",
							token_type: "Bearer",
							expires_in: 3600,
							site_id: "sim-site-1",
						}),
					};
				}
				return { ok: false, status: 400, json: async () => ({ error: "already_redeemed" }) };
			}
			return { ok: false, status: 503, json: async () => ({ error: "simulated_inventory_unavailable" }) };
		};
		const ctx = createCtx(httpFetch, settings, kv);
		const input = { type: "block_action", action_id: "check_sign_in" };

		const first = invokeAdmin(ctx, input, ADMIN_OLD);
		const second = invokeAdmin(ctx, input, ADMIN_OLD);
		await waitUntil(() => tokenRequests === 1, "first token redemption held");

		await second;
		releaseToken();
		await first;

		const final = publicSession(settings.snapshot());
		assert.equal(tokenRequests, 1, "exactly one token request issued");
		assert.ok(casFailures >= 1, "losing CAS must fail safely");
		assert.equal(final.present, true, "session must be present");
		assert.equal(final.phase, "token", "winning CAS must save token");
	} finally {
		releaseToken?.();
		Date.now = originalNow;
	}
});

test("pending authorization response permits next poll after interval without wedging", async () => {
	const settings = createVersioned({ accept: false, armedOnce: true, applied: false });
	const kv = createVersioned({ accept: false, armedOnce: true, applied: false });
	let now = 5_000_000;
	let tokenRequests = 0;
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		await seedChallenge(settings, kv, now, "conn-old", ADMIN_OLD);

		const httpFetch = async (url) => {
			if (String(url).endsWith("/api/store-connections/token")) {
				tokenRequests++;
				return {
					ok: false,
					status: 400,
					json: async () => ({ error: "authorization_pending" }),
				};
			}
			return { ok: false, status: 503, json: async () => ({ error: "simulated_inventory_unavailable" }) };
		};
		const ctx = createCtx(httpFetch, settings, kv);
		const input = { type: "block_action", action_id: "check_sign_in" };

		// First poll runs, gets authorization_pending
		await invokeAdmin(ctx, input, ADMIN_OLD);
		assert.equal(tokenRequests, 1, "first poll completed exchange");

		// Attempting poll immediately should not execute token exchange
		await invokeAdmin(ctx, input, ADMIN_OLD);
		assert.equal(tokenRequests, 1, "polling before cadence interval must return early");

		// Advance time past interval
		now += 1_001;

		// Next poll after interval should be permitted
		await invokeAdmin(ctx, input, ADMIN_OLD);
		assert.equal(tokenRequests, 2, "poll after interval must be admitted without wedging");
	} finally {
		Date.now = originalNow;
	}
});

test("unexpected fetch error restores nextPoll without wedging safe permitted polling", async () => {
	const settings = createVersioned({ accept: false, armedOnce: true, applied: false });
	const kv = createVersioned({ accept: false, armedOnce: true, applied: false });
	let now = 5_000_000;
	let tokenRequests = 0;
	let simulateFailure = true;
	const originalNow = Date.now;
	Date.now = () => now;
	try {
		await seedChallenge(settings, kv, now, "conn-old", ADMIN_OLD);

		const httpFetch = async (url) => {
			if (String(url).endsWith("/api/store-connections/token")) {
				tokenRequests++;
				if (simulateFailure) {
					throw new Error("simulated network connection reset");
				}
				return {
					ok: true,
					status: 200,
					json: async () => ({
						access_token: "simulated-token-2",
						token_type: "Bearer",
						expires_in: 3600,
						site_id: "sim-site-1",
					}),
				};
			}
			return { ok: false, status: 503, json: async () => ({ error: "simulated_inventory_unavailable" }) };
		};
		const ctx = createCtx(httpFetch, settings, kv);
		const input = { type: "block_action", action_id: "check_sign_in" };

		// First poll runs, fetch throws
		await invokeAdmin(ctx, input, ADMIN_OLD);
		assert.equal(tokenRequests, 1, "first poll attempted exchange");

		// Advance time past interval
		now += 1_001;
		simulateFailure = false;

		// Next poll after interval should be permitted to retry
		await invokeAdmin(ctx, input, ADMIN_OLD);
		assert.equal(tokenRequests, 2, "poll after network error must be admitted without wedging");

		const final = publicSession(settings.snapshot());
		assert.equal(final.present, true, "session present after successful retry");
		assert.equal(final.phase, "token", "successful retry saves token");
	} finally {
		Date.now = originalNow;
	}
});
