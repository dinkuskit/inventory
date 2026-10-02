// Clean-install host. The Astro server is the pinned EmDash build. This process
// only adds the synthetic inventory service and the proof control routes.
// connectionSession is written through PUT /_emdash/api/admin/plugins/:id/settings.
// Selection is not inserted here; the plugin's ctx.kv path owns it.

import http from "node:http";
import { resolve } from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { exportJWK, generateKeyPair, importJWK, SignJWT } from "jose";
import { DatabaseSync } from "node:sqlite";
import { resolveEmdashDatabasePath } from "./emdash-database-path.mjs";
import { ensureSyntheticAdmin, PLUGIN_ID } from "./emdash-clean-install-seed.mjs";
import { CLEAN_INSTALL_HOST_PORT } from "./emdash-clean-install-ports.mjs";

const SETTINGS_PATH = `/_emdash/api/admin/plugins/${PLUGIN_ID}/settings`;

export function redactProofText(text) {
	return String(text)
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/ec_pat_[A-Za-z0-9_-]+/g, "ec_pat_[redacted]")
		.replace(/emdash_enc_v1_[A-Za-z0-9_-]+/g, "emdash_enc_v1_[redacted]")
		.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]");
}

function publicSettingsError(status, parsed) {
	const code = typeof parsed?.error?.code === "string" ? parsed.error.code : "settings_update_failed";
	const message = typeof parsed?.error?.message === "string" ? parsed.error.message.slice(0, 240) : "";
	return `settings_put status=${status} code=${code} message=${message}`;
}

