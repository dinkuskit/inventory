import type { SandboxedPlugin } from "emdash/plugin";
import { pluginResponse } from "emdash/plugin";
import type { PluginContext } from "emdash";
import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import { z } from "zod";
import {
	STORE_CONNECT_CALLBACK_PATH,
	STORE_CONNECT_CLIENT_ID,
	STORE_CONNECT_SERVICE,
	StoreConnectError,
	approvedCallbackUri,
	assertStartResponseBounds,
	assertVerificationUri,
	canonicalizeSiteOrigin,
	createPkcePair,
	createProofReceipt,
	interpretStoredConnectionSession,
	proofReceiptSchema,
	publicProofFor,
	requireBoundAdministrator,
	requireOriginatingAdministrator,
	resumeActiveChallenge,
	startRequestSchema,
	startResponseSchema,
	tokenFailureSchema,
	tokenPendingSchema,
	tokenSuccessSchema,
	type StoreConnectSession,
} from "../../../src/features/store-connect/index.ts";

// Reserved non-routable defaults until DinkusKit configures the website and Inventory service.
// The proof host maps these declared origins to local fixtures; shop owners never configure them.
const SERVICE = "https://inventory.dinkuskit.invalid";
const WEBSITE = "https://accounts.dinkuskit.invalid";
const id = z.string().min(1).max(200);

const intentSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("create"), requestId: id, locationName: z.string().trim().min(1).max(200) }).strict(),
	z.object({ type: z.literal("reconnect"), requestId: id, operationId: id }).strict(),
]);
const operationSchema = z.object({ operationId: id, poolId: id, locationName: z.string(), locationId: z.string().nullable(), status: z.enum(["pending", "ready", "failed"]), failureCode: z.string().nullable() });
const statusSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("unconnected") }), z.object({ status: z.enum(["pending", "ready", "failed"]), operation: operationSchema })]);
type Session = StoreConnectSession;

class InventoryApiError extends Error {
	code: string;
	constructor(code: string) { super("Inventory request rejected"); this.code = code; }
}

const previewEffectBalanceSchema = z.object({
	onHand: z.object({ value: z.string(), unit: z.string() }).strict(),
	reserved: z.object({ value: z.string(), unit: z.string() }).strict(),
	available: z.object({ value: z.string(), unit: z.string() }).strict(),
	version: z.string(),
}).strict();

const adjustmentWarningSchema = z.object({
	code: z.literal("negative_available"),
	reserved: z.object({ value: z.string(), unit: z.string() }).strict(),
	oversoldBy: z.object({ value: z.string(), unit: z.string() }).strict(),
	message: z.string(),
}).strict();

const adjustmentPreviewSchema = z.object({
	schema: z.literal("dinkuskit.inventory.stock-adjustment-preview/v1"),
	type: z.literal("stock.adjust"),
	context: z.object({
		siteId: z.string(),
		poolId: z.string(),
		locationId: z.string(),
	}).strict(),
	effect: z.object({
		skuId: z.string(),
		locationId: z.string(),
		onHandDelta: z.object({ value: z.string(), unit: z.string() }).strict(),
		reservedDelta: z.object({ value: z.string(), unit: z.string() }).strict(),
		balanceBefore: previewEffectBalanceSchema,
		balanceAfter: previewEffectBalanceSchema,
	}).strict(),
	reason: z.object({ note: z.string() }).strict(),
	references: z.array(z.object({ kind: z.string(), id: z.string() }).strict()).default([]),
	warnings: z.array(adjustmentWarningSchema).default([]),
	confirmation: z.object({
		value: z.string(),
		expiresAt: z.string(),
	}).strict(),
}).strict();

type AdjustmentPreview = z.infer<typeof adjustmentPreviewSchema>;

const stockCommandSchema = z.object({
	schema: z.literal("dinkuskit.inventory.command/v1"),
	commandId: z.string(),
	type: z.literal("stock.adjust"),
	context: z.object({
		siteId: z.string(),
		poolId: z.string(),
		locationId: z.string(),
	}).strict(),
	payload: z.object({
		skuId: z.string(),
		delta: z.object({ value: z.string(), unit: z.string() }).strict(),
	}),
	reason: z.object({ note: z.string() }).strict(),
	references: z.array(z.object({ kind: z.string(), id: z.string() }).strict()).default([]),
	expectedVersions: z.array(z.object({
		skuId: z.string(),
		locationId: z.string(),
		version: z.string(),
	}).strict()).min(1),
}).strict();

type StockCommand = z.infer<typeof stockCommandSchema>;

const adjustmentIntentSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("preview"),
		preview: adjustmentPreviewSchema,
		command: stockCommandSchema,
		expiresAt: z.number(),
	}).strict(),
	z.object({
		status: z.literal("pending"),
		preview: adjustmentPreviewSchema,
		command: stockCommandSchema,
		expiresAt: z.number(),
	}).strict(),
	z.object({
		status: z.literal("committed"),
		commandId: z.string(),
		receipt: z.object({
			receiptId: z.string(),
			committedAt: z.string(),
		}),
	}).strict(),
	z.object({
		status: z.literal("rejected"),
		commandId: z.string(),
		code: z.string(),
		message: z.string().optional(),
	}).strict(),
]);

type AdjustmentIntent = z.infer<typeof adjustmentIntentSchema>;

const canonicalStockAdjustmentResultSchema = z.discriminatedUnion("outcome", [
	z.object({
		schema: z.literal("dinkuskit.inventory.command-result/v1").optional(),
		outcome: z.literal("committed"),
		commandId: z.string(),
		receipt: z.object({
			receiptId: z.string(),
			committedAt: z.string(),
		}).passthrough(),
	}),
	z.object({
		schema: z.literal("dinkuskit.inventory.command-result/v1").optional(),
		outcome: z.literal("rejected"),
		commandId: z.string(),
		code: z.string(),
		message: z.string().optional(),
	}),
]);

