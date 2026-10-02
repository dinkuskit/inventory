#!/usr/bin/env node
// Clean-site config-managed sandbox install proof.
// Stops at the first undemonstrated admin boundary. --serve keeps the owned
// host up after a failed proof and prints only the /_proof/login URL.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { resolveEmdashDatabasePath } from "./emdash-database-path.mjs";
import { CLEAN_INSTALL_HOST_PORT } from "./emdash-clean-install-ports.mjs";
import { exportJWK, generateKeyPair } from "jose";
import { createInterface } from "node:readline";

function redactProofText(text) {
	return String(text)
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/ec_pat_[A-Za-z0-9_-]+/g, "ec_pat_[redacted]")
		.replace(/emdash_enc_v1_[A-Za-z0-9_-]+/g, "emdash_enc_v1_[redacted]")
		.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]");
}

const root = process.cwd();
const runDir = resolve(root, "runs/emdash-install-proof-runs/20260930");
const repairDir = process.env.EMDASH_PROOF_FIXTURE_DIR ? resolve(process.env.EMDASH_PROOF_FIXTURE_DIR) : resolve(runDir, "helper-repair");
const outputDir = process.env.EMDASH_PROOF_OUTPUT_DIR ? resolve(process.env.EMDASH_PROOF_OUTPUT_DIR) : repairDir;
const siteDir = process.env.EMDASH_PROOF_SITE_DIR ? resolve(process.env.EMDASH_PROOF_SITE_DIR) : resolve(repairDir, "site");
const isServeOnly = process.argv.includes("--serve-only");
const isServe = process.argv.includes("--serve") || isServeOnly;
const isConnectionOnly = process.argv.includes("--connection-only");
if (isServeOnly && !isConnectionOnly) throw new Error("Serve-only requires connection-only mode");
const adminToken = "ec_pat_synthetic_proof_token_clean_001";
const inventoryPage = "/inventory";
const configuredDatabase = resolveEmdashDatabasePath(siteDir);
const preservedDatabases = new Set([
	resolve(siteDir, "data.db"),
	resolve(runDir, "clean-site/data.db"),
	resolve(runDir, "clean-site/emdash.db"),
	resolve(runDir, "clean-site/grok-proof-state/data.db"),
	resolve(runDir, "bootstrap-repair/host-state/data.db"),
	resolve(root, "data.db"),
]);
if (preservedDatabases.has(configuredDatabase.path)) {
	throw new Error(`Built EmDash database is preserved (${configuredDatabase.path})`);
}

const tarballPath = resolve(siteDir, "dinkuskit-emdash-inventory-0.0.0.tgz");
const tarballBytes = readFileSync(tarballPath);
const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");
const installedPkgDir = resolve(siteDir, "node_modules/@dinkuskit/emdash-inventory");
if (lstatSync(installedPkgDir).isSymbolicLink()) {
	throw new Error("Installed plugin is a symlink");
}

function hostInteraction(interaction) {
	if (interaction.type === "page_load") return { type: "page_load", page: inventoryPage };
	return { ...interaction, page: inventoryPage };
}

function screenFlags(blocks) {
	const text = JSON.stringify(blocks);
	const titles = [];
	for (const block of blocks) {
		if (typeof block?.title === "string") titles.push(block.title);
		if (typeof block?.text === "string") titles.push(block.text.slice(0, 180));
	}
	return {
		count: blocks.length,
		titles,
		connect: text.includes("Connect Inventory"),
		confirmed: text.includes("Connection could not be confirmed"),
		connected: text.includes("Inventory connected"),
		merchantPending: text.includes("Waiting for explicit merchant consent"),
		pending: text.includes("Adjustment outcome unknown / pending"),
		committed: text.includes("Stock adjustment committed"),
		quantities: ["On-Hand:", "Reserved:", "Available:", "Outgoing Transfer:", "Expected:", "In-Transit:"].filter(label => text.includes(label)),
	};
}

