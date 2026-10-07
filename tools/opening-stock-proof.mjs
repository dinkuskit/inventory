import { installedProofVersions } from "./emdash-proof-versions.mjs";
// Local dispatcher/workerd opening-stock proof; synthetic auth, identity only, no seeded balance.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { EmDashRuntime, dispatchPluginApiRequest } from "emdash/internal/plugin-test-runtime";
import { createSettingsAccess, OptionsRepository } from "emdash";
import { sqlite } from "emdash/db";
import { WorkerdSandboxRunner } from "@emdash-cms/sandbox-workerd";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createDialect } from "emdash/db/sqlite";
import { build } from "esbuild";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { installInventoryProofTransport, inventoryProofFetch } from "./emdash-proof-sandbox.mjs";

const PROOF_SERVICE_ORIGIN = "https://dinkuskit.com";

const root = process.cwd();
const proofDir = resolve(root, process.env.EMDASH_OPENING_PROOF_RUN_DIR ?? ".grilltrack/work/merchant-setup-20261006/runtime");
const { emdash: emdashVersion, sandbox: sandboxVersion } = installedProofVersions();
await mkdir(proofDir, { recursive: true });

process.env.EMDASH_ENCRYPTION_KEY = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;

// Generate synthetic signing keys for JWT account authentication
const keys = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "ES256" };

const principal = {
	accountId: "proof-persist-acct",
	siteId: "proof-persist-site",
};

const serviceToken = await new SignJWT({
	scope: "inventory:admin",
	site_id: principal.siteId,
})
	.setProtectedHeader({ alg: "ES256" })
	.setIssuer("https://accounts.dinkuskit.invalid")
	.setAudience("inventory")
	.setSubject(principal.accountId)
	.setIssuedAt()
	.setExpirationTime("24h")
	.sign(keys.privateKey);

// Compile the hosted worker
const compiled = await build({
	entryPoints: [resolve(root, "tools/opening-stock-proof-worker.ts")],
	bundle: true,
	format: "esm",
	platform: "browser",
	external: ["cloudflare:workers"],
	write: false,
});
const workerScript = compiled.outputFiles[0].text;

// Setup synthetic test service (Miniflare Durable Object)
function createProofService() {
return new Miniflare(
	convertV4MiniflareOptions({
		modules: true,
		script: workerScript,
		compatibilityDate: "2026-08-28",
        resourcePersistencePath: resolve(proofDir, "canonical-storage"),
		bindings: { PROOF_JWKS: JSON.stringify({ keys: [publicJwk] }) },
		durableObjects: {
			INVENTORY_POOLS: { className: "InventoryPool", useSQLite: true },
			INVENTORY_ACCOUNTS: { className: "InventoryAccount", useSQLite: true },
		},
	})
);
}
let mf = createProofService();

let dropNextConfirmResponse = false;
let confirmTransportCalls = 0;
let originalConfirmEnvelope = null;
let originalConfirmResult = null;

const originalFetch = globalThis.fetch;

async function transport(url, init) {
	const request = new Request(url, init);
	const target = new URL(request.url);
	if (target.origin === PROOF_SERVICE_ORIGIN) {
		const requestBody = request.method === "POST" ? await request.text() : undefined;
		if (target.pathname === "/v1/stock/opening/confirm") {
			confirmTransportCalls++;
			if (originalConfirmEnvelope === null) originalConfirmEnvelope = requestBody;
		}
		const res = await mf.dispatchFetch(`https://inventory.dinkuskit.invalid${target.pathname}${target.search}`, {
			method: request.method,
			headers: request.headers,
			body: requestBody,
		});
		console.log(`Synthetic service ${request.method} ${target.pathname}: HTTP ${res.status}`);
		if (target.pathname === "/v1/stock/opening/confirm" && originalConfirmResult === null) {
			originalConfirmResult = await res.clone().json();
		}
		if (dropNextConfirmResponse && target.pathname === "/v1/stock/opening/confirm") {
			dropNextConfirmResponse = false;
			// Network transport loss AFTER real service commit
			throw new TypeError("fetch failed: lost acknowledgement at transport");
		}
		return res;
	}
	return originalFetch(url, init);
}