const CONFIRMATION_FAILURE_CODES = new Set([
	"confirmation_expired",
	"confirmation_mismatch",
	"confirmation_already_used",
	"confirmation_not_found",
]);

const interactionSchema = z.union([
	z.object({ type: z.literal("page_load"), page: z.literal("/inventory") }),
	z.object({
		type: z.literal("block_action"),
		action_id: z.enum([
			"connect",
			"check_sign_in",
			"retry",
			"refresh",
			"confirm_adjustment",
			"cancel_adjustment",
			"retry_adjustment",
			"clear_adjustment_result",
		]),
		block_id: z.string().optional(),
		value: z.unknown().optional(),
	}),
	z.object({
		type: z.literal("form_submit"),
		action_id: z.literal("create"),
		block_id: z.string().optional(),
		values: z.object({ location_name: z.string().trim().min(1).max(200) }).strict(),
	}),
	z.object({
		type: z.literal("form_submit"),
		action_id: z.literal("reconnect"),
		block_id: z.string().optional(),
		values: z.object({ operation_id: id }).strict(),
	}),
	z.object({
		type: z.literal("form_submit"),
		action_id: z.literal("select_stock"),
		block_id: z.string().optional(),
		values: z.object({
			location_id: id,
			sku_id: z.string().trim().min(1).max(200),
		}).strict(),
	}),
	z.object({
		type: z.literal("form_submit"),
		action_id: z.literal("preview_adjustment"),
		block_id: z.string().optional(),
		values: z.object({
			location_id: id.optional(),
			sku_id: z.string().trim().min(1).max(200),
			delta_value: z.string().trim().min(1).max(50),
			note: z.string().trim().min(1).max(500),
		}).strict(),
	}),
]);

const button = (action_id: string, label: string, value?: unknown): Block => ({
	type: "actions",
	elements: [{ type: "button", action_id, label, value: value !== undefined ? value : undefined }],
});
const page = (blocks: Block[]): BlockResponse => ({ blocks: [{ type: "header", text: "Inventory" }, ...blocks] });
const notice = (title: string, description: string) => page([{ type: "banner", variant: "alert", title, description }]);
const trial: Block = { type: "context", text: "Start your Inventory trial. No payment details are needed to connect or begin use." };

async function setKvKey(ctx: PluginContext, key: string, value: unknown) {
	const cur = await ctx.kv.getVersioned<unknown>(key);
	if (cur) {
		await ctx.kv.compareAndSet(key, cur.revision, value);
	} else {
		await ctx.kv.compareAndSet(key, null, value);
	}
}

async function siteId(ctx: PluginContext): Promise<string> {
	let found = await ctx.kv.get<string>("state:site-id");
	if (found) return found;
	// Site origin and plugin identity are distinct protocol fields. Keep any
	// existing binding stable; new installations mint an opaque identifier.
	const generated = crypto.randomUUID();
	await ctx.kv.compareAndSet("state:site-id", null, generated);
	found = await ctx.kv.get<string>("state:site-id");
	if (!found) throw new Error("Site identity unavailable");
	return found;
}

function siteOrigin(ctx: PluginContext): string {
	const host = ctx.site.url?.trim();
	if (!host) throw new StoreConnectError("invalid_site_origin");
	let parsed: URL;
	try { parsed = new URL(host); } catch { throw new StoreConnectError("invalid_site_origin"); }
	const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
	return canonicalizeSiteOrigin(host, { allowLoopback: loopback });
}

async function readSession(ctx: PluginContext) {
	const stored = await ctx.settings.getVersioned<string>("connectionSession");
	if (!stored) return null;
	const interpreted = interpretStoredConnectionSession(JSON.parse(stored.value));
	if (interpreted.kind === "current") return { session: interpreted.session, revision: stored.revision };
	if (interpreted.kind === "legacy-device") {
		if (!await clearSession(ctx, stored.revision)) throw new Error("Session changed; reload Inventory");
		return null;
	}
	throw new Error("Session changed; reload Inventory");
}

async function inspectSession(ctx: PluginContext): Promise<Session | null> {
	const stored = await ctx.settings.getVersioned<string>("connectionSession");
	if (!stored) return null;
	try {
		const interpreted = interpretStoredConnectionSession(JSON.parse(stored.value));
		if (interpreted.kind === "current") return interpreted.session;
		return null;
	} catch {
		return null;
	}
}

async function saveSession(ctx: PluginContext, session: Session, revision: string | null) {
	const result = await ctx.settings.compareAndSet("connectionSession", revision, JSON.stringify(session));
	if (!result.applied) throw new Error("Session changed; reload Inventory");
	return (result as { applied: boolean; revision?: string | null }).revision ?? null;
}

async function clearSession(ctx: PluginContext, revision: string | null) {
	return revision ? (await ctx.settings.compareAndDelete("connectionSession", revision)).applied : false;
}

async function readProof(ctx: PluginContext, connectionId: string) {
	const stored = await ctx.kv.get<unknown>(`state:store-proof:${connectionId}`);
	if (!stored) return null;
	const parsed = proofReceiptSchema.safeParse(stored);
	return parsed.success ? parsed.data : null;
}

async function saveProof(ctx: PluginContext, receipt: ReturnType<typeof createProofReceipt>) {
	await ctx.kv.compareAndSet(`state:store-proof:${receipt.connection_id}`, null, receipt);
}

async function deleteProof(ctx: PluginContext, connectionId: string) {
	const stored = await ctx.kv.getVersioned<unknown>(`state:store-proof:${connectionId}`);
	if (stored) await ctx.kv.compareAndDelete(`state:store-proof:${connectionId}`, stored.revision);
}

