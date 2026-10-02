#!/usr/bin/env node
// Joint local proof controller. Invoke only after the Website owner qualifies
// the exact supplied runner digest. No fixture merchant, receipt, session or
// consent injection is used. Website signing state survives Inventory restart.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { bootstrapCleanInstall, stampPreserved } from "./emdash-clean-install-bootstrap.mjs";

const root = resolve(import.meta.dirname, "..");
if (process.versions.node !== "22.23.2") throw new Error("Joint proof requires the Website-pinned Node 22.23.2");
const fixture = resolve(root, "runs/emdash-install-proof-runs/20260930/merchant-connect-variant");
const argument = name => {
	const index = process.argv.indexOf(name);
	if (index < 0 || !process.argv[index + 1]) throw new Error("Qualified Website runner path and digest are required");
	return process.argv[index + 1];
};
const websiteRunner = resolve(argument("--website-runner"));
const expectedDigest = argument("--website-sha256");
if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new Error("Website digest invalid");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
if (hash(await readFile(websiteRunner)) !== expectedDigest) throw new Error("Website runner differs from qualified source");
const websiteRoot = resolve(dirname(websiteRunner), "../..");
const websiteEntryDigest = argument("--website-entry-sha256");
const websiteTestEntryDigest = argument("--website-test-entry-sha256");
for (const [file, digest] of [["dist/server/entry.mjs", websiteEntryDigest], ["tests/fixtures/built-memory-test-entry.mjs", websiteTestEntryDigest]]) {
	if (!/^[a-f0-9]{64}$/.test(digest) || hash(await readFile(resolve(websiteRoot, file))) !== digest) throw new Error("Website entry differs from qualified artifact");
}

const manifest = JSON.parse(await readFile(resolve(fixture, "variant-hashes.json"), "utf8"));
const originalSite = resolve(fixture, "site");
const tarName = "dinkuskit-emdash-inventory-0.0.0.tgz";
if (hash(await readFile(resolve(originalSite, tarName))) !== manifest.tarball) throw new Error("Installed merchant tarball differs");
for (const [file, digest] of [["dist/plugin.mjs", manifest.code], ["dist/index.mjs", manifest.descriptor]]) {
	if (hash(await readFile(resolve(originalSite, "node_modules/@dinkuskit/emdash-inventory", file))) !== digest) throw new Error("Installed plugin differs from recorded artifact");
}
const run = resolve(fixture, `joint-${Date.now()}`);
const site = resolve(run, "site");
await mkdir(run, { recursive: true });
// Clone only the known public fixture site, never its persisted host-state DB.
// Each parent owns a fresh CMS database: an old encrypted challenge cannot be
// resumed after its memory-only key is gone. Normal child restart retains this
// run's database, UUID, encryption key and Website controller without reseeding.
const preservedMerchantDatabase = stampPreserved(resolve(fixture, "host-state/data.db"));
const clone = spawnSync("cp", ["-cR", originalSite, site], { encoding: "utf8" });
if (clone.status !== 0) throw new Error("Joint site clone failed");
for (const name of ["emdash-clean-install-host.mjs", "emdash-merchant-proof-sandbox.mjs", "emdash-merchant-loopback-transport.mjs", "emdash-merchant-ipc-transport.mjs", "emdash-proof-sandbox.mjs"]) {
	await copyFile(resolve(root, "tools", name), resolve(site, name));
}
await writeFile(resolve(site, "server.mjs"), `import { startCleanInstallHost } from "./emdash-clean-install-host.mjs";\nawait startCleanInstallHost({ siteDir: import.meta.dirname, repoRoot: ${JSON.stringify(root)}, proofTransport: true, merchantConnect: true, merchantPeer: "ipc" });\n`);
const configPath = resolve(site, "astro.config.mjs");
const config = await readFile(configPath, "utf8");
const sandboxAnchor = JSON.stringify(resolve(originalSite, "emdash-merchant-proof-sandbox.mjs"));
if (config.split(sandboxAnchor).length !== 2) throw new Error("Fixture sandbox anchor differs");
await writeFile(configPath, config.replace(sandboxAnchor, JSON.stringify(resolve(site, "emdash-merchant-proof-sandbox.mjs"))));
const bootstrap = bootstrapCleanInstall({ repoRoot: root, siteDir: site, runDir: run,
	databasePath: resolve(run, "host-state/data.db"), storageDir: resolve(run, "host-state/storage"), logDir: run });
if (JSON.stringify(stampPreserved(resolve(fixture, "host-state/data.db"))) !== JSON.stringify(preservedMerchantDatabase)) throw new Error("Prior merchant database changed");
await writeFile(resolve(run, "bootstrap.json"), JSON.stringify({ ...bootstrap, priorMerchantDatabasePreserved: true }, null, 2));
const record = {
	at: new Date().toISOString(), qualification: "local_joint_test_not_registry_approval",
	nodeVersion: process.versions.node,
	websiteRunnerSha256: expectedDigest, tarballSha256: manifest.tarball,
	websiteEntrySha256: websiteEntryDigest, websiteTestEntrySha256: websiteTestEntryDigest,
	hostSha256: hash(await readFile(resolve(site, "emdash-clean-install-host.mjs"))),
	merchantInventoryWorkerSha256: hash(await readFile(resolve(root, "tools/emdash-merchant-inventory-worker.ts"))),
	connectionInjected: false, receiptInjected: false, consent: "pending_visible_website_flow",
	databasePath: bootstrap.databasePath, priorMerchantDatabasePreserved: true,
	websitePort: 47632, inventoryPort: 47631, status: "starting",
};
const save = async () => {
	await writeFile(resolve(run, "STATE.json"), JSON.stringify(record, null, 2));
	await writeFile(resolve(run, "heartbeat"), new Date().toISOString() + "\n");
};
await save();
await writeFile(resolve(run, "PROOF.md"), "Joint test runtime only. No merchant consent claim until browser sign-in, explicit approval, installed receipt/callback and scoped pool evidence are captured.\n");
const event = async type => {
	const { appendFile } = await import("node:fs/promises");
	await appendFile(resolve(run, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), event: type }) + "\n");
};