// 1. Inspect package and manifest
const tarballPath = resolve(root, process.env.EMDASH_PROOF_TARBALL ?? "plugins/emdash-inventory/dist/dinkus-inventory-0.0.0.tar.gz");
const tarballBytes = await readFile(tarballPath);
const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");
console.log(`Plugin tarball: ${tarballPath}`);
console.log(`Tarball SHA-256: ${tarballSha256}`);

const manifest = JSON.parse(await readFile(resolve(root, "plugins/emdash-inventory/dist/manifest.json"), "utf8"));
const code = await readFile(resolve(root, "plugins/emdash-inventory/dist/plugin.mjs"), "utf8");
// Explicit component-only authority variant. Standard host/DNS/SSRF checks
// remain before the finite transport; production package bytes are unchanged.
const authorityAnchor = "https://inventory.dinkuskit.invalid";
if (code.split(authorityAnchor).length !== 2) throw new Error("Proof authority anchor differs");
const proofCode = code.replace(authorityAnchor, PROOF_SERVICE_ORIGIN);
const proofManifest = { ...manifest, allowedHosts: manifest.allowedHosts.map(host => host === "inventory.dinkuskit.invalid" ? "dinkuskit.com" : host) };
const uninstallProofTransport = installInventoryProofTransport(transport);

let runner;
const runtime = await EmDashRuntime.create({
	config: { database: sqlite({ url: ":memory:" }) },
	plugins: [],
	createDialect,
	createStorage: null,
	sandboxEnabled: true,
	sandboxedPluginEntries: [
		{
			...proofManifest,
			options: {},
			code: proofCode,
			adminPages: manifest.admin.pages,
			settingsSchema: manifest.admin.settingsSchema,
		},
	],
	createSandboxRunner: (options) => {
		runner = new WorkerdSandboxRunner({ ...options, httpFetch: inventoryProofFetch });
		return runner;
	},
});

console.log("EmDash test runtime initialized with sandboxed plugin");

globalThis.fetch = transport;

const adminUser = {
	id: "usr_proof_admin",
	email: "admin@emdash.local",
	name: "Proof Admin",
	role: 50,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
};

async function dispatchAdmin(body, user = adminUser) {
	const req = new Request("http://localhost:4321/_emdash/api/plugins/dinkus-inventory/admin", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify(body),
	});
	const res = await dispatchPluginApiRequest({
		runtime,
		pluginId: "dinkus-inventory",
		path: "admin",
		user,
		tokenScopes: ["admin", "plugins:manage"],
		request: req,
	});
	if (!res.ok) throw new Error(`Installed admin dispatch failed: HTTP ${res.status}`);
	return res.json();
}

async function intentFingerprint() {
	const row = await runtime.db.selectFrom("_plugin_storage").select(["data", "revision"])
		.where("plugin_id", "=", "dinkus-inventory").where("collection", "=", "__kv")
		.where("id", "=", "state:opening-balance-intent").executeTakeFirst();
	if (!row) throw new Error("Actual adjustment intent missing at proof boundary");
	// Hash the transaction state in memory; never log or persist its confirmation.
	return { revision: row.revision, sha256: createHash("sha256").update(row.data).digest("hex") };
}

async function canonicalSnapshot(locationId, skuId) {
	const headers = { Authorization: `Bearer ${serviceToken}`, "X-Inventory-Site": principal.siteId };
	const stock = await mf.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/stock?sku_id=${skuId}&location_id=${locationId}`, { headers });
	const receipts = await mf.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/receipts?location_id=${locationId}`, { headers });
	if (!stock.ok || !receipts.ok) throw new Error("Canonical proof state read failed");
	const balance = (await stock.json()).balance?.balance;
	const history = await receipts.json();
	if (!Array.isArray(history.receipts)) throw new Error("Canonical proof state shape invalid");
	return { balance: balance ?? null, receiptIds: history.receipts.map(receipt => receipt.receiptId), receiptHash: createHash("sha256").update(JSON.stringify(history)).digest("hex") };
}