async function fetchJson(ctx: PluginContext, url: string, init?: RequestInit) {
	if (!ctx.http) throw new Error("Inventory network capability unavailable");
	const response = await ctx.http.fetch(url, init);
	return { response, body: await response.json() as unknown };
}

async function api(ctx: PluginContext, token: string, path: string, input?: unknown) {
	const { response, body } = await fetchJson(ctx, SERVICE + path, {
		method: input ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			"X-Inventory-Site": await siteId(ctx),
			"Content-Type": "application/json",
		},
		body: input ? JSON.stringify(input) : undefined,
	});
	if (!response.ok) {
		if (response.status === 401) throw new Error("sign_in_required");
		const rejected = z.object({ error: z.string(), message: z.string().optional() }).safeParse(body);
		if (rejected.success && [400, 403, 404, 409].includes(response.status)) throw new InventoryApiError(rejected.data.error);
		throw new Error("Inventory request unavailable");
	}
	return body;
}

async function startStoreConnect(ctx: PluginContext, adminId: string) {
	const stored = await readSession(ctx);
	if (stored?.session.phase === "token" && stored.session.expiresAt > Date.now()) return;
	let writeRevision = stored?.revision ?? null;
	if (stored?.session.phase === "challenge") {
		try {
			if (resumeActiveChallenge(stored.session, adminId, Date.now())) return;
		} catch (error) {
			if (error instanceof StoreConnectError && error.code === "wrong_originating_admin") throw error;
		}
		if (stored.session.expiresAt > Date.now()) throw new StoreConnectError("connection_in_progress");
		await deleteProof(ctx, stored.session.connectionId);
		if (!await clearSession(ctx, stored.revision)) throw new StoreConnectError("connection_in_progress");
		writeRevision = null;
	}
	const origin = siteOrigin(ctx);
	const callbackUri = approvedCallbackUri(origin);
	if (ctx.url(STORE_CONNECT_CALLBACK_PATH) !== callbackUri) throw new StoreConnectError("invalid_site_origin");
	const pkce = await createPkcePair();
	const request = startRequestSchema.parse({
		client_id: STORE_CONNECT_CLIENT_ID,
		service: STORE_CONNECT_SERVICE,
		site_id: await siteId(ctx),
		site_origin: origin,
		callback_uri: callbackUri,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
	});
	const { response, body } = await fetchJson(ctx, WEBSITE + "/api/store-connections", {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
	});
	if (!response.ok) throw new StoreConnectError("unexpected_website_response");
	const started = startResponseSchema.parse(body);
	assertVerificationUri(started.verification_uri, WEBSITE, started.connection_id);
	const expiresAt = assertStartResponseBounds(started, Date.now());
	const interval = started.interval * 1000;
	const receipt = createProofReceipt({
		connectionId: started.connection_id,
		challenge: started.challenge,
		siteId: request.site_id,
		siteOrigin: origin,
		callbackUri,
		codeChallenge: pkce.challenge,
		expiresAt,
	});
	await saveProof(ctx, receipt);
	try {
		await saveSession(ctx, {
			phase: "challenge",
			connectionId: started.connection_id,
			challenge: started.challenge,
			verificationUri: started.verification_uri,
			expiresAt,
			interval,
			nextPoll: Date.now() + interval,
			codeVerifier: pkce.verifier,
			initiatingAdminId: adminId,
			siteId: request.site_id,
			siteOrigin: origin,
			callbackUri,
			codeChallenge: pkce.challenge,
		}, writeRevision);
	} catch (error) {
		await deleteProof(ctx, receipt.connection_id);
		throw error;
	}
}

async function pollStoreConnect(ctx: PluginContext, adminId: string) {
	const stored = await readSession(ctx);
	if (!stored || stored.session.phase !== "challenge") return;
	const session = stored.session;
	requireOriginatingAdministrator(session.initiatingAdminId, adminId);
	if (session.expiresAt <= Date.now()) {
		await deleteProof(ctx, session.connectionId);
		await clearSession(ctx, stored.revision);
		throw new StoreConnectError("challenge_expired");
	}
	if (session.nextPoll > Date.now()) return;
	const pollRevision = await saveSession(ctx, { ...session, nextPoll: session.expiresAt }, stored.revision);
	const reserved = await readSession(ctx);
	if (!reserved || reserved.session.phase !== "challenge" || reserved.session.connectionId !== session.connectionId || reserved.session.initiatingAdminId !== session.initiatingAdminId) return;
	const activeRevision = pollRevision ?? reserved.revision;
	let terminal = false;
	try {
		const { response, body } = await fetchJson(ctx, WEBSITE + "/api/store-connections/token", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_id: STORE_CONNECT_CLIENT_ID, connection_id: session.connectionId, code_verifier: session.codeVerifier }),
		});
		if (!response.ok) {
			const pending = tokenPendingSchema.safeParse(body);
			if (pending.success) {
				await saveSession(ctx, { ...session, nextPoll: Date.now() + session.interval }, activeRevision);
				return;
			}
			const failure = tokenFailureSchema.safeParse(body);
			if (failure.success && failure.data.error === "slow_down") {
				const nextInterval = session.interval + 5000;
				await saveSession(ctx, { ...session, interval: nextInterval, nextPoll: Date.now() + nextInterval }, activeRevision);
				return;
			}
			if (failure.success && ["access_denied", "expired_token", "invalid_grant", "already_redeemed", "proof_mismatch", "ownership_conflict"].includes(failure.data.error)) {
				terminal = true;
				await deleteProof(ctx, session.connectionId);
				await clearSession(ctx, activeRevision);
				if (failure.data.error === "already_redeemed") throw new StoreConnectError("unexpected_website_response");
				return;
			}
			throw new StoreConnectError("unexpected_website_response");
		}
		const token = tokenSuccessSchema.parse(body);
		if (token.site_id !== session.siteId) throw new StoreConnectError("unexpected_website_response");
		terminal = true;
		await saveSession(ctx, { phase: "token", token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 }, activeRevision);
		await deleteProof(ctx, session.connectionId);
	} catch (error) {
		if (!terminal) {
			try {
				await saveSession(ctx, { ...session, nextPoll: Date.now() + session.interval }, activeRevision);
			} catch {
				// Ignore CAS failure if session was replaced or cleared concurrently
			}
		}
		throw error;
	}
}

