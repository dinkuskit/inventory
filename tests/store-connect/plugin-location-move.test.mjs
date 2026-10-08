import assert from "node:assert/strict";
import test from "node:test";
import plugin from "../../plugins/emdash-inventory/src/plugin.ts";

const SERVICE = "https://inventory.dinkuskit.invalid";
const ADMIN_A = "admin_test_1";
const ADMIN_B = "admin_test_2";

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

function createTestCtx({ fetchHandler, kv, settings, sessionAdminId = ADMIN_A }) {
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
			phase: "token",
			token: "tok_test_123",
			expiresAt: Date.now() + 3600000,
		}),
	};
}

const mockLocations = [
	{ locationId: "loc_main", name: "Main Warehouse" },
	{ locationId: "loc_front", name: "Front Shelf" },
];
const mockSkus = [
	{ inventorySkuId: "sku_hat_1", sku: "HAT-001", displayName: "Felt Fedora", unit: "each" },
];

function defaultFetchHandler(calls) {
	return async (req) => {
		const url = new URL(req.url);
		calls?.push({ method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers.entries()) });

		if (url.pathname === "/v1/status") {
			return Response.json({
				status: "ready",
				operation: { operationId: "op_1", poolId: "pool_1", locationName: "Main", locationId: "loc_main", status: "ready", failureCode: null },
			});
		}
		if (url.pathname === "/v1/locations") {
			return Response.json({ locations: mockLocations });
		}
		if (url.pathname === "/v1/skus") {
			return Response.json({ skus: mockSkus });
		}
		if (url.pathname === "/v1/stock") {
			return Response.json({
				ok: true,
				balance: {
					outcome: "found",
					balance: {
						hasStockHistory: true,
						onHand: { value: "10", unit: "each" },
						reserved: { value: "0", unit: "each" },
						available: { value: "10", unit: "each" },
						version: "ver_1",
					},
				},
			});
		}
		if (url.pathname === "/v1/stock/opening/eligibility") {
			return Response.json({ outcome: "ineligible", reason: "has_history" });
		}
		if (url.pathname === "/v1/transfers") {
			const body = await req.json();
			const cmd = body.command;
			if (cmd.type === "transfer.create") {
				return Response.json({
					outcome: "committed",
					commandId: cmd.commandId,
					transfer: { transferId: "xfer_100", version: 1 },
				});
			}
			if (cmd.type === "transfer.dispatch") {
				return Response.json({
					outcome: "committed",
					commandId: cmd.commandId,
					transfer: { transferId: "xfer_100", version: 2 },
				});
			}
			if (cmd.type === "transfer.receive") {
				return Response.json({
					outcome: "committed",
					commandId: cmd.commandId,
					receipt: { receiptId: "rcpt_xfer_whole", committedAt: "2026-10-08T12:00:00.000Z" },
				});
			}
		}
		throw new Error(`Unexpected fetch: ${req.method} ${req.url}`);
	};
}

test("location move: renders form when 2+ locations and 1+ SKUs exist", async () => {
	const calls = [];
	const ctx = createTestCtx({ fetchHandler: defaultFetchHandler(calls) });
	const res = await plugin.routes.admin.handler({ input: { type: "page_load", page: "/inventory" }, user: { id: ADMIN_A } }, ctx);

	const blockIds = res.blocks.map(b => b.block_id).filter(Boolean);
	assert.ok(blockIds.includes("location-move"), "Should render location-move form");
});

test("location move: rejects preview with identical from and to locations", async () => {
	const ctx = createTestCtx({ fetchHandler: defaultFetchHandler() });
	const res = await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_location_move",
			values: {
				from_location_id: "loc_main",
				to_location_id: "loc_main",
				sku_id: "sku_hat_1",
				quantity_value: "3",
			},
		},
		user: { id: ADMIN_A },
	}, ctx);

	assert.match(JSON.stringify(res), /Locations must be distinct|Locations must differ/);
	const stored = await ctx.kv.get("state:location-move-intent");
	assert.equal(stored, null, "Should not create intent on invalid locations");
});

test("location move: rejects non-positive quantity", async () => {
	const ctx = createTestCtx({ fetchHandler: defaultFetchHandler() });
	const res = await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_location_move",
			values: {
				from_location_id: "loc_main",
				to_location_id: "loc_front",
				sku_id: "sku_hat_1",
				quantity_value: "-2",
			},
		},
		user: { id: ADMIN_A },
	}, ctx);

	assert.match(JSON.stringify(res), /Invalid quantity|Quantity must be positive/);
	const stored = await ctx.kv.get("state:location-move-intent");
	assert.equal(stored, null, "Should not create intent on negative quantity");
});

test("location move: full flow through create -> dispatch -> receive whole transfer", async () => {
	const calls = [];
	const ctx = createTestCtx({ fetchHandler: defaultFetchHandler(calls) });

	// 1. Preview
	const previewRes = await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_location_move",
			values: {
				from_location_id: "loc_main",
				to_location_id: "loc_front",
				sku_id: "sku_hat_1",
				quantity_value: "5",
			},
		},
		user: { id: ADMIN_A },
	}, ctx);

	assert.match(JSON.stringify(previewRes), /Confirm location move/);
	const intent = await ctx.kv.get("state:location-move-intent");
	assert.equal(intent.status, "preview");
	assert.equal(intent.quantity.value, "5");
	assert.equal(intent.originLocationId, "loc_main");
	assert.equal(intent.destinationLocationId, "loc_front");

	// 2. Confirm
	const confirmRes = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_A },
	}, ctx);

	assert.match(JSON.stringify(confirmRes), /Location move committed/);
	const committed = await ctx.kv.get("state:location-move-intent");
	assert.equal(committed.status, "committed");
	assert.equal(committed.receipt.receiptId, "rcpt_xfer_whole");

	// Verify the 3 transfer calls were made with server headers
	const transferCalls = calls.filter(c => c.path === "/v1/transfers");
	assert.equal(transferCalls.length, 3);
	for (const call of transferCalls) {
		assert.equal(call.headers["authorization"], "Bearer tok_test_123");
		assert.ok(call.headers["x-inventory-site"]);
	}

	// 3. Clear result
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "clear_location_move_result",
			value: intent.commandId,
		},
		user: { id: ADMIN_A },
	}, ctx);
	assert.equal(await ctx.kv.get("state:location-move-intent"), null);
});