function unchanged(before, after, label) {
	if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`${label} changed unexpectedly`);
}

const blocksOf = response => response.data?.blocks ?? response.blocks ?? [];
const headers = { Authorization: `Bearer ${serviceToken}`, 'X-Inventory-Site': principal.siteId, 'Content-Type': 'application/json' };
const proof = { qualification: 'published_dispatcher_workerd_component_with_synthetic_auth_and_local_authority_variant', emdash: emdashVersion, sandboxRunner: `@emdash-cms/sandbox-workerd@${sandboxVersion}`, openingSeeded: false, registryTransport: false, hostedIssuance: false, checkpoints: {} };
try {
 const connected = await mf.dispatchFetch('https://inventory.dinkuskit.invalid/v1/connect', { method: 'POST', headers, body: JSON.stringify({ type: 'create', requestId: 'req_opening_component', locationName: 'Synthetic Opening Depot' }) });
 const { operation } = await connected.json();
 if (!operation?.locationId) throw new Error('Synthetic connect failed');
 const poolId = operation.poolId, locationId = operation.locationId, skuId = 'sku_opening_component';
 const ns = await mf.getDurableObjectNamespace('INVENTORY_POOLS');
 const registration = await ns.get(ns.idFromName(poolId)).registerSyntheticIdentity(poolId, principal.siteId, skuId);
 if (registration.outcome !== 'registered') throw new Error('Identity-only registration failed');
 const settings = createSettingsAccess(new OptionsRepository(runtime.db), 'dinkus-inventory', manifest.admin.settingsSchema);
 await settings.set('connectionSession', JSON.stringify({ phase: 'token', token: serviceToken, expiresAt: Date.now() + 86400000 }));
 const stamp = new Date().toISOString();
 await runtime.db.insertInto('_plugin_storage').values(Object.entries({ 'state:site-id': principal.siteId, 'state:selected-location': locationId, 'state:selected-sku': skuId }).map(([id, value]) => ({ plugin_id: 'dinkus-inventory', collection: '__kv', id, data: JSON.stringify(value), revision: crypto.randomUUID(), created_at: stamp, updated_at: stamp }))).execute();
 const initial = await canonicalSnapshot(locationId, skuId);
 if (initial.balance !== null) throw new Error('Proof must begin without seeded stock');
 const first = blocksOf(await dispatchAdmin({ type: 'page_load', page: '/inventory' }));
 if (!JSON.stringify(first).includes('preview_opening_balance')) await writeFile(resolve(proofDir, "initial-block-summary.json"), JSON.stringify(first.map(b => ({ type: b.type, title: b.title, block_id: b.block_id })), null, 2));
 if (!JSON.stringify(first).includes('preview_opening_balance')) throw new Error(`Actual sandbox did not offer initial stock (${first.length} blocks)`);
 proof.checkpoints.initial = first;
 const previewBlocks = blocksOf(await dispatchAdmin({ type: 'form_submit', action_id: 'preview_opening_balance', values: { location_id: locationId, sku_id: skuId, quantity_value: '7' } }));
 const commandId = previewBlocks.find(b => b.type === 'actions')?.elements.find(e => e.action_id === 'confirm_opening_balance')?.value;
 if (typeof commandId !== 'string') throw new Error('Actual opening preview failed');
 unchanged(initial, await canonicalSnapshot(locationId, skuId), 'Preview balance and receipts');
 proof.checkpoints.preview = previewBlocks;
 const frozenPreview = await intentFingerprint();
 const foreign = { ...adminUser, id: 'usr_foreign_proof' };
 for (const action of ['confirm_opening_balance', 'retry_opening_balance', 'cancel_opening_balance', 'clear_opening_balance_result']) await dispatchAdmin({ type: 'block_action', action_id: action, value: commandId }, foreign);
 unchanged(frozenPreview, await intentFingerprint(), 'Foreign-admin frozen preview');
 if (confirmTransportCalls !== 0) throw new Error('Foreign administrator sent a mutation');
 dropNextConfirmResponse = true;
 const lost = blocksOf(await dispatchAdmin({ type: 'block_action', action_id: 'confirm_opening_balance', value: commandId }));
 if (!JSON.stringify(lost).includes('retry_opening_balance')) throw new Error('Lost acknowledgement did not remain pending');
 proof.checkpoints.pending = lost;
 const pending = await intentFingerprint();
 const reload = blocksOf(await dispatchAdmin({ type: 'page_load', page: '/inventory' }));
 if (!JSON.stringify(reload).includes('retry_opening_balance')) throw new Error('Reload lost pending intent');
 unchanged(pending, await intentFingerprint(), 'Reload original command');
 const committedOnce = await canonicalSnapshot(locationId, skuId);
 if (committedOnce.balance?.onHand.value !== '7' || committedOnce.balance.version !== '1') throw new Error('Canonical opening did not commit once');
 for (const action of ['confirm_opening_balance', 'retry_opening_balance', 'cancel_opening_balance', 'clear_opening_balance_result']) await dispatchAdmin({ type: 'block_action', action_id: action, value: commandId }, foreign);
 if (confirmTransportCalls !== 1) throw new Error('Foreign admin sent pending mutation');
 unchanged(pending, await intentFingerprint(), 'Foreign-admin pending intent');
 const resolved = blocksOf(await dispatchAdmin({ type: 'block_action', action_id: 'retry_opening_balance', value: commandId }));
 if (!JSON.stringify(resolved).includes('Initial stock committed')) throw new Error('Exact retry did not resolve original outcome');
 proof.checkpoints.committed = resolved;
 unchanged(committedOnce, await canonicalSnapshot(locationId, skuId), 'Retry canonical receipt and stock');
 const replay = await mf.dispatchFetch('https://inventory.dinkuskit.invalid/v1/stock/opening/confirm', { method: 'POST', headers, body: originalConfirmEnvelope });
 const replayResult = await replay.json();
 if (JSON.stringify(replayResult) !== JSON.stringify(originalConfirmResult)) throw new Error('Replay did not return original immutable receipt');
 await dispatchAdmin({ type: 'block_action', action_id: 'clear_opening_balance_result', value: commandId });
 const after = blocksOf(await dispatchAdmin({ type: 'page_load', page: '/inventory' }));
 if (JSON.stringify(after).includes('preview_opening_balance') || !JSON.stringify(after).includes('preview_adjustment')) throw new Error('History-bearing balance must use adjustment');
 proof.checkpoints.stock = after;
 await mf.dispose(); mf = createProofService();
 unchanged(committedOnce, await canonicalSnapshot(locationId, skuId), 'Canonical service restart stock and receipts');
 const replayAfterRestart = await mf.dispatchFetch('https://inventory.dinkuskit.invalid/v1/stock/opening/confirm', { method: 'POST', headers, body: originalConfirmEnvelope });
 unchanged(replayResult, await replayAfterRestart.json(), 'Restart original-envelope replay');
 proof.canonicalRestartSameReceipt = true;
 proof.poolId = poolId; proof.locationId = locationId; proof.skuId = skuId;
 proof.balance = committedOnce.balance; proof.receiptId = replayResult.receipt.receiptId;
 proof.exactReplay = true; proof.previewNoMovement = true; proof.foreignAdminMutationCalls = 0; proof.lostAckReloadOriginalIntent = true;
 proof.bundle = { sha256: tarballSha256, bytes: tarballBytes.length, originalCodeSha256: createHash('sha256').update(code).digest('hex'), runningCodeSha256: createHash('sha256').update(proofCode).digest('hex') };
 console.log('PASS: no seeded balance; preview no movement; foreign admin zero sends; lost-ack/reload/exact retry one opening receipt; adjustment after history.');
 await writeFile(resolve(proofDir, "package.tar.gz"), tarballBytes);
 await writeFile(resolve(proofDir, 'verification.json'), JSON.stringify(proof, null, 2));
} finally {
 globalThis.fetch = originalFetch; uninstallProofTransport();
 try { await runtime.shutdown(); await runner.terminateAll(); } finally { await mf.dispose(); await runtime.db.destroy(); }
 console.log('PASS: owned dispatcher and canonical service shut down normally.');
}