async function executeAdjustmentConfirm(
	ctx: PluginContext,
	adminId: string,
	token: string,
	targetCommandId: unknown,
): Promise<BlockResponse> {
	if (typeof targetCommandId !== "string" || targetCommandId.trim() === "") {
		return render(ctx, adminId);
	}

	const intentRecord = await ctx.kv.getVersioned<unknown>("state:stock-adjustment-intent");
	if (!intentRecord) return render(ctx, adminId);
	const intentParsed = adjustmentIntentSchema.safeParse(intentRecord.value);
	if (!intentParsed.success) return render(ctx, adminId);
	const intent = intentParsed.data;

	if (intent.status !== "preview" && intent.status !== "pending") {
		return render(ctx, adminId);
	}

	if (intent.command.commandId !== targetCommandId) {
		return render(ctx, adminId);
	}

	let capturedRevision: string | null = null;
	let frozenIntent: { preview: AdjustmentPreview; command: StockCommand; expiresAt: number };

	if (intent.status === "preview") {
		if (intent.expiresAt <= Date.now()) {
			await ctx.kv.compareAndDelete("state:stock-adjustment-intent", intentRecord.revision);
			return notice("Preview expired", "The adjustment preview has expired. Please prepare the adjustment again.");
		}
		const pendingIntent: AdjustmentIntent = {
			status: "pending",
			preview: intent.preview,
			command: intent.command,
			expiresAt: intent.expiresAt,
		};
		const casResult = await ctx.kv.compareAndSet("state:stock-adjustment-intent", intentRecord.revision, pendingIntent);
		if (!casResult.applied) {
			// CAS failed: concurrent modification! Do not send to service.
			return render(ctx, adminId);
		}
		capturedRevision = (casResult as { applied: boolean; revision?: string | null }).revision ?? null;
		frozenIntent = pendingIntent;
	} else {
		capturedRevision = intentRecord.revision;
		frozenIntent = intent;
	}

	let confirmRes: { response: Response; body: unknown };
	try {
		confirmRes = await fetchJson(ctx, SERVICE + "/v1/stock/adjust/confirm", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"X-Inventory-Site": await siteId(ctx),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				confirmation: frozenIntent.preview.confirmation.value,
				command: frozenIntent.command,
			}),
		});
	} catch (_error) {
		// Network transport error or unavailable service:
		// Preserve pending intent in KV for safe idempotent retry!
		return render(ctx, adminId);
	}

	const { response, body } = confirmRes;

	// Confirm-specific response parser:
	// 1. Consume matching canonical authoritative outcomes (committed at 200, rejected at 409)
	const canonicalResult = canonicalStockAdjustmentResultSchema.safeParse(body);
	if (canonicalResult.success) {
		const res = canonicalResult.data;
		// Must strictly match the frozen commandId before terminalizing!
		if (res.commandId !== frozenIntent.command.commandId) {
			// Foreign command evidence: preserve pending intent!
			return render(ctx, adminId);
		}

		if (res.outcome === "committed") {
			const committedIntent: AdjustmentIntent = {
				status: "committed",
				commandId: res.commandId,
				receipt: {
					receiptId: res.receipt.receiptId,
					committedAt: res.receipt.committedAt,
				},
			};
			if (capturedRevision) {
				await ctx.kv.compareAndSet("state:stock-adjustment-intent", capturedRevision, committedIntent);
			}
			return await render(ctx, adminId);
		} else {
			// Canonical rejected outcome (e.g. stale_version, command_id_conflict, etc.)
			const rejectedIntent: AdjustmentIntent = {
				status: "rejected",
				commandId: res.commandId,
				code: res.code,
				message: res.message,
			};
			if (capturedRevision) {
				await ctx.kv.compareAndSet("state:stock-adjustment-intent", capturedRevision, rejectedIntent);
			}
			return await render(ctx, adminId);
		}
	}

	// 2. Non-canonical result or error response:
	if (!response.ok) {
		// Check for true confirmation failures
		const parsedError = z.object({ error: z.string(), message: z.string().optional() }).safeParse(body);
		if (parsedError.success && CONFIRMATION_FAILURE_CODES.has(parsedError.data.error)) {
			const rejectedIntent: AdjustmentIntent = {
				status: "rejected",
				commandId: frozenIntent.command.commandId,
				code: parsedError.data.error,
				message: parsedError.data.message,
			};
			if (capturedRevision) {
				await ctx.kv.compareAndSet("state:stock-adjustment-intent", capturedRevision, rejectedIntent);
			}
			return await render(ctx, adminId);
		}

		// Non-authoritative access/readiness/transport/malformed errors:
		// (e.g. inventory_not_ready, unauthorized_context, unauthorized, invalid_request, request_too_large, 500, 503)
		// These do not resolve the original outcome!
		// Preserve pending intent and captured revision for safe retry.
		return render(ctx, adminId);
	}

	// Unexpected 2xx response not conforming to canonical result: preserve pending!
	return render(ctx, adminId);
}