async function postPluginAdmin(baseUrl, interaction) {
	const requestInteraction = hostInteraction(interaction);
	const response = await fetch(`${baseUrl}/_emdash/api/plugins/dinkus-inventory/admin`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${adminToken}`,
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		body: JSON.stringify(requestInteraction),
	});
	const raw = await response.text();
	let body = null;
	try {
		body = JSON.parse(raw);
	} catch {
		body = null;
	}
	const blocks = body && body.data && Array.isArray(body.data.blocks) ? body.data.blocks : null;
	return {
		path: "/_emdash/api/plugins/dinkus-inventory/admin",
		method: "POST",
		action: requestInteraction.action_id ?? requestInteraction.type,
		status: response.status,
		blocks,
		flags: blocks ? screenFlags(blocks) : null,
		error: blocks ? null : redactProofText(raw).slice(0, 400),
	};
}

const proofLog = [];
function logLine(line) {
	const safe = redactProofText(line);
	proofLog.push(safe);
	process.stdout.write(`${safe}\n`);
}

let activeChild = null;
process.on("message", message => {
	if (message?.type === "merchant_fetch_response" && activeChild?.connected) activeChild.send(message, () => {});
});
function spawnHostChild(instanceLabel) {
	const nodeBin = resolve(runDir, ".bin/node");
		const executable = process.env.EMDASH_PROOF_NODE_BIN || (existsSync(nodeBin) ? nodeBin : process.execPath);
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(executable, ["server.mjs"], {
			cwd: siteDir,
			env: {
				...process.env,
				PORT: String(CLEAN_INSTALL_HOST_PORT),
				HOST: "127.0.0.1",
				EMDASH_DATABASE_PATH: configuredDatabase.path,
				EMDASH_DATABASE_URL: configuredDatabase.configuredUrl,
				EMDASH_STORAGE_DIR: resolve(repairDir, "host-state/storage"),
				DO_PERSISTENCE_DIR: resolve(repairDir, "host-state/do-persistence"),
				EMDASH_ENCRYPTION_KEY: ephemeralEncryptionKey,
				EMDASH_PROOF_ADMIN_TOKEN: adminToken,
				EMDASH_PROOF_SIGNING_JWK: memorySigningJwk,
				EMDASH_PROOF_PUBLIC_JWK: memoryPublicJwk,
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
			serialization: "advanced",
			detached: true,
		});
		activeChild = child;
		child.on("message", message => {
			if (["merchant_fetch_request", "merchant_fetch_cancel"].includes(message?.type) && process.connected) process.send(message, () => {});
		});
		let started = false;
		let stdoutLine = "";
		child.stdout.on("data", data => {
			const str = redactProofText(data.toString());
			process.stdout.write(`[${instanceLabel} stdout] ${str}`);
			stdoutLine += str;
			let end;
			while ((end = stdoutLine.indexOf("\n")) !== -1) {
				const line = stdoutLine.slice(0, end).trim();
				stdoutLine = stdoutLine.slice(end + 1);
				if (line.startsWith("PEER_START_PREREQUISITES ")) {
					try {
						const p = JSON.parse(line.slice("PEER_START_PREREQUISITES ".length));
						if (typeof p.siteId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(p.siteId) && p.siteOrigin === "http://127.0.0.1:47631" && p.callbackUri === "http://127.0.0.1:47631/_emdash/admin/plugins/dinkus-inventory/inventory" && p.clientId === "dinkus-inventory-emdash" && p.service === "inventory") {
							boundary.prerequisites = { siteId: p.siteId, siteOrigin: p.siteOrigin, callbackUri: p.callbackUri, clientId: p.clientId, service: p.service };
						}
					} catch { /* Discard malformed observer records. */ }
				} else if (line.startsWith("MERCHANT_POOL_RECEIPT ")) {
					try {
						const p = JSON.parse(line.slice("MERCHANT_POOL_RECEIPT ".length));
						const id = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
						if (id(p.siteId) && id(p.operationId) && id(p.poolId) && (p.locationId === null || id(p.locationId)) && ["pending", "ready", "failed"].includes(p.status) && p.authorization === "canonical_jwks_verified") {
							boundary.merchantPool = { siteId: p.siteId, operationId: p.operationId, poolId: p.poolId, locationId: p.locationId, status: p.status, authorization: p.authorization };
							void writeFile(resolve(outputDir, "merchant-pool-state.json"), JSON.stringify({ at: new Date().toISOString(), ...boundary.merchantPool }, null, 2)).catch(() => process.stderr.write("Merchant pool proof write failed\n"));
						}
					} catch { /* Discard malformed observer records. */ }
				}
			}
			const match = str.match(/SERVER_READY url=(http:\/\/127\.0\.0\.1:(\d+)) pid=(\d+)/);
			if (match && !started) {
				started = true;
				if (Number(match[2]) !== CLEAN_INSTALL_HOST_PORT) {
					rejectPromise(new Error(`Host announced port ${match[2]} instead of ${CLEAN_INSTALL_HOST_PORT}`));
					return;
				}
				activeChild = child;
				resolvePromise({ child, url: match[1], pid: Number(match[3]) });
			}
		});
		child.stderr.on("data", data => {
			process.stderr.write(`[${instanceLabel} stderr] ${redactProofText(data.toString())}`);
		});
		child.on("error", err => {
			if (!started) rejectPromise(err);
		});
		child.on("exit", code => {
			if (!started) rejectPromise(new Error(`Child exited early with code ${code}`));
		});
	});
}

function stopHostChild(childInstance) {
	return new Promise(resolveStop => {
		if (!childInstance || childInstance.killed || !childInstance.pid || childInstance.exitCode !== null || childInstance.signalCode !== null) return resolveStop();
		let finished = false;
		let killTimer;
		const done = () => {
			if (finished) return;
			finished = true;
			clearTimeout(killTimer);
			resolveStop();
		};
		childInstance.once("exit", done);
		try {
			process.kill(-childInstance.pid, "SIGTERM");
		} catch {
			try { childInstance.kill("SIGTERM"); } catch { /* already gone */ }
		}
		killTimer = setTimeout(() => {
			try {
				process.kill(-childInstance.pid, "SIGKILL");
			} catch {
				try { childInstance.kill("SIGKILL"); } catch { /* already gone */ }
			}
			done();
		}, 3000);
	});
}

let stopRequested = false;
const stopped = new Promise(resolveStop => {
	const handleStop = async () => {
		stopRequested = true;
		await stopHostChild(activeChild);
		resolveStop();
	};
	process.once("SIGINT", handleStop);
	process.once("SIGTERM", handleStop);
});

const rawKeyBytes = randomBytes(32);
const ephemeralEncryptionKey = `emdash_enc_v1_${rawKeyBytes.toString("base64url")}`;
const signingKeys = await generateKeyPair("ES256", { extractable: true });
const memorySigningJwk = JSON.stringify(await exportJWK(signingKeys.privateKey));
const memoryPublicJwk = JSON.stringify(await exportJWK(signingKeys.publicKey));
logLine(`tarball_sha256=${tarballSha256} bytes=${tarballBytes.length} symlink=false`);
logLine(`database_url=${configuredDatabase.configuredUrl}`);
logLine(`host_port=${CLEAN_INSTALL_HOST_PORT}`);

const boundary = {
	at: new Date().toISOString(),
	tarballSha256,
	tarballBytes: tarballBytes.length,
	databaseUrl: configuredDatabase.configuredUrl,
	port: CLEAN_INSTALL_HOST_PORT,
	mode: isConnectionOnly ? "connection_only_no_seed" : "synthetic_stock",
	websiteConsent: false,
	requests: [],
	outcome: null,
};
let child = null;
let serveChild = null;

try {
	if (stopRequested) throw new Error("Proof interrupted");
	child = await spawnHostChild("Host");
	if (stopRequested) throw new Error("Proof interrupted");
	logLine(`host_ready pid=${child.pid} port=${CLEAN_INSTALL_HOST_PORT}`);
	const health = await fetch(`${child.url}/_emdash/api/health`);
	const healthBody = await health.json();
	boundary.requests.push({
		path: "/_emdash/api/health",
		method: "GET",
		status: health.status,
		product: healthBody.data?.product ?? null,
		version: healthBody.data?.version ?? null,
	});
	let initData;
	if (!isConnectionOnly) {
		const initRes = await fetch(`${child.url}/_proof/control`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "init_setup", adminToken }),
		});
		initData = await initRes.json();
		boundary.requests.push({
			path: "/_proof/control",
			method: "POST",
			action: "init_setup",
			status: initRes.status,
			success: initData.success === true,
			settings: initData.settings ?? null,
			error: typeof initData.error === "string" ? initData.error : null,
			websiteConsent: false,
		});
		if (!initData.success) throw new Error(`init_setup status=${initRes.status} error=${initData.error || "failed"}`);
		logLine(`init_setup pool=${initData.poolId} location=${initData.locationId} sku=${initData.skuId} settings=${initData.settings?.status}`);
	}

	const pageLoad = await postPluginAdmin(child.url, { type: "page_load", page: inventoryPage });
	boundary.requests.push({ path: pageLoad.path, method: pageLoad.method, action: pageLoad.action, status: pageLoad.status, flags: pageLoad.flags, error: pageLoad.error });
	logLine(`page_load status=${pageLoad.status} flags=${JSON.stringify(pageLoad.flags)}`);
	if (isConnectionOnly) {
		if (!pageLoad.flags?.connect || pageLoad.flags.connected) throw new Error("Fresh merchant fixture did not show Connect Inventory");
		if (isServeOnly) {
			boundary.outcome = "merchant_host_ready_no_connection_injected";
		} else {
			const connect = await postPluginAdmin(child.url, { type: "block_action", action_id: "connect" });
			boundary.requests.push({ path: connect.path, method: connect.method, action: connect.action, status: connect.status, flags: connect.flags, error: connect.error });
			logLine(`connect status=${connect.status} flags=${JSON.stringify(connect.flags)}`);
			if (!connect.flags?.merchantPending) {
				boundary.outcome = boundary.prerequisites ? "actual_connect_prerequisites_captured_peer_pending" : "connection_prerequisites_not_observed";
				throw new Error(`admin boundary ${boundary.outcome}; merchant consent not demonstrated`);
			}
			boundary.outcome = "merchant_challenge_created_consent_pending";
		}
	} else {
		if (!pageLoad.flags?.connected || pageLoad.flags.connect || pageLoad.flags.confirmed) {
			boundary.outcome = pageLoad.flags?.connect ? "connect_inventory_screen" : pageLoad.flags?.confirmed ? "connection_could_not_be_confirmed" : "admin_page_not_connected";
			throw new Error(`admin boundary ${boundary.outcome}`);
		}

		const select = await postPluginAdmin(child.url, {
			type: "form_submit",
			action_id: "select_stock",
			block_id: "select-stock-view",
			values: { location_id: initData.locationId, sku_id: initData.skuId },
		});
		boundary.requests.push({ path: select.path, method: select.method, action: select.action, status: select.status, flags: select.flags, error: select.error });
		logLine(`select_stock status=${select.status} flags=${JSON.stringify(select.flags)}`);
		if (!select.flags || select.flags.quantities.length < 6) {
			boundary.outcome = "selection_without_six_quantities";
			throw new Error(`admin boundary ${boundary.outcome}`);
		}
		boundary.outcome = "six_quantities_demonstrated";
		logLine("six canonical quantity labels are present; later adjustment steps are not claimed by this boundary check");
	}
	if (isServe) {
		serveChild = child;
		logLine(`PROOF_LOGIN url=${child.url}/_proof/login`);
	} else await stopHostChild(child.child);
} catch (err) {
	boundary.outcome = boundary.outcome || "failed_before_admin_screen";
	boundary.error = redactProofText(err instanceof Error ? err.message : "proof failed");
	logLine(boundary.error);
	if (isServe && child && !stopRequested) {
		serveChild = child;
		logLine(`PROOF_LOGIN url=${child.url}/_proof/login`);
	} else if (activeChild) {
		await stopHostChild(activeChild);
	}
	boundary.exit = 1;
} finally {
	if (!boundary.exit) boundary.exit = ["six_quantities_demonstrated", "merchant_host_ready_no_connection_injected", "merchant_challenge_created_consent_pending"].includes(boundary.outcome) ? 0 : 1;
	await mkdir(outputDir, { recursive: true });
	await writeFile(resolve(outputDir, "proof-run.json"), JSON.stringify(boundary, null, 2));
	await writeFile(resolve(outputDir, "proof.log"), proofLog.join("\n") + "\n");
}

if (isServe && serveChild) {
	// Controller keeps test encryption/signing keys only in memory across a
	// normal restart. No reseed or connectionSession replacement on restart.
	const input = createInterface({ input: process.stdin });
	let busy = false;
	input.on("line", async line => {
		if (busy) return;
		busy = true;
		try {
			if (line === "checkpoint" && isConnectionOnly) {
				const status = await postPluginAdmin(serveChild.url, { type: "page_load" });
				const record = { at: new Date().toISOString(), path: status.path, method: status.method, status: status.status, flags: status.flags, prerequisites: boundary.prerequisites ?? null, websiteConsent: "requires_separate_website_evidence" };
				const name = `merchant-admin-checkpoint-${Date.now()}.json`;
				await writeFile(resolve(outputDir, name), JSON.stringify(record, null, 2));
				logLine(`MERCHANT_CHECKPOINT file=${name} status=${status.status} flags=${JSON.stringify(status.flags)}`);
			} else if (line === "restart") {
				await stopHostChild(serveChild.child);
				serveChild = await spawnHostChild("Restart");
				logLine(`NORMAL_RESTART_READY url=${serveChild.url} reseed=false session_rewrite=false`);
			} else if (line === "receipts") {
				const response = await fetch(`${serveChild.url}/_proof/control`, {
					method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read_receipts" })
				});
				if (!response.ok) throw new Error(`Receipt request failed: ${response.status}`);
				const receipts = await response.json();
				const name = `receipts-${Date.now()}.json`;
				await writeFile(resolve(outputDir, name), JSON.stringify(receipts, null, 2));
				logLine(`RECEIPTS_SAVED file=${name} status=${response.status}`);
			}
		} catch (error) {
			logLine(`CONTROLLER_ERROR ${redactProofText(error.message)}`);
		} finally { busy = false; }
	});
	await stopped;
	input.close();
	await stopHostChild(serveChild.child);
}

process.exit(boundary.exit);
