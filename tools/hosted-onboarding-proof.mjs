import { installedProofVersions } from "./emdash-proof-versions.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createServer } from "vite";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { sqlite } from "emdash/db";
import { createDialect } from "emdash/db/sqlite";
import { EmDashRuntime, dispatchPluginApiRequest } from "emdash/internal/plugin-test-runtime";
import { WorkerdSandboxRunner } from "@emdash-cms/sandbox-workerd";
import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { pkceMatches } from "../src/features/store-connect/index.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = resolve(root, process.env.EMDASH_HOSTED_PROOF_RUN_DIR ?? ".grilltrack/work/store-connect");
await mkdir(run, { recursive: true });
const { emdash: emdashVersion, sandbox: sandboxVersion } = installedProofVersions();
process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;
const keys = await generateKeyPair("ES256");
const publicJwk = { ...await exportJWK(keys.publicKey), alg: "ES256" };
const compiled = await build({ entryPoints: [resolve(root, "tools/hosted-onboarding-proof-worker.ts")], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], write: false });
const service = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2026-08-28", bindings: { PROOF_JWKS: JSON.stringify({ keys: [publicJwk] }) }, durableObjects: { INVENTORY_POOLS: { className: "InventoryPool", useSQLite: true }, INVENTORY_ACCOUNTS: { className: "InventoryAccount", useSQLite: true } } }));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
	if (target.hostname === "cloudflare-dns.com" && ["inventory.dinkuskit.invalid", "accounts.dinkuskit.invalid"].includes(target.searchParams.get("name"))) {
		return Response.json({ Status: 0, Answer: target.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
	}
	return originalFetch(url, init);
};

const SITE_A = "http://localhost:4329";
const SITE_B = "http://127.0.0.1:4330";
const WEBSITE = "https://accounts.dinkuskit.invalid";
const CLIENT = "dinkus-inventory-emdash";
let fixtureAccount = "proof-account-one";
let loseConnectResponse = false;
let loseTokenResponse = false;
let accountUnavailable = false;
let nextExpiresIn = 600;
let overrideExpiresAt = null;
let concurrentStartHold = null;
let concurrentStartArrivals = 0;
let resolveFirstWebsiteStart = null;
let resolveSecondWebsiteStart = null;
const transportEvents = [];
const transactions = new Map();
const owners = new Map();
const issuedTokens = new Map();

function ownerKey(siteOrigin, siteId) { return JSON.stringify([siteOrigin, siteId]); }
function s256(verifier) { return createHash("sha256").update(verifier).digest("base64url"); }

async function fetchPublicProof(runtime, pluginId, connectionId, origin = SITE_A) {
	const response = await dispatchPluginApiRequest({
		runtime, pluginId, path: "store-proof",
		request: new Request(`${origin}/_emdash/api/plugins/dinkus-inventory/store-proof?connection_id=${encodeURIComponent(connectionId)}`),
	});
	const text = await response.text();
	let body = null;
	try { body = JSON.parse(text); } catch { body = { parse_error: true }; }
	return { status: response.status, cache: response.headers.get("cache-control"), body };
}

function websiteStart(body) {
	if (body.client_id !== CLIENT || body.service !== "inventory" || body.code_challenge_method !== "S256") {
		return Response.json({ error: "invalid_request" }, { status: 400 });
	}
	const connectionId = crypto.randomUUID();
	const challenge = randomBytes(16).toString("hex");
	const expiresIn = nextExpiresIn;
	nextExpiresIn = 600;
	const expiresAt = overrideExpiresAt ?? (Date.now() + expiresIn * 1000);
	overrideExpiresAt = null;
	transactions.set(connectionId, {
		connectionId, challenge, clientId: body.client_id, service: body.service,
		siteId: body.site_id, siteOrigin: body.site_origin, callbackUri: body.callback_uri,
		codeChallenge: body.code_challenge, expiresAt,
		approved: false, account: null, consumed: false,
	});
	return Response.json({
		connection_id: connectionId, challenge,
		verification_uri: `${WEBSITE}/account/connect?connection_id=${connectionId}`,
		expires_in: expiresIn, expires_at: expiresAt, interval: 1,
	});
}

async function websiteApprove(runtime, pluginId, connectionId, account = fixtureAccount) {
	const tx = transactions.get(connectionId);
	if (!tx) return { ok: false, error: "invalid_grant" };
	if (tx.expiresAt <= Date.now()) return { ok: false, error: "expired_token" };
	const proof = await fetchPublicProof(runtime, pluginId, connectionId, tx.siteOrigin === SITE_B ? SITE_B : SITE_A);
	if (proof.status !== 200) return { ok: false, error: "proof_mismatch" };
	const receipt = proof.body;
	for (const [field, expected] of [
		["connection_id", tx.connectionId], ["challenge", tx.challenge], ["client_id", tx.clientId],
		["service", tx.service], ["site_id", tx.siteId], ["site_origin", tx.siteOrigin],
		["callback_uri", tx.callbackUri], ["code_challenge", tx.codeChallenge],
	]) {
		if (receipt[field] !== expected) return { ok: false, error: "proof_mismatch" };
	}
	if (receipt.expires_at !== tx.expiresAt) return { ok: false, error: "proof_mismatch" };
	const key = ownerKey(tx.siteOrigin, tx.siteId);
	const existing = owners.get(key);
	if (existing && existing !== account) return { ok: false, error: "ownership_conflict" };
	tx.approved = true;
	tx.account = account;
	owners.set(key, account);
	return { ok: true, fixture: "synthetic_website_consent" };
}

async function websiteToken(requestBody) {
	const tx = transactions.get(requestBody.connection_id);
	if (!tx || requestBody.client_id !== CLIENT) return Response.json({ error: "invalid_grant" }, { status: 400 });
	if (tx.expiresAt <= Date.now()) return Response.json({ error: "expired_token" }, { status: 400 });
	if (s256(requestBody.code_verifier) !== tx.codeChallenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
	if (!tx.approved) return Response.json({ error: "authorization_pending", interval: 1 }, { status: 400 });
	if (tx.consumed) return Response.json({ error: "already_redeemed" }, { status: 400 });
	tx.consumed = true;
	const token = await new SignJWT({ scope: "inventory:admin", site_id: tx.siteId }).setProtectedHeader({ alg: "ES256" }).setIssuer(WEBSITE).setAudience("inventory").setSubject(tx.account).setIssuedAt().setExpirationTime("10m").sign(keys.privateKey);
	issuedTokens.set(tx.connectionId, true);
	return Response.json({ access_token: token, token_type: "Bearer", expires_in: 600, site_id: tx.siteId });
}

async function transport(url, init) {
	const request = new Request(url, init);
	const target = new URL(request.url);
	transportEvents.push({ path: target.pathname, origin: target.hostname });
	if (target.origin === "https://inventory.dinkuskit.invalid") {
		const response = await service.dispatchFetch(request.url, { method: request.method, headers: request.headers, body: request.method === "POST" ? await request.text() : undefined });
		transportEvents.push({ path: target.pathname, status: response.status });
		if (loseConnectResponse && target.pathname === "/v1/connect") { loseConnectResponse = false; throw new Error("Synthetic lost response after service commit"); }
		return response;
	}
	if (target.origin !== WEBSITE) throw new Error("Undeclared proof origin");
	if (accountUnavailable) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
	const body = request.headers.get("content-type")?.includes("application/json") ? JSON.parse(await request.text()) : Object.fromEntries(new URLSearchParams(await request.text()));
	if (target.pathname === "/api/store-connections") {
		if (concurrentStartHold) {
			const arrival = ++concurrentStartArrivals;
			if (arrival === 1) {
				resolveFirstWebsiteStart?.();
				await concurrentStartHold;
			} else if (arrival === 2) {
				resolveSecondWebsiteStart?.();
			}
		}
		return websiteStart(body);
	}
	if (target.pathname === "/api/store-connections/token") {
		const response = await websiteToken(body);
		if (loseTokenResponse && response.ok) { loseTokenResponse = false; throw new Error("Synthetic lost token response after website redeem"); }
		return response;
	}
	return new Response("Not Found", { status: 404 });
}

const manifest = JSON.parse(await readFile(resolve(root, "plugins/emdash-inventory/dist/manifest.json"), "utf8"));
const code = await readFile(resolve(root, "plugins/emdash-inventory/dist/plugin.mjs"), "utf8");
let runner;
const runtime = await EmDashRuntime.create({ config: { database: sqlite({ url: ":memory:" }) }, plugins: [], createDialect, createStorage: null, sandboxEnabled: true,
	sandboxedPluginEntries: [{ ...manifest, options: {}, code, adminPages: manifest.admin.pages, settingsSchema: manifest.admin.settingsSchema }],
	createSandboxRunner: options => { runner = new WorkerdSandboxRunner({ ...options, httpFetch: transport }); return runner; },
	siteInfo: { name: "Inventory proof site", url: SITE_A, locale: "en" },
});
assert.ok(runner.isAvailable(), "Actual workerd sandbox is available");
const adminA = { id: "proof-admin", email: "admin@example.invalid", name: "Fixture administrator", role: 50, createdAt: new Date().toISOString() };
const adminB = { id: "other-admin", email: "other@example.invalid", name: "Other administrator", role: 50, createdAt: new Date().toISOString() };
const editor = { id: "editor-user", email: "editor@example.invalid", name: "Editor", role: 40, createdAt: new Date().toISOString() };
const traces = [];
function sanitize(value) {
	const text = JSON.stringify(value);
	assert.doesNotMatch(text, /access_token|code_verifier|codeVerifier|privateKey|BEGIN [A-Z]+ PRIVATE KEY/);
	return value;
}
async function invoke(input, override = {}) {
	const user = override.user === undefined ? adminA : override.user;
	const { user: _ignored, ...rest } = override;
	const response = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", user, request: new Request(`${SITE_A}/_emdash/api/plugins/dinkus-inventory/admin`, { method: "POST", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify(input) }), ...rest });
	if (!response.ok) { const body = await response.json(); throw new Error(`Host dispatch failed: ${response.status} ${JSON.stringify(body)}`); }
	const body = await response.json();
	const blocks = body.data ?? body;
	assert.equal(validateBlockResponse(blocks, { pluginPagePaths: ["/inventory"] }).valid, true, "Real host-renderable Block Kit response");
	traces.push(sanitize({ interaction: input.type === "form_submit" ? { type: input.type, action_id: input.action_id } : input, response: blocks }));
	return blocks;
}
const load = (override) => invoke({ type: "page_load", page: "/inventory" }, override);
const action = (action_id, override) => invoke({ type: "block_action", action_id }, override);
const submit = (action_id, values) => invoke({ type: "form_submit", action_id, values });
async function reinstall() {
	await runtime.db.deleteFrom("_plugin_storage").where("plugin_id", "=", manifest.id).execute();
	await runtime.db.deleteFrom("options").where("name", "=", `plugin:${manifest.id}:settings:connectionSession`).execute();
}
function latestConnection() { return [...transactions.values()].at(-1); }
async function signIn(account = fixtureAccount) {
	const started = await action("connect");
	assert.match(JSON.stringify(started), /Approve this site/, "Store-control challenge starts inside sandbox");
	const tx = latestConnection();
	assert.ok(tx, "Website simulation created a connection");
	const approved = await websiteApprove(runtime, manifest.id, tx.connectionId, account);
	assert.equal(approved.ok, true, approved.error);
	await new Promise(resolve => setTimeout(resolve, 1100));
	return action("check_sign_in");
}

async function automatedProof() {
	assert.match(JSON.stringify(await load()), /Connect Inventory/);
	const anonymous = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", request: new Request(`${SITE_A}/_emdash/api/plugins/dinkus-inventory/admin`, { method: "POST", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify({ type: "page_load", page: "/inventory" }) }) });
	assert.equal(anonymous.status, 401);
	const noCsrf = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", user: adminA, request: new Request(`${SITE_A}/_emdash/api/plugins/dinkus-inventory/admin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "page_load", page: "/inventory" }) }) });
	assert.equal(noCsrf.status, 403);
	const editorDenied = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", user: editor, request: new Request(`${SITE_A}/_emdash/api/plugins/dinkus-inventory/admin`, { method: "POST", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify({ type: "page_load", page: "/inventory" }) }) });
	assert.equal(editorDenied.status, 403);
	const missingProof = await fetchPublicProof(runtime, manifest.id, "missing");
	assert.equal(missingProof.status, 404);

	assert.match(JSON.stringify(await signIn()), /Name your first stock location/);
	const firstTx = [...transactions.values()][0];
	const liveProof = await fetchPublicProof(runtime, manifest.id, firstTx.connectionId);
	assert.equal(liveProof.status, 404, "Successful exchange deletes the public proof");

	loseConnectResponse = true;
	assert.match(JSON.stringify(await submit("create", { location_name: "Proof stock room" })), /could not be confirmed/);
	assert.match(JSON.stringify(await action("retry")), /Inventory connected/);
	const countAfter = transportEvents.filter(e => e.path === "/v1/connect").length;
	assert.match(JSON.stringify(await submit("create", { location_name: "Changed room" })), /Connection already started/);
	assert.equal(transportEvents.filter(e => e.path === "/v1/connect").length, countAfter);
	const firstReady = await load();

	await reinstall();
	const startedAgain = await action("connect");
	assert.match(JSON.stringify(startedAgain), /Approve this site/);
	const resumeTx = latestConnection();
	const resumed = await action("connect");
	assert.match(JSON.stringify(resumed), /Approve this site/);
	assert.equal(latestConnection().connectionId, resumeTx.connectionId, "Repeated Connect resumes the active transaction");
	const otherAdmin = await action("check_sign_in", { user: adminB });
	assert.match(JSON.stringify(otherAdmin), /originating|already started/i);
	const otherConnect = await action("connect", { user: adminB });
	assert.match(JSON.stringify(otherConnect), /already started/i);
	assert.equal(await pkceMatches("not-the-verifier-and-long-enough-to-be-plausible-xx", resumeTx.codeChallenge), false);
	const pkceTamper = await websiteToken({ client_id: CLIENT, connection_id: resumeTx.connectionId, code_verifier: "not-the-verifier-and-long-enough-to-be-plausible-xx" });
	assert.equal(pkceTamper.status, 400);
	assert.equal((await pkceTamper.json()).error, "invalid_grant");
	const proofBefore = await fetchPublicProof(runtime, manifest.id, resumeTx.connectionId);
	assert.equal(proofBefore.status, 200);
	assert.equal(proofBefore.cache, "no-store");
	assert.doesNotMatch(JSON.stringify(proofBefore.body), /code_verifier|codeVerifier|access_token|email|initiating_admin|initiatingAdmin/);
	const savedChallenge = resumeTx.challenge;
	resumeTx.challenge = "tampered-challenge";
	assert.equal((await websiteApprove(runtime, manifest.id, resumeTx.connectionId)).error, "proof_mismatch");
	resumeTx.challenge = savedChallenge;
	const savedOrigin = resumeTx.siteOrigin;
	resumeTx.siteOrigin = "https://attacker.example";
	assert.equal((await websiteApprove(runtime, manifest.id, resumeTx.connectionId)).error, "proof_mismatch");
	resumeTx.siteOrigin = savedOrigin;
	const savedCallback = resumeTx.callbackUri;
	resumeTx.callbackUri = `${SITE_A}/stolen`;
	assert.equal((await websiteApprove(runtime, manifest.id, resumeTx.connectionId)).error, "proof_mismatch");
	resumeTx.callbackUri = savedCallback;
	const savedExpiry = resumeTx.expiresAt;
	resumeTx.expiresAt = Date.now() + 3_600_000;
	assert.equal((await websiteApprove(runtime, manifest.id, resumeTx.connectionId)).error, "proof_mismatch");
	resumeTx.expiresAt = savedExpiry;
	assert.equal((await websiteApprove(runtime, manifest.id, resumeTx.connectionId, fixtureAccount)).ok, true);
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.match(JSON.stringify(await action("check_sign_in")), /existing-operation|Name your first stock location|Inventory connected/);

	await reinstall();
	const returning = await signIn();
	const selector = returning.blocks.find(block => block.block_id === "existing-operation");
	assert.equal(selector.fields[0].options.length, 1);
	const operationId = selector.fields[0].options[0].value;
	assert.match(JSON.stringify(await submit("reconnect", { operation_id: operationId })), /Inventory connected/);

	await runtime.db.deleteFrom("options").where("name", "=", `plugin:${manifest.id}:settings:connectionSession`).execute();
	assert.match(JSON.stringify(await action("connect")), /Approve this site/);
	const hijack = latestConnection();
	assert.equal(owners.get(ownerKey(SITE_A, hijack.siteId)), "proof-account-one");
	assert.equal((await websiteApprove(runtime, manifest.id, hijack.connectionId, "proof-account-two")).error, "ownership_conflict");

	await reinstall(); fixtureAccount = "proof-account-two";
	assert.doesNotMatch(JSON.stringify(await signIn("proof-account-two")), /existing-operation/);
	const unauthorized = await submit("reconnect", { operation_id: operationId });
	assert.match(JSON.stringify(unauthorized), /Operation unavailable/);
	assert.match(JSON.stringify(await load()), /Name your first stock location/);

	const siteBOwner = ownerKey(SITE_B, "site-b");
	owners.set(siteBOwner, "proof-account-two");
	const siteBStart = websiteStart({
		client_id: CLIENT, service: "inventory", site_id: "site-b", site_origin: SITE_B,
		callback_uri: `${SITE_B}/_emdash/admin/plugins/dinkus-inventory/inventory`,
		code_challenge: s256("site-b-verifier-that-is-long-enough-xx"), code_challenge_method: "S256",
	});
	const siteBBody = await siteBStart.json();
	assert.ok(siteBBody.connection_id);
	assert.equal(owners.get(ownerKey(SITE_A, firstTx.siteId)), "proof-account-one");
	assert.equal(owners.get(siteBOwner), "proof-account-two");
	assert.notEqual(firstTx.siteId, "site-b");

	await reinstall(); fixtureAccount = "proof-account-one";
	nextExpiresIn = 1;
	await action("connect");
	const expiring = latestConnection();
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.equal((await fetchPublicProof(runtime, manifest.id, expiring.connectionId)).status, 404);
	assert.equal((await websiteApprove(runtime, manifest.id, expiring.connectionId)).error, "expired_token");
	const expiredToken = await websiteToken({ client_id: CLIENT, connection_id: expiring.connectionId, code_verifier: "unused-verifier-that-is-long-enough-xx" });
	assert.equal((await expiredToken.json()).error, "expired_token");
	const expiredRestart = await action("connect");
	const expiredRestartText = JSON.stringify(expiredRestart);
	const expiredRestartTx = latestConnection();
	if (!/Approve this site/.test(expiredRestartText) || expiredRestartTx.connectionId === expiring.connectionId) {
		const failure = {
			case: "expired_challenge_direct_connect",
			identity: "SYNTHETIC website/account transport only — not live Better Auth or hosted ownership",
			observed: expiredRestart.blocks?.map(block => ({ type: block.type, title: block.title, text: block.text, description: block.description })) ?? expiredRestart,
			expiredConnectionId: expiring.connectionId,
			latestConnectionId: expiredRestartTx?.connectionId ?? null,
			newChallenge: false,
		};
		await writeFile(resolve(run, "expired-challenge-direct-connect-failure.json"), JSON.stringify(failure, null, 2));
		assert.fail("Expired challenge must start a usable new challenge on the first direct Connect click without reinstall or poll");
	}
	assert.notEqual(expiredRestartTx.connectionId, expiring.connectionId);
	assert.equal((await fetchPublicProof(runtime, manifest.id, expiredRestartTx.connectionId)).status, 200);

	await reinstall();
	overrideExpiresAt = Date.now() + 3_600_000;
	assert.match(JSON.stringify(await action("connect")), /could not be confirmed/);
	const tooFar = latestConnection();
	assert.equal((await fetchPublicProof(runtime, manifest.id, tooFar.connectionId)).status, 404);

	await reinstall();
	concurrentStartArrivals = 0;
	const firstWebsiteStart = new Promise(resolve => { resolveFirstWebsiteStart = resolve; });
	const secondWebsiteStart = new Promise(resolve => { resolveSecondWebsiteStart = resolve; });
	let releaseHeldStart;
	concurrentStartHold = new Promise(resolve => { releaseHeldStart = resolve; });
	const firstConnect = action("connect");
	const firstArrival = await Promise.race([
		firstWebsiteStart.then(() => "held"),
		new Promise(resolve => setTimeout(() => resolve("timeout"), 4000)),
	]);
	assert.equal(firstArrival, "held", "First Connect must reach the website start gate so the sandbox race is real");
	const secondConnect = action("connect");
	const secondArrival = await Promise.race([
		secondWebsiteStart.then(() => "held"),
		new Promise(resolve => setTimeout(() => resolve("timeout"), 4000)),
	]);
	assert.equal(secondArrival, "held", "Second Connect must interleave at the website start gate");
	releaseHeldStart();
	const [firstStartResult, secondStartResult] = await Promise.all([firstConnect, secondConnect]);
	concurrentStartHold = null;
	const raced = [...transactions.values()].slice(-2);
	assert.equal(raced.length, 2);
	const racedProofs = [];
	for (const tx of raced) racedProofs.push({ connectionId: tx.connectionId, ...(await fetchPublicProof(runtime, manifest.id, tx.connectionId)) });
	const published = racedProofs.filter(proof => proof.status === 200);
	assert.equal(published.length, 1, "Only the winning concurrent start remains publishable");
	const winnerId = published[0].body.connection_id;
	const loser = raced.find(tx => tx.connectionId !== winnerId);
	assert.ok(loser);
	assert.equal((await fetchPublicProof(runtime, manifest.id, loser.connectionId)).status, 404);
	const combinedStarts = JSON.stringify(firstStartResult) + JSON.stringify(secondStartResult);
	assert.match(combinedStarts, /Approve this site/);
	assert.match(combinedStarts, new RegExp(winnerId));
	assert.match(JSON.stringify(await action("connect")), new RegExp(winnerId));
	await runtime.db.deleteFrom("options").where("name", "=", `plugin:${manifest.id}:settings:connectionSession`).execute();
	assert.equal((await fetchPublicProof(runtime, manifest.id, winnerId)).status, 404, "An orphaned receipt without its active session is never publishable");

	await reinstall();
	loseTokenResponse = true;
	await action("connect");
	const lost = latestConnection();
	assert.equal((await websiteApprove(runtime, manifest.id, lost.connectionId, fixtureAccount)).ok, true);
	await new Promise(resolve => setTimeout(resolve, 1100));
	assert.match(JSON.stringify(await action("check_sign_in")), /could not be confirmed|expired|Sign in|Approve/);
	assert.equal(lost.consumed, true, "Website simulation redeemed the one-use transaction before the lost response");

	await reinstall(); accountUnavailable = true;
	const unavailableBefore = latestConnection()?.connectionId ?? null;
	assert.match(JSON.stringify(await action("connect")), /could not be confirmed/);
	assert.equal(latestConnection()?.connectionId ?? null, unavailableBefore, "Failed website start must not publish a transaction");
	accountUnavailable = false;
	await reinstall();
	await writeFile(resolve(run, "sandbox-flow.json"), JSON.stringify({
		emdash: emdashVersion,
		runner: `@emdash-cms/sandbox-workerd@${sandboxVersion}`,
		identity: "SYNTHETIC website/account transport only — not live Better Auth or hosted ownership",
		service: "local workerd SQLite DOs",
		anonymousStatus: 401, csrfStatus: 403, editorStatus: 403,
		assertions: "store-control start, public proof, PKCE/origin/callback/challenge/expiry tamper, expired-challenge direct Connect restart, concurrent-start CAS publication, authoritative expires_at, replay, two merchants/two sites, originating admin, lost-response retry, frozen intent, reinstall, owned reconnect, foreign-account refusal",
		concurrentStart: { winnerId, loserId: loser.connectionId, published: published.length },
		firstReady, traces, transportEvents,
	}, null, 2));
	console.log(`PASS: EmDash ${emdashVersion} private route dispatch, public store-proof, real sandbox bundle, labeled website simulation, local DO provisioning, retry/reinstall/reconnect and authorization boundaries.`);
}
async function cleanup() { globalThis.fetch = originalFetch; await runtime.shutdown(); await runner.terminateAll(); await service.dispose(); await runtime.db.destroy(); }
try {
	await automatedProof();
	if (!process.argv.includes("--serve")) { await cleanup(); process.exit(0); }
	const server = await createServer({ configFile: false, root: resolve(root, "tools/hosted-onboarding-ui"), server: { port: 4329, host: "127.0.0.1", strictPort: true, fs: { allow: [root] } }, plugins: [{ name: "inventory-proof-api", configureServer(server) {
		server.middlewares.use(async (req, res, next) => {
			if (req.url?.startsWith("/_emdash/api/plugins/dinkus-inventory/store-proof")) {
				try {
					const url = new URL(req.url, SITE_A);
					const proof = await fetchPublicProof(runtime, manifest.id, url.searchParams.get("connection_id") ?? "");
					res.statusCode = proof.status; res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store"); res.end(JSON.stringify(proof.body));
				} catch { res.statusCode = 500; res.end(JSON.stringify({ error: "proof_failure" })); }
				return;
			}
			if (!req.url?.startsWith("/proof-api")) return next();
			try {
				if (req.url === "/proof-api/approve") {
					const tx = latestConnection();
					const approved = tx ? await websiteApprove(runtime, manifest.id, tx.connectionId) : { ok: false, error: "no_transaction" };
					res.end(JSON.stringify({ fixture: "synthetic_website_consent", ...approved }));
					return;
				}
				let text = ""; for await (const chunk of req) text += chunk;
				const response = await invoke(text ? JSON.parse(text) : { type: "page_load", page: "/inventory" });
				res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(response));
			} catch { res.statusCode = 500; res.end(JSON.stringify({ error: "proof_failure" })); }
		});
	} }] });
	await server.listen();
	console.log("Visible fixture: http://127.0.0.1:4329 — actual BlockRenderer and sandbox dispatcher.");
	console.log("SYNTHETIC website/account transport only. Not live Better Auth, Registry, or hosted ownership.");
	for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await server.close(); await cleanup(); process.exit(0); });
} catch (error) { await cleanup(); throw error; }