async function render(ctx: PluginContext, adminId: string): Promise<BlockResponse> {
	const stored = await readSession(ctx);
	if (!stored || stored.session.expiresAt <= Date.now()) {
		if (stored?.session.phase === "challenge") await deleteProof(ctx, stored.session.connectionId);
		return page([
			{ type: "section", text: "Connect Inventory, then sign in or create your DinkusKit account and approve this site. Your stock stays in one Inventory operation." },
			trial,
			button("connect", "Connect Inventory"),
		]);
	}
	const session = stored.session;
	if (session.phase === "challenge") {
		if (session.initiatingAdminId !== adminId) {
			return page([
				{ type: "banner", variant: "alert", title: "Connect already started", description: "Another site administrator started this connection. The originating administrator must finish or let it expire." },
				button("refresh", "Check status"),
			]);
		}
		return page([
			{ type: "section", text: "Sign in or create your DinkusKit account, then explicitly approve this site for Inventory." },
			{ type: "actions", elements: [{ type: "link", label: "Approve this site", target: { kind: "external", url: session.verificationUri } }] },
			button("check_sign_in", "I’ve approved this site — continue"),
			{ type: "context", text: "Waiting for explicit merchant consent. Stock has not been provisioned yet. After approval you return to Inventory." },
		]);
	}

	// Check for active stock adjustment intent first
	const intentRaw = await ctx.kv.getVersioned<unknown>("state:stock-adjustment-intent");
	if (intentRaw) {
		const intentParsed = adjustmentIntentSchema.safeParse(intentRaw.value);
		if (intentParsed.success) {
			const intent = intentParsed.data;
			if (intent.status === "preview") {
				if (intent.expiresAt <= Date.now()) {
					await ctx.kv.compareAndDelete("state:stock-adjustment-intent", intentRaw.revision);
				} else {
					const p = intent.preview;
					const deltaSign = Number(p.effect.onHandDelta.value) > 0 ? `+${p.effect.onHandDelta.value}` : p.effect.onHandDelta.value;
					const blocks: Block[] = [
						{
							type: "banner",
							variant: "alert",
							title: `Confirm Stock Adjustment: ${deltaSign} ${p.effect.onHandDelta.unit}`,
							description: `SKU: ${p.effect.skuId} | Location: ${p.context.locationId} | Note: ${p.reason.note}`,
						},
						{
							type: "section",
							text: `On Hand: ${p.effect.balanceBefore.onHand.value} -> ${p.effect.balanceAfter.onHand.value} ${p.effect.onHandDelta.unit} | Available: ${p.effect.balanceBefore.available.value} -> ${p.effect.balanceAfter.available.value} ${p.effect.onHandDelta.unit}`,
						},
					];
					if (p.warnings.length > 0) {
						blocks.push({
							type: "banner",
							variant: "alert",
							title: "Oversell Warning",
							description: p.warnings[0].message,
						});
					}
					blocks.push({
						type: "actions",
						elements: [
							{ type: "button", action_id: "confirm_adjustment", label: "Confirm stock adjustment", value: intent.command.commandId },
							{ type: "button", action_id: "cancel_adjustment", label: "Cancel", value: intent.command.commandId },
						],
					});
					return page(blocks);
				}
			} else if (intent.status === "pending") {
				return page([
					{
						type: "banner",
						variant: "alert",
						title: "Adjustment outcome unknown / pending",
						description: `Command ${intent.command.commandId} was sent but the network outcome is unconfirmed. Retry safely to resolve the original command without double-adjusting.`,
					},
					button("retry_adjustment", "Retry adjustment", intent.command.commandId),
				]);
			} else if (intent.status === "committed") {
				return page([
					{
						type: "banner",
						title: "Stock adjustment committed",
						description: `Receipt: ${intent.receipt.receiptId}. Committed at: ${intent.receipt.committedAt}.`,
					},
					button("clear_adjustment_result", "Adjust stock again", intent.commandId),
					button("refresh", "Refresh Inventory"),
				]);
			} else if (intent.status === "rejected") {
				return page([
					{
						type: "banner",
						variant: "alert",
						title: "Stock adjustment rejected",
						description: `Rejected code: ${intent.code}.`,
					},
					button("clear_adjustment_result", "Adjust stock again", intent.commandId),
					button("refresh", "Refresh Inventory"),
				]);
			}
		}
	}

	const result = statusSchema.parse(await api(ctx, session.token, "/v1/status"));
	if (result.status === "unconnected") {
		const saved = await ctx.kv.get<unknown>("state:connection-intent");
		if (saved) return page([{ type: "banner", variant: "alert", title: "Connection outcome unknown", description: "Check or retry the original connection. Its Inventory operation will be preserved." }, button("retry", "Retry connection")]);
		const { operations } = z.object({ operations: z.array(operationSchema) }).parse(await api(ctx, session.token, "/v1/operations"));
		const blocks: Block[] = [trial, { type: "form", block_id: "first-location", fields: [{ type: "text_input", action_id: "location_name", label: "Name your first stock location" }], submit: { label: "Create Inventory", action_id: "create" } }];
		if (operations.length) blocks.push({ type: "form", block_id: "existing-operation", fields: [{ type: "select", action_id: "operation_id", label: "Connect an existing Inventory operation", options: operations.map(op => ({ label: `${op.locationName} (${op.status})`, value: op.operationId })) }], submit: { label: "Connect selected operation", action_id: "reconnect" } });
		return page(blocks);
	}
	if (result.status === "pending") return page([{ type: "banner", variant: "alert", title: "Inventory provisioning pending", description: "The outcome is not confirmed. Retry safely to check the same operation." }, button("retry", "Retry provisioning")]);
	if (result.status === "failed") return notice("Inventory setup failed", `Provisioning was rejected (${result.operation.failureCode}). Your original operation is preserved. Contact DinkusKit support.`);

	const locations = z.object({ locations: z.array(z.object({ name: z.string(), locationId: id })) }).parse(await api(ctx, session.token, "/v1/locations"));
	if (locations.locations.length === 0) {
		return page([{ type: "banner", title: "Inventory connected", description: "No stock locations found." }, button("refresh", "Refresh Inventory")]);
	}

	const selectedLocId = await ctx.kv.get<string>("state:selected-location");
	const selectedSkuId = await ctx.kv.get<string>("state:selected-sku");
	const activeLocation = locations.locations.find(l => l.locationId === selectedLocId) ?? locations.locations[0];

	let stockBalance: {
		onHand: string;
		reserved: string;
		outgoingTransferCommitted: string;
		available: string;
		expected: string;
		inTransit: string;
		version: string;
	} | null = null;

	if (selectedSkuId && activeLocation) {
		try {
			const stockRes = await api(ctx, session.token, `/v1/stock?sku_id=${encodeURIComponent(selectedSkuId)}&location_id=${encodeURIComponent(activeLocation.locationId)}`);
			const parsedStock = z.object({
				ok: z.literal(true),
				balance: z.discriminatedUnion("outcome", [
					z.object({
						outcome: z.literal("found"),
						balance: z.object({
							onHand: z.object({ value: z.string(), unit: z.string() }),
							reserved: z.object({ value: z.string(), unit: z.string() }),
							outgoingTransferCommitted: z.object({ value: z.string(), unit: z.string() }).optional(),
							available: z.object({ value: z.string(), unit: z.string() }),
							expected: z.object({ value: z.string(), unit: z.string() }).optional(),
							inTransit: z.object({ value: z.string(), unit: z.string() }).optional(),
							version: z.string(),
							hasStockHistory: z.boolean(),
						}),
					}),
					z.object({ outcome: z.literal("not_found") }),
				]),
			}).safeParse(stockRes);
			if (parsedStock.success && parsedStock.data.balance.outcome === "found" && parsedStock.data.balance.balance.hasStockHistory) {
				const b = parsedStock.data.balance.balance;
				stockBalance = {
					onHand: `${b.onHand.value} ${b.onHand.unit}`,
					reserved: `${b.reserved.value} ${b.reserved.unit}`,
					outgoingTransferCommitted: `${b.outgoingTransferCommitted?.value ?? "0"} ${b.onHand.unit}`,
					available: `${b.available.value} ${b.available.unit}`,
					expected: `${b.expected?.value ?? "0"} ${b.onHand.unit}`,
					inTransit: `${b.inTransit?.value ?? "0"} ${b.onHand.unit}`,
					version: b.version,
				};
			}
		} catch {
			// Stock endpoint unavailable or uninitialized
		}
	}

	const blocks: Block[] = [
		{ type: "banner", title: "Inventory connected", description: "Your Inventory operation is ready." },
		{ type: "section", text: `Active stock locations: ${locations.locations.map(l => l.name).join(", ")}` },
	];

	blocks.push({
		type: "form",
		block_id: "select-stock-view",
		fields: [
			{
				type: "text_input",
				action_id: "location_id",
				label: `Select Location ID (${locations.locations.map(l => `${l.name}: ${l.locationId}`).join("; ")})`,
				initial_value: activeLocation ? activeLocation.locationId : "",
			},
			{
				type: "text_input",
				action_id: "sku_id",
				label: "Inventory SKU ID",
				initial_value: selectedSkuId ?? "",
			},
		],
		submit: { label: "View stock", action_id: "select_stock" },
	});

	if (selectedSkuId && activeLocation) {
		if (stockBalance) {
			blocks.push({
				type: "section",
				text: `Canonical Stock for SKU ${selectedSkuId} at ${activeLocation.name}: On-Hand: ${stockBalance.onHand} | Reserved: ${stockBalance.reserved} | Available: ${stockBalance.available} | Outgoing Transfer: ${stockBalance.outgoingTransferCommitted} | Expected: ${stockBalance.expected} | In-Transit: ${stockBalance.inTransit} (v${stockBalance.version})`,
			});
			blocks.push({
				type: "form",
				block_id: "adjust-stock",
				fields: [
					{ type: "text_input", action_id: "location_id", label: "Location ID", initial_value: activeLocation.locationId },
					{ type: "text_input", action_id: "sku_id", label: "SKU ID", initial_value: selectedSkuId },
					{ type: "text_input", action_id: "delta_value", label: "Signed quantity delta (e.g. -2 or 5)" },
					{ type: "text_input", action_id: "note", label: "Reason note" },
				],
				submit: { label: "Preview stock adjustment", action_id: "preview_adjustment" },
			});
		} else {
			blocks.push({
				type: "context",
				text: `No stock balance found for SKU "${selectedSkuId}" at ${activeLocation.name}. Set Initial Stock to begin stock adjustments.`,
			});
		}
	}
	blocks.push(button("refresh", "Refresh Inventory"));
	return page(blocks);
}

