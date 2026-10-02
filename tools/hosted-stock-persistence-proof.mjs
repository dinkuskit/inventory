import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const root = fileURLToPath(new URL("../", import.meta.url));

async function main() {
	console.log("=== Disk-Backed SQLite DO Persistence Proof Across Host Restart ===");

	const storageDir = await mkdtemp(join(tmpdir(), "inventory-sqlite-do-"));
	console.log("Storage directory (disk-backed SQLite):", storageDir);

	// Generate synthetic signing keys for JWT account authentication
	const keys = await generateKeyPair("ES256");
	const publicJwk = { ...await exportJWK(keys.publicKey), alg: "ES256" };

	// Build the hosted worker
	const compiled = await build({
		entryPoints: [resolve(root, "tools/hosted-onboarding-proof-worker.ts")],
		bundle: true,
		format: "esm",
		platform: "browser",
		external: ["cloudflare:workers"],
		write: false,
	});
	const workerScript = compiled.outputFiles[0].text;

	const principal = { accountId: "proof-persist-acct", siteId: "proof-persist-site" };

	async function mintToken() {
		return new SignJWT({
			scope: "inventory:admin",
			site_id: principal.siteId,
		})
			.setProtectedHeader({ alg: "ES256" })
			.setIssuer("https://accounts.dinkuskit.invalid")
			.setAudience("inventory")
			.setSubject(principal.accountId)
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(keys.privateKey);
	}

	const token = await mintToken();

	function createMiniflareInstance() {
		return new Miniflare(convertV4MiniflareOptions({
			modules: true,
			script: workerScript,
			compatibilityDate: "2026-08-28",
			resourcePersistencePath: storageDir,
			bindings: { PROOF_JWKS: JSON.stringify({ keys: [publicJwk] }) },
			durableObjects: {
				INVENTORY_POOLS: { className: "InventoryPool", useSQLite: true },
				INVENTORY_ACCOUNTS: { className: "InventoryAccount", useSQLite: true },
			},
		}));
	}

	let poolId;
	let locationId;
	let adjustmentReceiptId;
	let initialConfirmationToken;
	const SYNTHETIC_SKU = "sku_synthetic_hat";

	// --- PHASE 1: INITIAL HOST LIFECYCLE ---
	console.log("\n[Phase 1] Starting initial host instance...");
	let mf1 = createMiniflareInstance();

	try {
		// 1. Connect account and provision location
		console.log("Provisioning account connection and location...");
		const connectRes = await mf1.dispatchFetch("https://inventory.dinkuskit.invalid/v1/connect", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Inventory-Site": principal.siteId,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				type: "create",
				requestId: "req_persist_initial",
				locationName: "Persistent North Depot",
			}),
		});
		assert.equal(connectRes.status, 200, "Connection provisioning must succeed");
		const connectData = await connectRes.json();
		assert.equal(connectData.status, "ready");
		poolId = connectData.operation.poolId;
		locationId = connectData.operation.locationId;
		assert.ok(poolId && locationId);
		console.log(`Provisioned poolId: ${poolId}, locationId: ${locationId}`);

		// 2. Seed initial stock balance of 10 each for synthetic SKU using test DO RPC
		console.log("Seeding synthetic SKU and opening balance in SQLite DO...");
		const poolNs = await mf1.getDurableObjectNamespace("INVENTORY_POOLS");
		const poolStub = poolNs.get(poolNs.idFromName(poolId));
		const seedResult = await poolStub.seedOpeningBalance({
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_seed_persist_opening",
			type: "stock.opening_balance",
			context: { siteId: principal.siteId, poolId, locationId },
			payload: { skuId: SYNTHETIC_SKU, quantity: { value: "10", unit: "each" } },
			reason: { code: "opening_balance", note: "Set initial inventory for proof" },
			references: [],
			expectedVersions: [{ skuId: SYNTHETIC_SKU, locationId, version: "0" }],
		}, {
			principal: { kind: "human", id: principal.accountId, displayName: "Proof Admin", surface: "emdash" },
		});
		assert.equal(seedResult.outcome, "committed", "Opening balance must commit");
		console.log("Opening balance committed: 10 each (v1)");

		// 3. Verify stock read via HTTP
		const stock1Res = await mf1.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`, {
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Inventory-Site": principal.siteId,
			},
		});
		const stock1 = await stock1Res.json();
		assert.equal(stock1.balance.balance.onHand.value, "10");
		assert.equal(stock1.balance.balance.version, "1");

		// 4. Perform stock adjustment (delta: -3 each)
		console.log("Performing stock adjustment: delta -3 each...");
		const previewRes = await mf1.dispatchFetch("https://inventory.dinkuskit.invalid/v1/stock/adjust/preview", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Inventory-Site": principal.siteId,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				locationId,
				skuId: SYNTHETIC_SKU,
				delta: { value: "-3", unit: "each" },
				reason: { note: "Proof adjustment before restart" },
			}),
		});
		assert.equal(previewRes.status, 200);
		const preview = await previewRes.json();
		initialConfirmationToken = preview.confirmation.value;

		const confirmRes = await mf1.dispatchFetch("https://inventory.dinkuskit.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Inventory-Site": principal.siteId,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				confirmation: initialConfirmationToken,
				command: {
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_adjust_before_restart",
					type: "stock.adjust",
					context: { siteId: principal.siteId, poolId, locationId },
					payload: { skuId: SYNTHETIC_SKU, delta: { value: "-3", unit: "each" } },
					reason: { note: "Proof adjustment before restart" },
					references: [],
					expectedVersions: [{ skuId: SYNTHETIC_SKU, locationId, version: "1" }],
				},
			}),
		});
		assert.equal(confirmRes.status, 200);
		const confirm = await confirmRes.json();
		assert.equal(confirm.outcome, "committed");
		adjustmentReceiptId = confirm.receipt.receiptId;
		console.log(`Adjustment committed: onHand 10 -> 7 each (v2), receiptId: ${adjustmentReceiptId}`);

		// 5. Verify stock is now 7
		const stockPreRestart = await mf1.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`, {
			headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": principal.siteId },
		});
		const stockPre = await stockPreRestart.json();
		assert.equal(stockPre.balance.balance.onHand.value, "7");
		assert.equal(stockPre.balance.balance.version, "2");
	} finally {
		// --- HOST SHUTDOWN / DISPOSE ---
		console.log("\n[Shutdown] Disposing Miniflare host (simulating host shutdown/process termination)...");
		await mf1.dispose();
		mf1 = null;
		console.log("Host disposed. In-memory state destroyed.");
	}

	// --- PHASE 2: NEW HOST RESTART USING SAME DISK STORAGE ---
	console.log("\n[Phase 2] Booting brand new host instance pointing to identical SQLite storage directory...");
	const mf2 = createMiniflareInstance();

	try {
		// 1. Verify connection status recovers from disk
		const statusRes = await mf2.dispatchFetch("https://inventory.dinkuskit.invalid/v1/status", {
			headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": principal.siteId },
		});
		assert.equal(statusRes.status, 200);
		const statusData = await statusRes.json();
		assert.equal(statusData.status, "ready");
		assert.equal(statusData.operation.poolId, poolId);
		console.log("Account connection status recovered across restart: ready");

		// 2. Verify stock balance recovered from disk-backed SQLite DO
		console.log("Reading canonical stock balance from fresh host instance...");
		const stockPostRestart = await mf2.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`, {
			headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": principal.siteId },
		});
		assert.equal(stockPostRestart.status, 200);
		const stockPost = await stockPostRestart.json();
		assert.equal(stockPost.ok, true);
		assert.equal(stockPost.balance.outcome, "found");
		assert.equal(stockPost.balance.balance.onHand.value, "7", "Balance must remain 7 after restart");
		assert.equal(stockPost.balance.balance.available.value, "7", "Available must remain 7 after restart");
		assert.equal(stockPost.balance.balance.version, "2", "Version must remain 2 after restart");
		console.log(`PASS: Stock balance verified intact across restart: On-Hand = ${stockPost.balance.balance.onHand.value} each (v${stockPost.balance.balance.version})`);

		// 3. Verify receipt history recovered from disk-backed SQLite DO
		console.log("Reading receipt history from fresh host instance...");
		const receiptsRes = await mf2.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/receipts?location_id=${locationId}`, {
			headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": principal.siteId },
		});
		assert.equal(receiptsRes.status, 200);
		const receiptsData = await receiptsRes.json();
		assert.equal(receiptsData.receipts.length, 2, "Opening balance + adjustment receipts must exist");
		const foundAdjust = receiptsData.receipts.find(r => r.receiptId === adjustmentReceiptId);
		assert.ok(foundAdjust, "Adjustment receipt must be found in receipt history after restart");
		assert.equal(foundAdjust.type, "stock.adjust");
		console.log(`PASS: Immutable receipt history intact across restart: found receipt ${adjustmentReceiptId}`);

		// 4. Exact retry of pre-restart command returns original receipt without duplicate movement
		console.log("Testing exact retry of pre-restart command across restart...");
		const retryRes = await mf2.dispatchFetch("https://inventory.dinkuskit.invalid/v1/stock/adjust/confirm", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Inventory-Site": principal.siteId,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				confirmation: initialConfirmationToken,
				command: {
					schema: "dinkuskit.inventory.command/v1",
					commandId: "cmd_adjust_before_restart",
					type: "stock.adjust",
					context: { siteId: principal.siteId, poolId, locationId },
					payload: { skuId: SYNTHETIC_SKU, delta: { value: "-3", unit: "each" } },
					reason: { note: "Proof adjustment before restart" },
					references: [],
					expectedVersions: [{ skuId: SYNTHETIC_SKU, locationId, version: "1" }],
				},
			}),
		});
		if (retryRes.status !== 200) {
			console.error("Retry failed status:", retryRes.status, "body:", await retryRes.text());
		}
		assert.equal(retryRes.status, 200);
		const retry = await retryRes.json();
		assert.equal(retry.outcome, "committed");
		assert.equal(retry.receipt.receiptId, adjustmentReceiptId, "Replay must return original receipt ID");

		const stockAfterRetry = await mf2.dispatchFetch(`https://inventory.dinkuskit.invalid/v1/stock?sku_id=${SYNTHETIC_SKU}&location_id=${locationId}`, {
			headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": principal.siteId },
		});
		const stockRetry = await stockAfterRetry.json();
		assert.equal(stockRetry.balance.balance.onHand.value, "7", "Balance must not change on idempotent replay");
		console.log("PASS: Idempotent replay after restart returns original receipt and preserves balance.");

		console.log("\n=== ALL DISK PERSISTENCE ASSERTIONS PASSED ===");
	} finally {
		await mf2.dispose();
		await rm(storageDir, { recursive: true, force: true });
	}
}

main().catch(err => {
	console.error("Proof failed:", err);
	process.exit(1);
});
