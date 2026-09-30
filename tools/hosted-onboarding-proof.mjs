import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

const root = fileURLToPath(new URL("../", import.meta.url));
const run = resolve(root, ".grilltrack/work/hosted-onboarding");
await mkdir(run, { recursive: true });
// Fresh in-memory test-host encryption material. Never reads, prints or writes credentials.
process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;
const keys = await generateKeyPair("ES256");
const publicJwk = { ...await exportJWK(keys.publicKey), alg: "ES256" };
const compiled = await build({ entryPoints: [resolve(root, "tools/hosted-onboarding-proof-worker.ts")], bundle: true, format: "esm", platform: "browser", external: ["cloudflare:workers"], write: false });
const service = new Miniflare(convertV4MiniflareOptions({ modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2026-08-28", bindings: { PROOF_JWKS: JSON.stringify({ keys: [publicJwk] }) }, durableObjects: { INVENTORY_POOLS: { className: "InventoryPool", useSQLite: true }, INVENTORY_ACCOUNTS: { className: "InventoryAccount", useSQLite: true } } }));
const grants = new Map();
// The host's SSRF guard still validates every address and allowed host. Reserved
// proof names get synthetic public DNS answers; transport remains entirely local.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
	const target = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
	if (target.hostname === "cloudflare-dns.com" && ["inventory.dinkuskit.invalid", "accounts.dinkuskit.invalid"].includes(target.searchParams.get("name"))) {
		return Response.json({ Status: 0, Answer: target.searchParams.get("type") === "A" ? [{ type: 1, data: "93.184.216.34" }] : [] });
	}
	return originalFetch(url, init);
};
let fixtureAccount = "proof-account-one";
let loseConnectResponse = false;
let accountUnavailable = false;
const transportEvents = [];
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
	if (target.origin !== "https://accounts.dinkuskit.invalid") throw new Error("Undeclared proof origin");
	if (accountUnavailable) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
	const form = new URLSearchParams(await request.text());
	if (target.pathname === "/oauth/device_authorization") {
		const deviceCode = crypto.randomUUID(), userCode = randomBytes(4).toString("hex").toUpperCase();
		grants.set(deviceCode, { siteId: form.get("site_id"), userCode, approved: false, account: null });
		return Response.json({ device_code: deviceCode, user_code: userCode, verification_uri: "https://accounts.dinkuskit.invalid/activate", expires_in: 600, interval: 1 });
	}
	if (target.pathname === "/oauth/token") {
		const grant = grants.get(form.get("device_code"));
		if (!grant) return Response.json({ error: "invalid_grant" }, { status: 400 });
		if (!grant.approved) return Response.json({ error: "authorization_pending" }, { status: 400 });
		grants.delete(form.get("device_code"));
		const token = await new SignJWT({ scope: "inventory:admin", site_id: grant.siteId }).setProtectedHeader({ alg: "ES256" }).setIssuer("https://accounts.dinkuskit.invalid").setAudience("inventory").setSubject(grant.account).setIssuedAt().setExpirationTime("10m").sign(keys.privateKey);
		return Response.json({ access_token: token, token_type: "Bearer", expires_in: 600 });
	}
	return new Response("Not Found", { status: 404 });
}
function approve() { for (const grant of grants.values()) { grant.approved = true; grant.account = fixtureAccount; } }
const manifest = JSON.parse(await readFile(resolve(root, "plugins/emdash-inventory/dist/manifest.json"), "utf8"));
const code = await readFile(resolve(root, "plugins/emdash-inventory/dist/plugin.mjs"), "utf8");
let runner;
const runtime = await EmDashRuntime.create({ config: { database: sqlite({ url: ":memory:" }) }, plugins: [], createDialect, createStorage: null, sandboxEnabled: true,
	sandboxedPluginEntries: [{ ...manifest, options: {}, code, adminPages: manifest.admin.pages, settingsSchema: manifest.admin.settingsSchema }],
	createSandboxRunner: options => { runner = new WorkerdSandboxRunner({ ...options, httpFetch: transport }); return runner; },
	siteInfo: { name: "Inventory proof site", url: "http://localhost:4329", locale: "en" },
});
assert.ok(runner.isAvailable(), "Actual workerd sandbox is available");
const user = { id: "proof-admin", email: "admin@example.invalid", name: "Fixture administrator", role: 50, createdAt: new Date().toISOString() };
const traces = [];
async function invoke(input, override = {}) {
	const response = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", user, request: new Request("http://localhost:4329/_emdash/api/plugins/dinkus-inventory/admin", { method: "POST", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify(input) }), ...override });
	if (!response.ok) { const body = await response.json(); throw new Error(`Host dispatch failed: ${response.status} ${JSON.stringify(body)}`); }
	const body = await response.json();
	const blocks = body.data ?? body;
	assert.equal(validateBlockResponse(blocks, { pluginPagePaths: ["/inventory"] }).valid, true, "Real host-renderable Block Kit response");
	// Block responses contain only public UI state, never access/device tokens.
	traces.push({ interaction: input.type === "form_submit" ? { type: input.type, action_id: input.action_id } : input, response: blocks });
	return blocks;
}
const load = () => invoke({ type: "page_load", page: "/inventory" });
const action = action_id => invoke({ type: "block_action", action_id });
const submit = (action_id, values) => invoke({ type: "form_submit", action_id, values });
async function reinstall() {
	// Disposable in-memory test site only: model plugin state lost on reinstall.
	await runtime.db.deleteFrom("_plugin_storage").where("plugin_id", "=", manifest.id).execute();
	await runtime.db.deleteFrom("options").where("name", "=", `plugin:${manifest.id}:settings:connectionSession`).execute();
}
async function signIn() {
	const started = await action("connect"); assert.match(JSON.stringify(started), /enter code/, "Device grant starts inside sandbox"); approve();
	await new Promise(resolve => setTimeout(resolve, 1100));
	return action("check_sign_in");
}
async function automatedProof() {
	assert.match(JSON.stringify(await load()), /Connect Inventory/);
	const anonymous = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", request: new Request("http://localhost:4329/_emdash/api/plugins/dinkus-inventory/admin", { method: "POST", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify({ type: "page_load", page: "/inventory" }) }) });
	assert.equal(anonymous.status, 401);
	const noCsrf = await dispatchPluginApiRequest({ runtime, pluginId: manifest.id, path: "admin", user, request: new Request("http://localhost:4329/_emdash/api/plugins/dinkus-inventory/admin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "page_load", page: "/inventory" }) }) });
	assert.equal(noCsrf.status, 403);
	assert.match(JSON.stringify(await signIn()), /Name your first stock location/);
	loseConnectResponse = true;
	assert.match(JSON.stringify(await submit("create", { location_name: "Proof stock room" })), /could not be confirmed/);
	assert.match(JSON.stringify(await action("retry")), /Inventory connected/);
	const countAfter = transportEvents.filter(e => e.path === "/v1/connect").length;
	assert.match(JSON.stringify(await submit("create", { location_name: "Changed room" })), /Connection already started/);
	assert.equal(transportEvents.filter(e => e.path === "/v1/connect").length, countAfter);
	const firstReady = await load();
	await reinstall();
	const returning = await signIn();
	const selector = returning.blocks.find(block => block.block_id === "existing-operation");
	assert.equal(selector.fields[0].options.length, 1);
	const operationId = selector.fields[0].options[0].value;
	assert.match(JSON.stringify(await submit("reconnect", { operation_id: operationId })), /Inventory connected/);
	await reinstall(); fixtureAccount = "proof-account-two";
	assert.doesNotMatch(JSON.stringify(await signIn()), /existing-operation/);
	const unauthorized = await submit("reconnect", { operation_id: operationId });
	assert.match(JSON.stringify(unauthorized), /Operation unavailable/);
	assert.match(JSON.stringify(await load()), /Name your first stock location/);
	await reinstall(); fixtureAccount = "proof-account-one"; accountUnavailable = true;
	assert.match(JSON.stringify(await action("connect")), /could not be confirmed/);
	accountUnavailable = false;
	await reinstall();
	await writeFile(resolve(run, "sandbox-flow.json"), JSON.stringify({ emdash: "1.0.1", runner: "@emdash-cms/sandbox-workerd@0.9.1", identity: "synthetic OAuth fixture only", service: "local workerd SQLite DOs", anonymousStatus: 401, csrfStatus: 403, assertions: "first connection, lost-response retry, frozen intent, reinstall selection, owned reconnect, foreign-account refusal, account service failure", firstReady, traces, transportEvents }, null, 2));
	console.log("PASS: EmDash 1.0.1 private route dispatch, real sandbox bundle, local DO provisioning, retry/reinstall/reconnect and authorization boundaries.");
}
async function cleanup() { globalThis.fetch = originalFetch; await runtime.shutdown(); await runner.terminateAll(); await service.dispose(); await runtime.db.destroy(); }
try {
	await automatedProof();
	if (!process.argv.includes("--serve")) { await cleanup(); process.exit(0); }
	const server = await createServer({ configFile: false, root: resolve(root, "tools/hosted-onboarding-ui"), server: { port: 4329, host: "127.0.0.1", strictPort: true, fs: { allow: [root] } }, plugins: [{ name: "inventory-proof-api", configureServer(server) {
		server.middlewares.use(async (req, res, next) => {
			if (!req.url?.startsWith("/proof-api")) return next();
			try {
				if (req.url === "/proof-api/approve") { approve(); res.end(JSON.stringify({ fixture: "approved" })); return; }
				let text = ""; for await (const chunk of req) text += chunk;
				const response = await invoke(text ? JSON.parse(text) : { type: "page_load", page: "/inventory" });
				res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(response));
			} catch { res.statusCode = 500; res.end(JSON.stringify({ error: "proof_failure" })); }
		});
	} }] });
	await server.listen();
	console.log("Visible fixture: http://127.0.0.1:4329 — actual BlockRenderer and sandbox dispatcher; synthetic sign-in, local service.");
	for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await server.close(); await cleanup(); process.exit(0); });
} catch (error) { await cleanup(); throw error; }