async function handleAdmin(routeCtx: { input: unknown; user?: { id?: string } }, ctx: PluginContext): Promise<BlockResponse> {
	let adminId: string;
	try { adminId = requireBoundAdministrator(routeCtx.user); }
	catch { return notice("Administrator required", "Connect requires a signed-in site administrator. Reload Inventory from the EmDash admin."); }
	const parsed = interactionSchema.safeParse(routeCtx.input);
	if (!parsed.success) return notice("Invalid Inventory action", "Reload Inventory and try again.");
	let activeRequestId: string | null = null;
	try {
		const interaction = parsed.data;
		if (interaction.type === "page_load" || (interaction.type === "block_action" && interaction.action_id === "refresh")) {
			const stored = await readSession(ctx);
			if (stored?.session.phase === "challenge" && stored.session.initiatingAdminId === adminId) await pollStoreConnect(ctx, adminId);
		}
		if (interaction.type === "block_action" && interaction.action_id === "connect") await startStoreConnect(ctx, adminId);
		if (interaction.type === "block_action" && interaction.action_id === "check_sign_in") await pollStoreConnect(ctx, adminId);

		// Handle explicit stock view selection
		if (interaction.type === "form_submit" && interaction.action_id === "select_stock") {
			await setKvKey(ctx, "state:selected-location", interaction.values.location_id);
			await setKvKey(ctx, "state:selected-sku", interaction.values.sku_id);
			return await render(ctx, adminId);
		}

		// Handle preview stock adjustment form submission
		if (interaction.type === "form_submit" && interaction.action_id === "preview_adjustment") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);

			// Check if an adjustment is already pending
			const existingIntentRecord = await ctx.kv.getVersioned<unknown>("state:stock-adjustment-intent");
			if (existingIntentRecord) {
				const existingParsed = adjustmentIntentSchema.safeParse(existingIntentRecord.value);
				if (existingParsed.success && existingParsed.data.status === "pending") {
					return notice("Adjustment pending", "An adjustment is currently pending confirmation. Resolve or retry the pending adjustment first.");
				}
			}

			const locId = interaction.values.location_id ?? (await ctx.kv.get<string>("state:selected-location"));
			if (!locId) return notice("Location required", "Explicit active stock location is required.");

			const locationsData = z.object({ locations: z.array(z.object({ name: z.string(), locationId: id })) }).parse(await api(ctx, stored.session.token, "/v1/locations"));
			const targetLocation = locationsData.locations.find(l => l.locationId === locId);
			if (!targetLocation) return notice("Location not found", "The selected location is not active in this inventory operation.");

			await setKvKey(ctx, "state:selected-location", locId);
			await setKvKey(ctx, "state:selected-sku", interaction.values.sku_id);

			let previewRaw: unknown;
			try {
				previewRaw = await api(ctx, stored.session.token, "/v1/stock/adjust/preview", {
					locationId: locId,
					skuId: interaction.values.sku_id,
					delta: { value: interaction.values.delta_value, unit: "each" },
					reason: { note: interaction.values.note },
				});
			} catch (err) {
				if (err instanceof InventoryApiError && err.code === "opening_balance_required") {
					return notice("Opening balance required", "Set Initial Stock before making a stock adjustment.");
				}
				throw err;
			}
			const preview = adjustmentPreviewSchema.parse(previewRaw);
			const commandId = crypto.randomUUID();
			const command: StockCommand = {
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.adjust",
				context: {
					siteId: await siteId(ctx),
					poolId: preview.context.poolId,
					locationId: preview.context.locationId,
				},
				payload: {
					skuId: preview.effect.skuId,
					delta: preview.effect.onHandDelta,
				},
				reason: preview.reason,
				references: preview.references,
				expectedVersions: [
					{
						skuId: preview.effect.skuId,
						locationId: preview.context.locationId,
						version: preview.effect.balanceBefore.version,
					},
				],
			};
			const intent: AdjustmentIntent = {
				status: "preview",
				preview,
				command,
				expiresAt: Date.parse(preview.confirmation.expiresAt),
			};
			const latestIntent = await ctx.kv.getVersioned<unknown>("state:stock-adjustment-intent");
			if (latestIntent) {
				const latestParsed = adjustmentIntentSchema.safeParse(latestIntent.value);
				if (latestParsed.success && latestParsed.data.status === "pending") {
					return notice("Adjustment pending", "An adjustment is currently pending confirmation.");
				}
				await ctx.kv.compareAndSet("state:stock-adjustment-intent", latestIntent.revision, intent);
			} else {
				await ctx.kv.compareAndSet("state:stock-adjustment-intent", null, intent);
			}
			return await render(ctx, adminId);
		}

		// Handle confirm stock adjustment action
		if (interaction.type === "block_action" && interaction.action_id === "confirm_adjustment") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);
			return executeAdjustmentConfirm(ctx, adminId, stored.session.token, interaction.value);
		}

		// Handle retry stock adjustment action
		if (interaction.type === "block_action" && interaction.action_id === "retry_adjustment") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);
			return executeAdjustmentConfirm(ctx, adminId, stored.session.token, interaction.value);
		}

		// Handle cancel adjustment (only cancels unsubmitted preview)
		if (interaction.type === "block_action" && interaction.action_id === "cancel_adjustment") {
			if (typeof interaction.value !== "string" || interaction.value.trim() === "") {
				return render(ctx, adminId);
			}
			const intentRecord = await ctx.kv.getVersioned<unknown>("state:stock-adjustment-intent");
			if (!intentRecord) return render(ctx, adminId);
			const intentParsed = adjustmentIntentSchema.safeParse(intentRecord.value);
			if (!intentParsed.success || intentParsed.data.status !== "preview") {
				return render(ctx, adminId);
			}
			if (intentParsed.data.command.commandId !== interaction.value) {
				return render(ctx, adminId);
			}
			await ctx.kv.compareAndDelete("state:stock-adjustment-intent", intentRecord.revision);
			return await render(ctx, adminId);
		}

		// Handle clear adjustment result (only clears committed or rejected terminal state)
		if (interaction.type === "block_action" && interaction.action_id === "clear_adjustment_result") {
			if (typeof interaction.value !== "string" || interaction.value.trim() === "") {
				return render(ctx, adminId);
			}
			const intentRecord = await ctx.kv.getVersioned<unknown>("state:stock-adjustment-intent");
			if (!intentRecord) return render(ctx, adminId);
			const intentParsed = adjustmentIntentSchema.safeParse(intentRecord.value);
			if (!intentParsed.success || (intentParsed.data.status !== "committed" && intentParsed.data.status !== "rejected")) {
				return render(ctx, adminId);
			}
			if (intentParsed.data.commandId !== interaction.value) {
				return render(ctx, adminId);
			}
			await ctx.kv.compareAndDelete("state:stock-adjustment-intent", intentRecord.revision);
			return await render(ctx, adminId);
		}

		if (interaction.type === "form_submit" || (interaction.type === "block_action" && interaction.action_id === "retry")) {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);
			let intent = await ctx.kv.get<unknown>("state:connection-intent");
			if (interaction.type === "form_submit") {
				const candidate = interaction.action_id === "create" ? { type: "create", requestId: crypto.randomUUID(), locationName: interaction.values.location_name } : { type: "reconnect", requestId: crypto.randomUUID(), operationId: interaction.values.operation_id };
				if (!intent) { await ctx.kv.compareAndSet("state:connection-intent", null, candidate); intent = await ctx.kv.get("state:connection-intent"); }
				else {
					const previous = intentSchema.parse(intent);
					if (previous.type !== candidate.type || JSON.stringify({ ...previous, requestId: "" }) !== JSON.stringify({ ...candidate, requestId: "" })) return notice("Connection already started", "Use Retry to resolve your original connection before changing the setup.");
				}
			} else if (!intent) {
				const result = statusSchema.parse(await api(ctx, stored.session.token, "/v1/status"));
				if (result.status === "unconnected") return render(ctx, adminId);
				await ctx.kv.compareAndSet("state:connection-intent", null, { type: "reconnect", requestId: crypto.randomUUID(), operationId: result.operation.operationId });
				intent = await ctx.kv.get("state:connection-intent");
			}
			const frozen = intentSchema.parse(intent);
			activeRequestId = frozen.requestId;
			await api(ctx, stored.session.token, "/v1/connect", frozen);
		}
		return await render(ctx, adminId);
	} catch (error) {
		if (error instanceof StoreConnectError) {
			if (error.code === "wrong_originating_admin" || error.code === "connection_in_progress") {
				return notice("Connect already started", "Only the originating site administrator can continue this connection. Wait for it to finish or expire.");
			}
			if (error.code === "unbound_administrator") return notice("Administrator required", "Connect requires a signed-in site administrator.");
			if (error.code === "invalid_site_origin") return notice("Site origin unavailable", "Inventory could not use the host-configured site address. Reload Inventory or ask DinkusKit support.");
			if (error.code === "challenge_expired") return notice("Connection expired", "Start Connect again. No Inventory operation was created.");
			return page([{ type: "banner", variant: "alert", title: "Connection could not be confirmed", description: "Account or Inventory service is unavailable. Reload or retry safely; your original connection is preserved." }, button("refresh", "Check status"), button("retry", "Retry connection")]);
		}
		if (error instanceof InventoryApiError) {
			if (error.code === "operation_not_found") {
				const saved = await ctx.kv.getVersioned<unknown>("state:connection-intent");
				if (saved && intentSchema.parse(saved.value).requestId === activeRequestId) await ctx.kv.compareAndDelete("state:connection-intent", saved.revision);
				return notice("Operation unavailable", "The selected operation is not owned by this account. Reload Inventory to select an owned operation or create a new one.");
			}
			if (error.code === "opening_balance_required") {
				return notice("Opening balance required", "Set Initial Stock before making a stock adjustment.");
			}
			if (error.code === "stale_version") {
				return notice("Version changed", "Stock balance version changed. Reload Inventory to preview again.");
			}
			if (error.code === "confirmation_expired") {
				return notice("Confirmation expired", "Adjustment confirmation expired. Prepare a new adjustment.");
			}
			if (error.code === "command_id_conflict") {
				return notice("Command conflict", "Adjustment command ID was previously used with different parameters.");
			}
			return notice("Connection request rejected", "This site already has a different connection or the original request was changed. Reload Inventory to inspect its current status.");
		}
		if (error instanceof Error && error.message === "sign_in_required") {
			const stored = await readSession(ctx);
			if (stored) await ctx.settings.compareAndDelete("connectionSession", stored.revision);
			return notice("Sign in again", "Your Inventory operation is preserved. Reload Inventory to reconnect your account.");
		}
		return page([{ type: "banner", variant: "alert", title: "Connection could not be confirmed", description: "Account or Inventory service is unavailable. Reload or retry safely; your original connection is preserved." }, button("refresh", "Check status"), button("retry", "Retry connection")]);
	}
}