export async function startCleanInstallHost({ siteDir, repoRoot, proofTransport = false, merchantConnect = false, merchantPeer = false }) {
	if (merchantPeer && (!merchantConnect || !proofTransport)) throw new Error("Merchant peer requires the explicit merchant test variant");
	const monorepoRoot = repoRoot || resolve(siteDir, "../../../../../");
	const doPersistDir = process.env.DO_PERSISTENCE_DIR || resolve(siteDir, "do-persistence");
	const { path: dbPath, configuredUrl: emdashDatabaseUrl } = resolveEmdashDatabasePath(siteDir);
	const preservedDatabases = new Set([
		resolve(siteDir, "data.db"),
		resolve(siteDir, "emdash.db"),
		resolve(siteDir, "grok-proof-state/data.db"),
		resolve(monorepoRoot, "data.db"),
		resolve(monorepoRoot, "runs/emdash-install-proof-runs/20260930/clean-site/data.db"),
		resolve(monorepoRoot, "runs/emdash-install-proof-runs/20260930/clean-site/emdash.db"),
		resolve(monorepoRoot, "runs/emdash-install-proof-runs/20260930/clean-site/grok-proof-state/data.db"),
		resolve(monorepoRoot, "runs/emdash-install-proof-runs/20260930/bootstrap-repair/host-state/data.db"),
	]);
	if (preservedDatabases.has(dbPath)) {
		throw new Error(`Refusing to start against preserved database ${dbPath}`);
	}

	const memorySigningJwk = process.env.EMDASH_PROOF_SIGNING_JWK;
	const keys = memorySigningJwk ? {
		privateKey: await importJWK(JSON.parse(memorySigningJwk), "ES256"),
		publicKey: await importJWK(JSON.parse(process.env.EMDASH_PROOF_PUBLIC_JWK), "ES256"),
	} : await generateKeyPair("ES256");
	const publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "ES256" };
	const principal = { accountId: "proof-admin-acct", siteId: proofTransport ? `http://127.0.0.1:${CLEAN_INSTALL_HOST_PORT}` : "site_proof_01" };

	async function mintServiceToken() {
		return new SignJWT({ scope: "inventory:admin", site_id: principal.siteId })
			.setProtectedHeader({ alg: "ES256" })
			.setIssuer("https://accounts.dinkuskit.invalid")
			.setAudience("inventory")
			.setSubject(principal.accountId)
			.setIssuedAt()
			.setExpirationTime("24h")
			.sign(keys.privateKey);
	}

	const serviceToken = merchantConnect ? null : await mintServiceToken();
	const compiled = await build({
		entryPoints: [resolve(monorepoRoot, merchantConnect ? "tools/emdash-merchant-inventory-worker.ts" : "tools/hosted-onboarding-proof-worker.ts")],
		bundle: true,
		format: "esm",
		platform: "browser",
		external: ["cloudflare:workers"],
		write: false,
	});
	const mf = new Miniflare({
		modules: true,
		script: compiled.outputFiles[0].text,
		compatibilityDate: "2026-08-06",
		durableObjectsPersist: doPersistDir,
		bindings: merchantConnect ? {} : { PROOF_JWKS: JSON.stringify({ keys: [publicJwk] }) },
		serviceBindings: merchantConnect ? { PROOF_MERCHANT_JWKS: async request => {
			if (request.url !== "https://dinkuskit.com/account/.well-known/jwks.json" || request.method !== "GET" || request.headers.has("authorization") || request.headers.has("cookie")) throw new Error("Merchant public JWKS route rejected");
			return fetch("http://127.0.0.1:47632/account/.well-known/jwks.json", { redirect: "manual", signal: AbortSignal.timeout(5000) });
		} } : {},
		durableObjects: {
			INVENTORY_POOLS: { className: "InventoryPool", useSQLite: true },
			INVENTORY_ACCOUNTS: { className: "InventoryAccount", useSQLite: true },
		},
	});

	let dropNextConfirm = false;
	const originalFetch = globalThis.fetch;
	// This override is the existing synthetic inventory.dinkuskit.invalid durable
	// object bridge. It is not a ctx.http origin/path/method construction hook.
	// Sandbox ctx.http still runs allowedHosts and SSRF checks before fetch.
	const syntheticTransport = async (input, init) => {
		const req = new Request(input, init);
		const target = new URL(req.url);
		if (target.origin === (proofTransport ? "https://dinkuskit.com" : "https://inventory.dinkuskit.invalid")) {
			const body = req.method === "POST" ? await req.text() : undefined;
			const serviceUrl = proofTransport ? `https://inventory.dinkuskit.invalid${target.pathname}${target.search}` : req.url;
			const res = await mf.dispatchFetch(serviceUrl, { method: req.method, headers: req.headers, body });
			if (proofTransport) console.log(`PROOF_SERVICE ${JSON.stringify({ path: target.pathname, method: req.method, ...(merchantConnect ? {} : { siteBindingMatches: req.headers.get("X-Inventory-Site") === principal.siteId }), status: res.status })}`);
			if (merchantConnect && res.ok && ["/v1/status", "/v1/connect"].includes(target.pathname)) {
				const result = await res.clone().json();
				const operation = result.operation;
				const siteId = req.headers.get("X-Inventory-Site");
				const publicId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
				if (operation && publicId(siteId) && publicId(operation.operationId) && publicId(operation.poolId) && (operation.locationId === null || publicId(operation.locationId)) && ["pending", "ready", "failed"].includes(operation.status)) {
					console.log(`MERCHANT_POOL_RECEIPT ${JSON.stringify({ siteId, operationId: operation.operationId, poolId: operation.poolId, locationId: operation.locationId, status: operation.status, authorization: "canonical_jwks_verified" })}`);
				}
			}
			if (dropNextConfirm && target.pathname === "/v1/stock/adjust/confirm") {
				dropNextConfirm = false;
				throw new TypeError("fetch failed: lost acknowledgement at transport");
			}
			return res;
		}
		return originalFetch(input, init);
	};
	if (proofTransport) {
		const { installInventoryProofTransport } = await import("./emdash-proof-sandbox.mjs");
		installInventoryProofTransport(syntheticTransport);
	} else globalThis.fetch = syntheticTransport;
	if (merchantPeer) {
		const { installMerchantProofTransport } = await import("./emdash-merchant-proof-sandbox.mjs");
		if (merchantPeer === "ipc") {
			const { createMerchantIpcTransport } = await import("./emdash-merchant-ipc-transport.mjs");
			installMerchantProofTransport(createMerchantIpcTransport());
		} else {
			const { createMerchantLoopbackTransport } = await import("./emdash-merchant-loopback-transport.mjs");
			installMerchantProofTransport(createMerchantLoopbackTransport());
		}
	}
	// EmDash reads JSON-encoded options when its runtime first starts. Establish
	// the synthetic public site URL before health/admin requests create it.
	if (proofTransport) {
		const db = new DatabaseSync(dbPath);
		try {
			db.prepare("INSERT INTO options (name, value, revision) VALUES ('emdash:site_url', ?, 1) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(JSON.stringify(principal.siteId));
		} finally { db.close(); }
	}
	if (merchantConnect) ensureSyntheticAdmin(dbPath, process.env.EMDASH_PROOF_ADMIN_TOKEN);

	process.env.ASTRO_NODE_AUTOSTART = "disabled";
	const { handler } = await import(resolve(siteDir, "dist/server/entry.mjs"));

	const PROOF_SKU = "sku_clean_install_widget";
	let provisionedPoolId = null;
	let provisionedLocationId = null;
	let listenPort = 0;

	async function persistConnectionSession(adminToken) {
		const origin = `http://127.0.0.1:${listenPort}`;
		const session = {
			phase: "token",
			token: serviceToken,
			expiresAt: Date.now() + 86_400_000,
		};
		const response = await fetch(`${origin}${SETTINGS_PATH}`, {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${adminToken}`,
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
			},
			body: JSON.stringify({ values: { connectionSession: JSON.stringify(session) } }),
		});
		const raw = await response.text();
		let parsed = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
		const secretsSet = parsed?.data?.secretsSet?.connectionSession === true;
		if (!response.ok || !secretsSet) throw new Error(publicSettingsError(response.status, parsed));
		return { status: response.status, path: SETTINGS_PATH, method: "PUT", secretsSet: true };
	}

	function sendJson(res, status, payload) {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(payload));
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
		if (url.pathname === "/_proof/control" && req.method === "POST") {
			let body = "";
			req.on("data", chunk => {
				body += chunk;
			});
			req.on("end", async () => {
				try {
					const data = JSON.parse(body || "{}");
					if (merchantConnect && data.action !== "audit_storage") throw new Error("Synthetic stock controls unavailable in merchant proof");
					if (data.action === "drop_next_confirm") {
						dropNextConfirm = true;
						sendJson(res, 200, { success: true, dropNextConfirm: true });
						return;
					}
					if (data.action === "get_status") {
						sendJson(res, 200, {
							success: true,
							poolId: provisionedPoolId,
							locationId: provisionedLocationId,
							skuId: PROOF_SKU,
							siteId: principal.siteId,
							pid: process.pid,
							authorization: "synthetic_host_admin_not_website_consent",
						});
						return;
					}
					if (data.action === "read_receipts") {
						const response = await mf.dispatchFetch("https://inventory.dinkuskit.invalid/v1/receipts", {
							method: "GET", headers: { Authorization: `Bearer ${serviceToken}`, "X-Inventory-Site": principal.siteId },
						});
						sendJson(res, response.status, await response.json());
						return;
					}
					if (data.action === "init_setup") {
						if (preservedDatabases.has(dbPath)) throw new Error("Refusing synthetic setup against a preserved database");
						const connectRes = await mf.dispatchFetch("https://inventory.dinkuskit.invalid/v1/connect", {
							method: "POST",
							headers: {
								Authorization: `Bearer ${serviceToken}`,
								"X-Inventory-Site": principal.siteId,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								type: "create",
								requestId: "req_clean_init_01",
								locationName: "Clean Central Depot",
							}),
						});
						const connectText = await connectRes.text();
						let connectData;
						try {
							connectData = JSON.parse(connectText);
						} catch {
							throw new Error(`v1/connect status=${connectRes.status}`);
						}
						if (!connectData.operation) throw new Error(`v1/connect status=${connectRes.status} missing operation`);
						provisionedPoolId = connectData.operation.poolId;
						provisionedLocationId = connectData.operation.locationId;
						const poolNs = await mf.getDurableObjectNamespace("INVENTORY_POOLS");
						const poolStub = poolNs.get(poolNs.idFromName(provisionedPoolId));
						await poolStub.seedOpeningBalance(
							{
								schema: "dinkuskit.inventory.command/v1",
								commandId: "cmd_seed_clean_001",
								type: "stock.opening_balance",
								context: { siteId: principal.siteId, poolId: provisionedPoolId, locationId: provisionedLocationId },
								payload: { skuId: PROOF_SKU, quantity: { value: "10", unit: "each" } },
								reason: { code: "opening_balance", note: "Clean install proof initial balance" },
								references: [],
								expectedVersions: [{ skuId: PROOF_SKU, locationId: provisionedLocationId, version: "0" }],
							},
							{ principal: { kind: "human", id: principal.accountId, displayName: "Proof Admin", surface: "emdash" } },
						);
						const adminToken = data.adminToken;
						ensureSyntheticAdmin(dbPath, adminToken);
						const db = new DatabaseSync(dbPath);
						try {
							db.prepare(
								`
								INSERT INTO options (name, value, revision)
								VALUES ('emdash:site_url', ?, 1)
								ON CONFLICT(name) DO UPDATE SET value = excluded.value
							`,
							).run(JSON.stringify(`http://127.0.0.1:${listenPort}`));
						} finally {
							db.close();
						}
						const settings = await persistConnectionSession(adminToken);
						sendJson(res, 200, {
							success: true,
							poolId: provisionedPoolId,
							locationId: provisionedLocationId,
							skuId: PROOF_SKU,
							settings,
							authorization: "synthetic_host_admin_not_website_consent",
							websiteConsent: false,
						});
						return;
					}
					if (data.action === "audit_storage") {
						const db = new DatabaseSync(dbPath, { readOnly: true });
						let optionNames = [];
						let kvIds = [];
						try {
							optionNames = db.prepare("SELECT name FROM options WHERE name LIKE ?").all(`plugin:${PLUGIN_ID}:%`).map(row => row.name);
							kvIds = db.prepare("SELECT id FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv'").all(PLUGIN_ID).map(row => row.id);
						} finally {
							db.close();
						}
						sendJson(res, 200, {
							success: true,
							optionNames,
							kvIds,
							singularSettingKey: optionNames.some(name => name.includes(":setting:")),
						});
						return;
					}
					sendJson(res, 400, { error: "unknown_action" });
				} catch (err) {
					sendJson(res, 500, { error: redactProofText(err instanceof Error ? err.message : "init_failed") });
				}
			});
			return;
		}
		handler(req, res);
	});

	const requestedPort = process.env.PORT ? Number(process.env.PORT) : CLEAN_INSTALL_HOST_PORT;
	if (!Number.isInteger(requestedPort) || requestedPort <= 0) throw new Error("PORT must be a fixed positive integer");
	await new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(requestedPort, "127.0.0.1", () => {
			server.off("error", rejectListen);
			const addr = server.address();
			listenPort = typeof addr === "object" && addr ? addr.port : requestedPort;
			if (listenPort !== requestedPort) {
				rejectListen(new Error(`Host bound ${listenPort} instead of controller port ${requestedPort}`));
				return;
			}
			console.log(`EMDASH_DB url=${emdashDatabaseUrl} path=${dbPath}`);
			console.log(`SERVER_READY url=http://127.0.0.1:${listenPort} pid=${process.pid}`);
			console.log(`PROOF_LOGIN url=http://127.0.0.1:${listenPort}/_proof/login`);
			resolveListen();
		});
	});

	async function shutdown() {
		server.close();
		await mf.dispose();
		process.exit(0);
	}
	process.on("SIGTERM", () => {
		void shutdown();
	});
	process.on("SIGINT", () => {
		void shutdown();
	});
	return { port: listenPort, pid: process.pid };
}