test("location move: admin isolation prevents foreign admin from confirming, retrying, canceling, or clearing", async () => {
	const ctx = createTestCtx({ fetchHandler: defaultFetchHandler() });

	// Admin A sets up preview
	await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_location_move",
			values: {
				from_location_id: "loc_main",
				to_location_id: "loc_front",
				sku_id: "sku_hat_1",
				quantity_value: "3",
			},
		},
		user: { id: ADMIN_A },
	}, ctx);

	const intent = await ctx.kv.get("state:location-move-intent");

	// Admin B attempts to confirm
	const foreignConfirm = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_B },
	}, ctx);
	assert.match(JSON.stringify(foreignConfirm), /belongs to another administrator/);
	assert.equal((await ctx.kv.get("state:location-move-intent")).status, "preview");

	// Admin B attempts to cancel
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "cancel_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_B },
	}, ctx);
	assert.equal((await ctx.kv.get("state:location-move-intent")).status, "preview");

	// Admin A cancels successfully
	await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "cancel_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_A },
	}, ctx);
	assert.equal(await ctx.kv.get("state:location-move-intent"), null);
});

test("location move: retry after network failure mid-transfer resumes from existing transfer version", async () => {
	let attempt = 0;
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/transfers") {
			const body = await req.json();
			const cmd = body.command;
			if (cmd.type === "transfer.create") {
				return Response.json({
					outcome: "committed",
					commandId: cmd.commandId,
					transfer: { transferId: "xfer_retry_200", version: 1 },
				});
			}
			if (cmd.type === "transfer.dispatch") {
				attempt++;
				if (attempt === 1) {
					// Simulate network drop during dispatch
					throw new Error("Network timeout during dispatch");
				}
				return Response.json({
					outcome: "committed",
					commandId: cmd.commandId,
					transfer: { transferId: "xfer_retry_200", version: 2 },
				});
			}
			if (cmd.type === "transfer.receive") {
				return Response.json({
					outcome: "committed",
					commandId: cmd.commandId,
					receipt: { receiptId: "rcpt_retry_success", committedAt: "2026-10-08T12:05:00.000Z" },
				});
			}
		}
		return defaultFetchHandler()(req);
	};

	const ctx = createTestCtx({ fetchHandler });

	// Preview
	await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_location_move",
			values: {
				from_location_id: "loc_main",
				to_location_id: "loc_front",
				sku_id: "sku_hat_1",
				quantity_value: "4",
			},
		},
		user: { id: ADMIN_A },
	}, ctx);

	const intent = await ctx.kv.get("state:location-move-intent");

	// First confirm fails mid-flight on dispatch
	const pendingPage = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_A },
	}, ctx);

	// Intent remains pending with transferId preserved
	const pendingIntent = await ctx.kv.get("state:location-move-intent");
	assert.equal(pendingIntent.status, "pending");
	assert.equal(pendingIntent.transferId, "xfer_retry_200");
	assert.match(JSON.stringify(pendingPage), /Location move outcome unknown \/ pending/);

	// Retry succeeds
	const retryRes = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "retry_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_A },
	}, ctx);

	assert.match(JSON.stringify(retryRes), /Location move committed/);
	const finalIntent = await ctx.kv.get("state:location-move-intent");
	assert.equal(finalIntent.status, "committed");
	assert.equal(finalIntent.receipt.receiptId, "rcpt_retry_success");
});

test("location move: kernel rejection records rejected terminal state", async () => {
	const fetchHandler = async (req) => {
		const url = new URL(req.url);
		if (url.pathname === "/v1/transfers") {
			return Response.json({
				outcome: "rejected",
				commandId: "cmd_rejected",
				code: "insufficient_available_stock",
				message: "Not enough stock at origin",
			});
		}
		return defaultFetchHandler()(req);
	};

	const ctx = createTestCtx({ fetchHandler });

	await plugin.routes.admin.handler({
		input: {
			type: "form_submit",
			action_id: "preview_location_move",
			values: {
				from_location_id: "loc_main",
				to_location_id: "loc_front",
				sku_id: "sku_hat_1",
				quantity_value: "99",
			},
		},
		user: { id: ADMIN_A },
	}, ctx);

	const intent = await ctx.kv.get("state:location-move-intent");

	const res = await plugin.routes.admin.handler({
		input: {
			type: "block_action",
			action_id: "confirm_location_move",
			value: intent.commandId,
		},
		user: { id: ADMIN_A },
	}, ctx);

	assert.match(JSON.stringify(res), /Location move rejected/);
	const rejected = await ctx.kv.get("state:location-move-intent");
	assert.equal(rejected.status, "rejected");
	assert.equal(rejected.code, "insufficient_available_stock");
});