const plugin: SandboxedPlugin = { routes: {
	admin: {
		permission: "plugins:manage",
		handler: async (routeCtx, ctx) => handleAdmin(routeCtx, ctx),
	},
	"store-proof": {
		public: true,
		methods: ["GET"],
		response: "raw",
		cacheControl: "no-store",
		handler: async (routeCtx, ctx) => {
			const connectionId = z.object({ connection_id: z.string().trim().min(1).max(200) }).safeParse(routeCtx.input);
			if (!connectionId.success) {
				return pluginResponse({ status: 404, headers: { "content-type": "application/json" }, body: { kind: "text", value: JSON.stringify({ error: "not_found" }) } });
			}
			const receipt = await readProof(ctx, connectionId.data.connection_id);
			const active = await inspectSession(ctx);
			// Receipt creation precedes session CAS. Only the winning active transaction
			// may publish, including while concurrent starts are still in progress.
			const bound = receipt && active?.phase === "challenge"
				&& active.connectionId === receipt.connection_id
				&& active.challenge === receipt.challenge
				&& active.siteId === receipt.site_id
				&& active.siteOrigin === receipt.site_origin
				&& active.callbackUri === receipt.callback_uri
				&& active.codeChallenge === receipt.code_challenge
				&& active.expiresAt === receipt.expires_at;
			const published = bound ? publicProofFor(receipt, connectionId.data.connection_id, Date.now()) : null;
			if (!published) {
				return pluginResponse({ status: 404, headers: { "content-type": "application/json" }, body: { kind: "text", value: JSON.stringify({ error: "not_found" }) } });
			}
			return pluginResponse({
				status: 200,
				headers: { "content-type": "application/json" },
				body: { kind: "text", value: JSON.stringify(published) },
			});
		},
	},
} };
export default plugin;
