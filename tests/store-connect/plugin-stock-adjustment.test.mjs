import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

const SERVICE = "https://inventory.dinkuskit.invalid";
const ADMIN_ID = "admin_test_1";

function createMockKv() {
	const items = new Map();
	let rev = 0;
	return {
		async get(key) {
			return items.get(key)?.value ?? null;
		},
		async getVersioned(key) {
			return items.get(key) ?? null;
		},
		async compareAndSet(key, revision, value) {
			const cur = items.get(key);
			if ((cur?.revision ?? null) !== revision) return { applied: false };
			const next = `rev_${++rev}`;
			items.set(key, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(key, revision) {
			const cur = items.get(key);
			if (!cur || cur.revision !== revision) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
		_items: items,
	};
}

function createMockSettings(initialSession) {
	const items = new Map();
	let rev = 0;
	if (initialSession) {
		items.set("connectionSession", { value: JSON.stringify(initialSession), revision: "rev_init" });
	}
	return {
		async get(key) {
			return items.get(key)?.value ?? null;
		},
		async getVersioned(key) {
			return items.get(key) ?? null;
		},
		async compareAndSet(key, revision, value) {
			const cur = items.get(key);
			if ((cur?.revision ?? null) !== revision) return { applied: false };
			const next = `srev_${++rev}`;
			items.set(key, { value, revision: next });
			return { applied: true, revision: next };
		},
		async compareAndDelete(key, revision) {
			const cur = items.get(key);
			if (!cur || cur.revision !== revision) return { applied: false };
			items.delete(key);
			return { applied: true };
		},
	};
}

function createTestCtx({ fetchHandler, kv, settings }) {
	return {
		site: { url: "https://shop.example.com" },
		url: (p) => `https://shop.example.com${p}`,
		http: {
			fetch: async (url, init) => {
				const req = new Request(url, init);
				return fetchHandler(req);
			},
		},
		kv: kv ?? createMockKv(),
		settings: settings ?? createMockSettings({
			protocolVersion: 2,
			phase: "token",
			token: "test_token_valid",
			siteId: "sim-site-1",
			expiresAt: Date.now() + 600000,
		}),
	};
}

function sampleLocations() {
	return {
		locations: [
			{ locationId: "loc_wh_1", name: "Warehouse One" },
			{ locationId: "loc_wh_2", name: "Warehouse Two" },
		],
	};
}

function sampleStockBalance() {
	return {
		ok: true,
		balance: {
			outcome: "found",
			balance: {
				poolId: "pool_1",
				skuId: "sku_mug",
				locationId: "loc_wh_2",
				onHand: { value: "25", unit: "each" },
				reserved: { value: "5", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				available: { value: "20", unit: "each" },
				expected: { value: "10", unit: "each" },
				inTransit: { value: "0", unit: "each" },
				version: "3",
				hasStockHistory: true,
			},
		},
	};
}

function sampleCanonicalPreview({ skuId = "sku_mug", locationId = "loc_wh_2", delta = "-2" } = {}) {
	return {
		schema: "dinkuskit.inventory.stock-adjustment-preview/v1",
		type: "stock.adjust",
		context: { siteId: "sim-site-1", poolId: "pool_1", locationId },
		effect: {
			skuId,
			locationId,
			onHandDelta: { value: delta, unit: "each" },
			reservedDelta: { value: "0", unit: "each" },
			balanceBefore: {
				onHand: { value: "25", unit: "each" },
				reserved: { value: "5", unit: "each" },
				available: { value: "20", unit: "each" },
				version: "3",
			},
			balanceAfter: {
				onHand: { value: "23", unit: "each" },
				reserved: { value: "5", unit: "each" },
				available: { value: "18", unit: "each" },
				version: "4",
			},
		},
		reason: { note: "Breakage" },
		references: [],
		warnings: [],
		confirmation: {
			value: "confirm_token_sample_123",
			expiresAt: new Date(Date.now() + 60000).toISOString(),
		},
	};
}

test("1. Fails closed and blocks preview replacement, cancel, or clear when an adjustment is pending", async () => {
	const kv = createMockKv();
	const originalPendingIntent = {
		status: "pending",
		initiatingAdminId: ADMIN_ID,
		preview: sampleCanonicalPreview(),
		command: {
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_frozen_pending_001",
			type: "stock.adjust",
			context: { siteId: "https://shop.example.com", poolId: "pool_1", locationId: "loc_wh_2" },
			payload: { skuId: "sku_mug", delta: { value: "-2", unit: "each" } },
			reason: { note: "Breakage" },
			references: [],
			expectedVersions: [{ skuId: "sku_mug", locationId: "loc_wh_2", version: "3" }],
		},
		expiresAt: Date.now() + 60000,
	};
	await kv.compareAndSet("state:stock-adjustment-intent", null, originalPendingIntent);

	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/preview") {
			return Response.json(sampleCanonicalPreview({ delta: "+10" }));
		}
		throw new Error(`Unexpected call: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// A. Attempt to submit a new preview while pending -> MUST BE REJECTED and not overwrite KV
	const submitResult = await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_adjustment",
			values: {
				location_id: "loc_wh_2",
				sku_id: "sku_mug",
				delta_value: "+10",
				note: "Restock attempt while pending",
			},
		},
		user: { id: ADMIN_ID },
	}, ctx);

	const storedAfterSubmit = await kv.get("state:stock-adjustment-intent");
	assert.equal(storedAfterSubmit.status, "pending", "Pending intent must NOT be replaced by preview submit");
	assert.equal(storedAfterSubmit.command.commandId, "cmd_frozen_pending_001", "Original commandId must be preserved");

	// B. Attempt to cancel while pending -> MUST BE REJECTED and not delete KV
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "cancel_adjustment",
			value: "cmd_frozen_pending_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	const storedAfterCancel = await kv.get("state:stock-adjustment-intent");
	assert.ok(storedAfterCancel, "Pending intent must NOT be deleted by cancel_adjustment");
	assert.equal(storedAfterCancel.status, "pending");

	// C. Attempt to clear while pending -> MUST BE REJECTED and not delete KV
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "clear_adjustment_result",
			value: "cmd_frozen_pending_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	const storedAfterClear = await kv.get("state:stock-adjustment-intent");
	assert.ok(storedAfterClear, "Pending intent must NOT be deleted by clear_adjustment_result");
	assert.equal(storedAfterClear.status, "pending");
});

test("2. Aborts confirm and DOES NOT call service if CAS to pending fails (unchecked CAS regression)", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_cas_test_001",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "preview",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	let serviceConfirmCalled = false;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/stock/adjust/confirm") {
			serviceConfirmCalled = true;
			return Response.json({ outcome: "committed", commandId: command.commandId, receipt: { receiptId: "rcpt_cas", committedAt: new Date().toISOString() } });
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	// Wrap kv.compareAndSet to simulate another concurrent writer winning CAS
	const originalCas = kv.compareAndSet;
	kv.compareAndSet = async (key, rev, val) => {
		if (key === "state:stock-adjustment-intent" && val?.status === "pending") {
			// Simulate CAS failure (e.g. concurrent mutation changed revision)
			return { applied: false };
		}
		return originalCas.call(kv, key, rev, val);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Click confirm
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_adjustment",
			value: "cmd_cas_test_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	assert.equal(serviceConfirmCalled, false, "Confirm request MUST NOT be sent to service if CAS to pending fails!");
});

test("3. Rejects stale confirmation action referencing an outdated preview identity", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_current_active_999",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "preview",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	let serviceConfirmCalled = false;
	const fetchHandler = async (req) => {
		if (req.url.includes("/v1/stock/adjust/confirm")) {
			serviceConfirmCalled = true;
			return Response.json({ outcome: "committed", commandId: "cmd_current_active_999", receipt: { receiptId: "rcpt_999", committedAt: new Date().toISOString() } });
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Action sent with an old stale commandId from earlier UI session
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_adjustment",
			value: "cmd_old_stale_identity_000",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	assert.equal(serviceConfirmCalled, false, "Stale confirm action with mismatched commandId must NOT trigger service call");
	const intentAfter = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfter.status, "preview", "Current active preview must remain untouched in preview status");
	assert.equal(intentAfter.command.commandId, "cmd_current_active_999");
});

test("4. Models lost acknowledgement at transport AFTER real service commit, then safely retries original command", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_lost_ack_777",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "preview",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	let confirmCalls = 0;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/confirm") {
			confirmCalls++;
			if (confirmCalls === 1) {
				// Server processes and commits the command, but response drops at transport!
				throw new Error("network transport lost: socket hang up");
			}
			// Retry receives idempotent success response
			return Response.json({
				outcome: "committed",
				commandId: "cmd_lost_ack_777",
				receipt: { receiptId: "rcpt_lost_ack_success", committedAt: "2026-09-30T12:00:00Z" },
			});
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Step A: First confirm attempt fails at transport
	const firstConfirmPage = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_adjustment",
			value: "cmd_lost_ack_777",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	// Intent MUST be saved as pending
	const intentAfterDrop = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfterDrop.status, "pending", "Intent MUST remain pending after transport failure");
	assert.equal(intentAfterDrop.command.commandId, "cmd_lost_ack_777", "Command ID must be preserved");

	// Step B: Reload page shows pending status and retry button
	const pageBlocks = await plugin.routes.admin.handler({
		input: { type: "page_load", page: "/inventory" },
		user: { id: ADMIN_ID },
	}, ctx);
	assert.match(JSON.stringify(pageBlocks), /Adjustment outcome unknown \/ pending/, "Should show pending banner");
	assert.match(JSON.stringify(pageBlocks), /retry_adjustment/, "Should offer retry button");

	// Step C: Click retry_adjustment with exact commandId
	const retryBlocks = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_adjustment",
			value: "cmd_lost_ack_777",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	assert.equal(confirmCalls, 2, "Retry must re-send to confirm endpoint");
	const intentAfterRetry = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfterRetry.status, "committed", "Intent must resolve to committed on successful retry");
	assert.equal(intentAfterRetry.receipt.receiptId, "rcpt_lost_ack_success");
});

test("5. Late retry/response cannot overwrite foreign state if revision changed concurrently", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_concurrency_race",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};
	// State is pending
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "pending",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/stock/adjust/confirm") {
			// During HTTP call, a foreign state or recovery happens in KV
			const foreignState = {
				status: "preview",
				initiatingAdminId: ADMIN_ID,
				preview: sampleCanonicalPreview({ skuId: "sku_foreign_diff" }),
				command: { ...command, commandId: "cmd_foreign_new_999" },
				expiresAt: Date.now() + 100000,
			};
			// Force replace state in KV with a new revision
			const cur = await kv.getVersioned("state:stock-adjustment-intent");
			await kv.compareAndSet("state:stock-adjustment-intent", cur.revision, foreignState);

			return Response.json({
				outcome: "committed",
				commandId: "cmd_concurrency_race",
				receipt: { receiptId: "rcpt_late_ack", committedAt: "2026-09-30T12:00:00Z" },
			});
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Trigger retry
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_adjustment",
			value: "cmd_concurrency_race",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	// The foreign state MUST NOT have been overwritten by late response fallback!
	const stateAfterLate = await kv.get("state:stock-adjustment-intent");
	assert.equal(stateAfterLate.command.commandId, "cmd_foreign_new_999", "Late response MUST NOT clobber foreign revision");
});

test("6. Consumes canonical rejected StockAdjustmentResult at HTTP 409 (e.g. stale_version) and terminalizes to rejected instead of permanently pending", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_stale_test_001",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "preview",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	let confirmCalls = 0;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/confirm") {
			confirmCalls++;
			return new Response(
				JSON.stringify({
					schema: "dinkuskit.inventory.command-result/v1",
					outcome: "rejected",
					commandId: "cmd_stale_test_001",
					code: "stale_version",
					message: "The expected version does not match the current balance version.",
				}),
				{
					status: 409,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Click confirm
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_adjustment",
			value: "cmd_stale_test_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	assert.equal(confirmCalls, 1, "Confirm endpoint must be called");
	const intentAfter = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfter.status, "rejected", "Intent must resolve to rejected instead of permanently pending");
	assert.equal(intentAfter.commandId, "cmd_stale_test_001", "Command ID must match");
	assert.equal(intentAfter.code, "stale_version", "Rejection code must be stale_version");

	// Now verify that a 409 canonical result with mismatched/foreign commandId does NOT terminalize
	await kv.compareAndSet("state:stock-adjustment-intent", (await kv.getVersioned("state:stock-adjustment-intent")).revision, {
		status: "pending",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	const foreignFetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/confirm") {
			return new Response(
				JSON.stringify({
					schema: "dinkuskit.inventory.command-result/v1",
					outcome: "rejected",
					commandId: "cmd_foreign_999",
					code: "stale_version",
					message: "Foreign rejection",
				}),
				{
					status: 409,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const foreignCtx = createTestCtx({ fetchHandler: foreignFetchHandler, kv });
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_adjustment",
			value: "cmd_stale_test_001",
		},
		user: { id: ADMIN_ID },
	}, foreignCtx);

	const intentAfterForeign = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfterForeign.status, "pending", "Pending intent must NOT terminalize on foreign commandId result");
	assert.equal(intentAfterForeign.command.commandId, "cmd_stale_test_001");
});

test("7. Lost ACK followed by non-authoritative inventory_not_ready (409) or unauthorized_context (403) failure preserves pending command; subsequent retry returns original receipt with no duplicate movement", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_lost_ack_auth_001",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};
	// State already in pending (e.g. after prior lost ACK)
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "pending",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	let attempt = 0;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/confirm") {
			attempt++;
			if (attempt === 1) {
				// Server returns 409 inventory_not_ready (readiness error before canonical command lookup)
				return new Response(
					JSON.stringify({ error: "inventory_not_ready", connection: { status: "provisioning" } }),
					{ status: 409, headers: { "Content-Type": "application/json" } },
				);
			}
			if (attempt === 2) {
				// Server returns 403 unauthorized_context (auth error before canonical command lookup)
				return new Response(
					JSON.stringify({ error: "unauthorized_context" }),
					{ status: 403, headers: { "Content-Type": "application/json" } },
				);
			}
			// Attempt 3: Service is ready and authorized, returns original committed receipt!
			return new Response(
				JSON.stringify({
					schema: "dinkuskit.inventory.command-result/v1",
					outcome: "committed",
					commandId: "cmd_lost_ack_auth_001",
					receipt: { receiptId: "rcpt_recovered_after_not_ready", committedAt: "2026-10-01T01:00:00Z" },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Attempt 1: retry during inventory_not_ready (409)
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_adjustment",
			value: "cmd_lost_ack_auth_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	const intentAfterNotReady = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfterNotReady.status, "pending", "inventory_not_ready MUST NOT abandon or overwrite pending intent");
	assert.equal(intentAfterNotReady.command.commandId, "cmd_lost_ack_auth_001", "Command identity must remain intact");

	// Attempt 2: retry during unauthorized_context (403)
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_adjustment",
			value: "cmd_lost_ack_auth_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	const intentAfterUnauth = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfterUnauth.status, "pending", "unauthorized_context MUST NOT abandon or overwrite pending intent");
	assert.equal(intentAfterUnauth.command.commandId, "cmd_lost_ack_auth_001", "Command identity must remain intact");

	// Attempt 3: retry succeeds and captures original receipt
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_adjustment",
			value: "cmd_lost_ack_auth_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);

	const intentAfterSuccess = await kv.get("state:stock-adjustment-intent");
	assert.equal(intentAfterSuccess.status, "committed", "Pending intent must resolve to committed once service succeeds");
	assert.equal(intentAfterSuccess.receipt.receiptId, "rcpt_recovered_after_not_ready");
	assert.equal(attempt, 3, "Three total retry attempts were made");
});

test("8. Action without explicit non-empty matching string for confirm, retry, cancel, or clear cannot submit writer or delete state", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	const command = {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_guard_001",
		type: "stock.adjust",
		context: preview.context,
		payload: { skuId: preview.effect.skuId, delta: preview.effect.onHandDelta },
		reason: preview.reason,
		references: [],
		expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: "3" }],
	};

	let serviceConfirmCalled = false;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/confirm") {
			serviceConfirmCalled = true;
			return Response.json({
				outcome: "committed",
				commandId: "cmd_guard_001",
				receipt: { receiptId: "rcpt_guard", committedAt: new Date().toISOString() },
			});
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};

	const ctx = createTestCtx({ fetchHandler, kv });

	// Set initial preview state
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "preview",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});

	// A. confirm_adjustment with missing / empty / non-string value must NOT call service writer
	for (const invalidValue of [undefined, "", "   ", 123, null, { id: "cmd_guard_001" }]) {
		serviceConfirmCalled = false;
		await plugin.routes.admin.handler({
			input: {
				type: "block_action",
				action_id: "confirm_adjustment",
				value: invalidValue,
			},
			user: { id: ADMIN_ID },
		}, ctx);
		assert.equal(serviceConfirmCalled, false, `confirm_adjustment with ${JSON.stringify(invalidValue)} must NOT call service`);
		const stored = await kv.get("state:stock-adjustment-intent");
		assert.equal(stored.status, "preview", "Preview must remain untouched");
	}

	// B. cancel_adjustment with missing / empty / non-string / mismatched value must NOT delete preview
	for (const invalidValue of [undefined, "", "   ", 123, "cmd_wrong_999"]) {
		await plugin.routes.admin.handler({
			input: {
				type: "block_action",
				action_id: "cancel_adjustment",
				value: invalidValue,
			},
			user: { id: ADMIN_ID },
		}, ctx);
		const stored = await kv.get("state:stock-adjustment-intent");
		assert.ok(stored, `cancel_adjustment with ${JSON.stringify(invalidValue)} must NOT delete preview`);
		assert.equal(stored.status, "preview");
	}

	// C. retry_adjustment with missing / empty / non-string / mismatched value must NOT call service writer
	await kv.compareAndSet("state:stock-adjustment-intent", (await kv.getVersioned("state:stock-adjustment-intent")).revision, {
		status: "pending",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});
	for (const invalidValue of [undefined, "", "   ", 123, "cmd_wrong_999"]) {
		serviceConfirmCalled = false;
		await plugin.routes.admin.handler({
			input: {
				type: "block_action",
				action_id: "retry_adjustment",
				value: invalidValue,
			},
			user: { id: ADMIN_ID },
		}, ctx);
		assert.equal(serviceConfirmCalled, false, `retry_adjustment with ${JSON.stringify(invalidValue)} must NOT call service`);
		const stored = await kv.get("state:stock-adjustment-intent");
		assert.equal(stored.status, "pending", "Pending state must remain untouched");
	}

	// D. clear_adjustment_result with missing / empty / non-string / mismatched value must NOT delete result
	await kv.compareAndSet("state:stock-adjustment-intent", (await kv.getVersioned("state:stock-adjustment-intent")).revision, {
		status: "committed",
		initiatingAdminId: ADMIN_ID,
		commandId: "cmd_guard_001",
		receipt: { receiptId: "rcpt_guard", committedAt: new Date().toISOString() },
	});
	for (const invalidValue of [undefined, "", "   ", 123, "cmd_wrong_999"]) {
		await plugin.routes.admin.handler({
			input: {
				type: "block_action",
				action_id: "clear_adjustment_result",
				value: invalidValue,
			},
			user: { id: ADMIN_ID },
		}, ctx);
		const stored = await kv.get("state:stock-adjustment-intent");
		assert.ok(stored, `clear_adjustment_result with ${JSON.stringify(invalidValue)} must NOT delete state`);
		assert.equal(stored.status, "committed");
	}

	// E. Valid cancel with exact matching string succeeds
	await kv.compareAndSet("state:stock-adjustment-intent", (await kv.getVersioned("state:stock-adjustment-intent")).revision, {
		status: "preview",
		initiatingAdminId: ADMIN_ID,
		preview,
		command,
		expiresAt: Date.now() + 60000,
	});
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "cancel_adjustment",
			value: "cmd_guard_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);
	const storedAfterValidCancel = await kv.get("state:stock-adjustment-intent");
	assert.equal(storedAfterValidCancel, null, "Valid cancel_adjustment with matching commandId must delete preview");

	// F. Valid clear with exact matching string succeeds
	await kv.compareAndSet("state:stock-adjustment-intent", null, {
		status: "committed",
		initiatingAdminId: ADMIN_ID,
		commandId: "cmd_guard_001",
		receipt: { receiptId: "rcpt_guard", committedAt: new Date().toISOString() },
	});
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "clear_adjustment_result",
			value: "cmd_guard_001",
		},
		user: { id: ADMIN_ID },
	}, ctx);
	const storedAfterValidClear = await kv.get("state:stock-adjustment-intent");
	assert.equal(storedAfterValidClear, null, "Valid clear_adjustment_result with matching commandId must delete state");
});

test("9. Binds a real preview to adminA, isolates adminB, and preserves exact pending retry", async () => {
	const kv = createMockKv();
	const preview = sampleCanonicalPreview();
	let confirmCalls = 0;
	let firstConfirmBody = null;
	let retryBody = null;
	let expectedCommandId = null;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/status") return Response.json({ status: "ready", operation: { operationId: "op_1", poolId: "pool_1", locationName: "Warehouse One", locationId: "loc_wh_2", status: "ready", failureCode: null } });
		if (url.pathname === "/v1/locations") return Response.json(sampleLocations());
		if (url.pathname === "/v1/stock") return Response.json(sampleStockBalance());
		if (url.pathname === "/v1/stock/adjust/preview") return Response.json(preview);
		if (url.pathname === "/v1/stock/adjust/confirm") {
			confirmCalls++;
			const body = await req.text();
			if (confirmCalls === 1) {
				firstConfirmBody = body;
				throw new Error("lost acknowledgement");
			}
			retryBody = body;
			return Response.json({
				schema: "dinkuskit.inventory.command-result/v1",
				outcome: "committed",
				commandId: expectedCommandId,
				receipt: { receiptId: "rcpt_real_owner", committedAt: "2026-10-01T01:00:00Z" },
			});
		}
		throw new Error(`Unexpected fetch: ${req.url}`);
	};
	const ctx = createTestCtx({ fetchHandler, kv });
	const adminA = { id: "adminA" };
	const adminB = { id: "adminB" };
	const previewPage = await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_adjustment",
			values: { location_id: "loc_wh_2", sku_id: "sku_mug", delta_value: "-2", note: "Breakage" },
		},
		user: adminA,
	}, ctx);
	const confirmButton = (previewPage.blocks || []).find((block) => block.type === "actions")?.elements?.find((element) => element.action_id === "confirm_adjustment");
	assert.equal(typeof confirmButton?.value, "string");
	const frozen = await kv.get("state:stock-adjustment-intent");
	assert.equal(frozen.initiatingAdminId, "adminA");
	assert.equal(frozen.status, "preview");
	assert.equal(frozen.command.commandId, confirmButton.value);
	expectedCommandId = frozen.command.commandId;

	const beforeAdminB = structuredClone(frozen);
	const foreignPage = await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: adminB }, ctx);
	assert.doesNotMatch(JSON.stringify(foreignPage), /confirm_adjustment|retry_adjustment|cancel_adjustment|clear_adjustment_result/);
	for (const input of [
		{ type: "block_action", action_id: "confirm_adjustment", value: confirmButton.value },
		{ type: "block_action", action_id: "retry_adjustment", value: confirmButton.value },
		{ type: "block_action", action_id: "cancel_adjustment", value: confirmButton.value },
		{ type: "block_action", action_id: "clear_adjustment_result", value: confirmButton.value },
		{ type: "form_submit", action_id: "preview_adjustment", values: { location_id: "loc_wh_2", sku_id: "sku_mug", delta_value: "99", note: "foreign replacement" } },
	]) {
		await plugin.routes.admin.handler({ input, user: adminB }, ctx);
	}
	assert.equal(confirmCalls, 0);
	assert.deepEqual(await kv.get("state:stock-adjustment-intent"), beforeAdminB);

	await plugin.routes.admin.handler({
		input: { type: "block_action", action_id: "confirm_adjustment", value: confirmButton.value },
		user: adminA,
	}, ctx);
	const pending = await kv.get("state:stock-adjustment-intent");
	assert.equal(pending.status, "pending");
	assert.equal(pending.initiatingAdminId, "adminA");
	assert.equal(confirmCalls, 1);

	const foreignPendingPage = await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: adminB }, ctx);
	assert.doesNotMatch(JSON.stringify(foreignPendingPage), /retry_adjustment/);
	await plugin.routes.admin.handler({
		input: { type: "block_action", action_id: "retry_adjustment", value: confirmButton.value },
		user: adminB,
	}, ctx);
	assert.equal(confirmCalls, 1);
	assert.deepEqual(await kv.get("state:stock-adjustment-intent"), pending);

	await plugin.routes.admin.handler({
		input: { type: "block_action", action_id: "retry_adjustment", value: confirmButton.value },
		user: adminA,
	}, ctx);
	const committed = await kv.get("state:stock-adjustment-intent");
	assert.equal(committed.status, "committed");
	assert.equal(committed.initiatingAdminId, "adminA");
	assert.equal(retryBody, firstConfirmBody);
	assert.equal(committed.receipt.receiptId, "rcpt_real_owner");
});

test("10. Legacy unbound adjustment intents are preserved and expose no actionable controls", async () => {
	for (const legacyIntent of [
		{ status: "preview", preview: sampleCanonicalPreview(), command: { schema: "dinkuskit.inventory.command/v1", commandId: "legacy_preview", type: "stock.adjust", context: { siteId: "https://shop.example.com", poolId: "pool_1", locationId: "loc_wh_2" }, payload: { skuId: "sku_mug", delta: { value: "-2", unit: "each" } }, reason: { note: "Breakage" }, references: [], expectedVersions: [{ skuId: "sku_mug", locationId: "loc_wh_2", version: "3" }] }, expiresAt: Date.now() + 60000 },
		{ status: "pending", preview: sampleCanonicalPreview(), command: { schema: "dinkuskit.inventory.command/v1", commandId: "legacy_pending", type: "stock.adjust", context: { siteId: "https://shop.example.com", poolId: "pool_1", locationId: "loc_wh_2" }, payload: { skuId: "sku_mug", delta: { value: "-2", unit: "each" } }, reason: { note: "Breakage" }, references: [], expectedVersions: [{ skuId: "sku_mug", locationId: "loc_wh_2", version: "3" }] }, expiresAt: Date.now() + 60000 },
		{ status: "committed", commandId: "legacy_committed", receipt: { receiptId: "legacy_receipt", committedAt: "2026-10-01T01:00:00Z" } },
		{ status: "rejected", commandId: "legacy_rejected", code: "stale_version", message: "legacy" },
	]) {
		const kv = createMockKv();
		await kv.compareAndSet("state:stock-adjustment-intent", null, legacyIntent);
		let serviceCalls = 0;
		const ctx = createTestCtx({
			kv,
			fetchHandler: async () => {
				serviceCalls++;
				throw new Error("legacy intent must not reach service");
			},
		});
		const before = structuredClone(legacyIntent);
		const page = await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: { id: ADMIN_ID } }, ctx);
		assert.doesNotMatch(JSON.stringify(page), /confirm_adjustment|retry_adjustment|cancel_adjustment|clear_adjustment_result/);
		await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "clear_adjustment_result", value: legacyIntent.commandId }, user: { id: ADMIN_ID } }, ctx);
		assert.equal(serviceCalls, 0);
		assert.deepEqual(await kv.get("state:stock-adjustment-intent"), before);
	}
});

function readyOperation() {
	return { status: "ready", operation: { operationId: "op_1", poolId: "pool_1", locationName: "Warehouse Two", locationId: "loc_wh_2", status: "ready", failureCode: null } };
}

const previewInput = { type: "form_submit", action_id: "preview_adjustment", values: { location_id: "loc_wh_2", sku_id: "sku_mug", delta_value: "-2", note: "Breakage" } };

test("11. A second trusted admin cannot reach final mutation for another admin's real preview", async () => {
	let finalCalls = 0;
	const ctx = createTestCtx({ fetchHandler: async req => {
		const path = new URL(req.url).pathname;
		if (path === "/v1/locations") return Response.json(sampleLocations());
		if (path === "/v1/status") return Response.json(readyOperation());
		if (path === "/v1/stock/adjust/preview") return Response.json(sampleCanonicalPreview());
		if (path === "/v1/stock/adjust/confirm") {
			finalCalls++;
			const body = await req.json();
			return Response.json({ outcome: "committed", commandId: body.command.commandId, receipt: { receiptId: "owner_receipt", committedAt: "2026-10-01T01:00:00Z" } });
		}
		throw new Error("Unexpected service route");
	} });
	await plugin.routes.admin.handler({ input: previewInput, user: { id: "adminA" } }, ctx);
	const before = structuredClone(await ctx.kv.getVersioned("state:stock-adjustment-intent"));
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "confirm_adjustment", value: before.value.command.commandId }, user: { id: "adminB" } }, ctx);
	assert.equal(finalCalls, 0, "foreign trusted administrator must not send a final stock mutation");
	assert.deepEqual(await ctx.kv.getVersioned("state:stock-adjustment-intent"), before);
	await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "confirm_adjustment", value: before.value.command.commandId }, user: { id: "adminA" } }, ctx);
	assert.equal(finalCalls, 1);
	assert.equal((await ctx.kv.get("state:stock-adjustment-intent")).receipt.receiptId, "owner_receipt");
});

test("12. A late preview response cannot replace a different administrator's winning intent", async () => {
	let releaseFirst, signalFirst;
	const waiting = new Promise(resolve => { signalFirst = resolve; });
	const gate = new Promise(resolve => { releaseFirst = resolve; });
	let previews = 0;
	const ctx = createTestCtx({ fetchHandler: async req => {
		const path = new URL(req.url).pathname;
		if (path === "/v1/locations") return Response.json(sampleLocations());
		if (path === "/v1/stock/adjust/preview") {
			if (++previews === 1) { signalFirst(); await gate; }
			return Response.json(sampleCanonicalPreview());
		}
		throw new Error("Unexpected service route");
	} });
	const first = plugin.routes.admin.handler({ input: previewInput, user: { id: "adminA" } }, ctx);
	await waiting;
	await plugin.routes.admin.handler({ input: previewInput, user: { id: "adminB" } }, ctx);
	const winner = structuredClone(await ctx.kv.getVersioned("state:stock-adjustment-intent"));
	assert.equal(winner.value.initiatingAdminId, "adminB");
	releaseFirst();
	await first;
	assert.deepEqual(await ctx.kv.getVersioned("state:stock-adjustment-intent"), winner);
});

test("13. Foreign administrators cannot clear bound committed or rejected results", async () => {
	for (const terminal of [
		{ status: "committed", initiatingAdminId: "adminA", commandId: "terminal_command", receipt: { receiptId: "terminal_receipt", committedAt: "2026-10-01T01:00:00Z" } },
		{ status: "rejected", initiatingAdminId: "adminA", commandId: "terminal_command", code: "stale_version" },
	]) {
		let finalCalls = 0;
		const ctx = createTestCtx({ fetchHandler: async req => {
			const path = new URL(req.url).pathname;
			if (path === "/v1/status") return Response.json(readyOperation());
			if (path === "/v1/locations") return Response.json(sampleLocations());
			if (path === "/v1/skus") return Response.json({ skus: [{ inventorySkuId: "sku_1", sku: "SKU-1", displayName: "SKU 1", unit: "each" }] });
			finalCalls++;
			throw new Error("Unexpected mutation");
		} });
		await ctx.kv.compareAndSet("state:stock-adjustment-intent", null, terminal);
		const before = structuredClone(await ctx.kv.getVersioned("state:stock-adjustment-intent"));
		const foreign = await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: { id: "adminB" } }, ctx);
		assert.doesNotMatch(JSON.stringify(foreign), /terminal_command|terminal_receipt|clear_adjustment_result/);
		await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "clear_adjustment_result", value: terminal.commandId }, user: { id: "adminB" } }, ctx);
		assert.deepEqual(await ctx.kv.getVersioned("state:stock-adjustment-intent"), before);
		await plugin.routes.admin.handler({ input: { type: "block_action", action_id: "clear_adjustment_result", value: terminal.commandId }, user: { id: "adminA" } }, ctx);
		assert.equal(await ctx.kv.get("state:stock-adjustment-intent"), null);
		assert.equal(finalCalls, 2);
	}
});

test("14. Only the originating administrator recovers an expired unsubmitted preview", async () => {
	const ctx = createTestCtx({ fetchHandler: async req => {
		const path = new URL(req.url).pathname;
		if (path === "/v1/locations") return Response.json(sampleLocations());
		if (path === "/v1/skus") return Response.json({ skus: [{ inventorySkuId: "sku_1", sku: "SKU-1", displayName: "SKU 1", unit: "each" }] });
		if (path === "/v1/status") return Response.json(readyOperation());
		if (path === "/v1/stock/adjust/preview") return Response.json(sampleCanonicalPreview());
		throw new Error("Unexpected mutation");
	} });
	await plugin.routes.admin.handler({ input: previewInput, user: { id: "adminA" } }, ctx);
	const saved = await ctx.kv.getVersioned("state:stock-adjustment-intent");
	await ctx.kv.compareAndSet("state:stock-adjustment-intent", saved.revision, { ...saved.value, expiresAt: Date.now() - 1 });
	const expired = structuredClone(await ctx.kv.getVersioned("state:stock-adjustment-intent"));
	await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: { id: "adminB" } }, ctx);
	assert.deepEqual(await ctx.kv.getVersioned("state:stock-adjustment-intent"), expired);
	const owner = await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: { id: "adminA" } }, ctx);
	assert.equal(await ctx.kv.get("state:stock-adjustment-intent"), null);
	assert.match(JSON.stringify(owner), /select_stock/);
});