let website, inventory, inventoryExit;
const inFlight = new Map();
let terminalDispatch = false;
let stop;
const interrupted = new Promise(resolveStop => { stop = resolveStop; });
async function terminalWebsiteDeadline() {
	if (terminalDispatch) return;
	terminalDispatch = true;
	record.status = "website_dispatch_deadline_terminal";
	try { await website?.stop(); } catch { process.stderr.write("WEBSITE_DEADLINE_STOP_UNPROVEN\n"); }
	stop();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const input = createInterface({ input: process.stdin });
let busy = false;
input.on("line", async line => {
	if (busy) return;
	busy = true;
	try {
		if (line === "stop") {
			stop();
		} else if (line === "website-restart" && website && !terminalDispatch) {
			await website.restart();
			await event("website_child_restarted_same_memory_controller");
			process.stdout.write("WEBSITE_RESTART_READY memory_controller_preserved=true\n");
		} else if (["restart", "checkpoint"].includes(line) && inventory?.stdin.writable) {
			inventory.stdin.write(line + "\n");
		}
	} catch {
		process.stderr.write("JOINT_CONTROL_FAILED\n");
	} finally { busy = false; }
});
const heartbeat = setInterval(() => { void save().catch(() => {}); }, 15000);

try {
	// The qualified helper invokes Wrangler relative to its own checkout.
	process.chdir(websiteRoot);
	const module = await import(pathToFileURL(websiteRunner).href);
	website = await module.startInventoryMemoryController({ websitePort: 47632, storePort: 47631 });
	if (website.expectedStoreOrigin !== "http://127.0.0.1:47631" || website.safeURLs.website !== "http://127.0.0.1:47632" || website.owned.dispatcher !== false || typeof website.dispatch !== "function") throw new Error("Website interface differs");
	inventory = spawn(process.execPath, [resolve(root, "tools/emdash-clean-install-proof.mjs"), "--connection-only", "--serve-only"], {
		cwd: root, env: { ...process.env, EMDASH_PROOF_FIXTURE_DIR: run, EMDASH_PROOF_SITE_DIR: site, EMDASH_PROOF_OUTPUT_DIR: run, EMDASH_PROOF_NODE_BIN: process.execPath },
		stdio: ["pipe", "inherit", "inherit", "ipc"], serialization: "advanced",
	});
	inventory.on("message", async message => {
		if (message?.type === "merchant_fetch_cancel") { if (inFlight.has(message.id)) await terminalWebsiteDeadline(); return; }
		if (message?.type !== "merchant_fetch_request" || typeof message.id !== "string" || !(message.body instanceof Uint8Array) || message.body.byteLength > 8192) return;
		if (terminalDispatch) return;
		const controller = new AbortController();
		inFlight.set(message.id, controller);
		let timer;
		try {
			const request = new Request(message.url, { method: message.method, headers: message.headers, body: message.body, signal: controller.signal });
			const result = await Promise.race([
				(async () => {
					const response = await website.dispatch(request);
					const body = new Uint8Array(await response.arrayBuffer());
					if (body.byteLength > 8192) throw new Error("Website response oversized");
					return { status: response.status, headers: [...response.headers], body };
				})(),
				new Promise((_, reject) => { timer = setTimeout(() => { void terminalWebsiteDeadline(); reject(new Error("Website deadline")); }, 5000); }),
			]);
			if (inventory.connected && !terminalDispatch && !controller.signal.aborted) inventory.send({ type: "merchant_fetch_response", id: message.id, ...result }, () => {});
		} catch {
			if (inventory.connected) inventory.send({ type: "merchant_fetch_response", id: message.id, error: "unavailable" }, () => {});
		} finally { clearTimeout(timer); inFlight.delete(message.id); }
	});
	inventoryExit = new Promise(resolveExit => { inventory.once("exit", code => resolveExit(code)); inventory.once("error", () => resolveExit(1)); });
	record.status = "runtimes_starting_consent_unproven";
	await event("website_controller_started_inventory_child_dispatched");
	await save();
	process.stdout.write(`JOINT_CONTROLLER website=http://127.0.0.1:47632 proof=${run}\n`);
	await Promise.race([interrupted, inventoryExit]);
} catch {
	record.status = "joint_start_failed";
	process.stderr.write("JOINT_START_FAILED; no consent or connection claim\n");
	process.exitCode = 1;
} finally {
	clearInterval(heartbeat);
	input.close();
	for (const request of inFlight.values()) request.abort();
	if (inventory && inventory.exitCode === null && inventory.signalCode === null) {
		inventory.kill("SIGINT");
		await inventoryExit;
	}
	let websiteStopped = true;
	try { await website?.stop(); } catch {
		websiteStopped = false;
		process.stderr.write("WEBSITE_STOP_UNPROVEN\n");
		process.exitCode = 1;
	}
	// Preserve isolated D1 proof state; never call destructive cleanup().
	if (!websiteStopped) record.status = "website_cleanup_unproven";
	else if (!terminalDispatch && record.status !== "joint_start_failed") record.status = "stopped_consent_requires_artifacts";
	await event(websiteStopped ? "owned_runtimes_stopped" : "website_cleanup_unproven");
	await save();
}
