import type { SandboxedPlugin } from "emdash/plugin";
import { pluginResponse } from "emdash/plugin";
import type { PluginContext } from "emdash";
import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import * as z from "zod/mini";
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
const LOC_MOVE_KEY = "state:location-move-intent";
const ADJ_KEY = "state:stock-adjustment-intent";
const OPEN_KEY = "state:opening-balance-intent";
const SKU_REG_KEY = "state:sku-registration-intent";
const CONN_INTENT_KEY = "state:connection-intent";
const CMD_SCHEMA = "dinkuskit.inventory.command/v1";
const APP_JSON = "application/json";


// Reserved non-routable defaults until DinkusKit configures the website and Inventory service.
// The proof host maps these declared origins to local fixtures; shop owners never configure them.
const SERVICE = "https://inventory.dinkuskit.invalid";
const WEBSITE = "https://accounts.dinkuskit.invalid";
const id = z.string().check(z.minLength(1), z.maxLength(200));
const qty = z.object({ value: z.string(), unit: z.string() });
const locationsSchema = z.object({ locations: z.array(z.object({ name: z.string(), locationId: id })) });
const cmdContext = z.object({ siteId: z.string(), poolId: z.string(), locationId: z.string() });
const cmdRefs = z._default(z.array(z.object({ kind: z.string(), id: z.string() })), []);
const cmdExpected = z.array(z.object({ skuId: z.string(), locationId: z.string(), version: z.string() }));
const cmdReason = z.object({ code: z.string(), note: z.string() });
const cmdConfirm = z.object({ value: z.string(), expiresAt: z.string() });
const receiptSchema = z.object({ receiptId: z.string(), committedAt: z.string() });


const intentSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("create"), requestId: id, locationName: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)) }),
	z.strictObject({ type: z.literal("reconnect"), requestId: id, operationId: id }),
]);
const operationSchema = z.object({ operationId: id, poolId: id, locationName: z.string(), locationId: z.nullable(z.string()), status: z.enum(["pending", "ready", "failed"]), failureCode: z.nullable(z.string()) });
const statusSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("unconnected") }), z.object({ status: z.enum(["pending", "ready", "failed"]), operation: operationSchema })]);
const managedSkuIdentitySchema = z.strictObject({ inventorySkuId: id, sku: z.string(), displayName: z.string() });
const managedSkuSchema = z.extend(managedSkuIdentitySchema, { unit: z.literal("each") });
const managedSkuListSchema = z.strictObject({ skus: z.array(managedSkuSchema) });
type Session = StoreConnectSession;

class InventoryApiError extends Error {
	code: string;
	constructor(code: string) { super("Inventory request rejected"); this.code = code; }
}

const previewEffectBalanceSchema = z.object({ onHand: qty, reserved: qty, available: qty, version: z.string() });

const adjustmentWarningSchema = z.object({ code: z.literal("negative_available"), reserved: qty, oversoldBy: qty, message: z.string() });

const adjustmentPreviewSchema = z.strictObject({
	schema: z.literal("dinkuskit.inventory.stock-adjustment-preview/v1"),
	type: z.literal("stock.adjust"),
	context: z.strictObject({
		siteId: z.string(),
		poolId: z.string(),
		locationId: z.string(),
	}),
	effect: z.strictObject({
		skuId: z.string(),
		locationId: z.string(),
		onHandDelta: qty,
		reservedDelta: qty,
		balanceBefore: previewEffectBalanceSchema,
		balanceAfter: previewEffectBalanceSchema,
	}),
	reason: z.strictObject({ note: z.string() }),
	references: z._default(z.array(z.strictObject({ kind: z.string(), id: z.string() })), []),
	warnings: z._default(z.array(adjustmentWarningSchema), []),
	confirmation: z.strictObject({
		value: z.string(),
		expiresAt: z.string(),
	}),
});

type AdjustmentPreview = z.infer<typeof adjustmentPreviewSchema>;

const stockCommandSchema = z.strictObject({
	schema: z.literal(CMD_SCHEMA),
	commandId: z.string(),
	type: z.literal("stock.adjust"),
	context: z.strictObject({
		siteId: z.string(),
		poolId: z.string(),
		locationId: z.string(),
	}),
	payload: z.object({
		skuId: z.string(),
		delta: z.strictObject({ value: z.string(), unit: z.string() }),
	}),
	reason: z.strictObject({ note: z.string() }),
	references: z._default(z.array(z.strictObject({ kind: z.string(), id: z.string() })), []),
	expectedVersions: z.array(z.strictObject({
		skuId: z.string(),
		locationId: z.string(),
		version: z.string(),
	})).check(z.minLength(1)),
});

type StockCommand = z.infer<typeof stockCommandSchema>;

const adjustmentIntentSchema = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("preview"),
		initiatingAdminId: id,
		preview: adjustmentPreviewSchema,
		command: stockCommandSchema,
		expiresAt: z.number(),
	}),
	z.strictObject({
		status: z.literal("pending"),
		initiatingAdminId: id,
		preview: adjustmentPreviewSchema,
		command: stockCommandSchema,
		expiresAt: z.number(),
	}),
	z.strictObject({
		status: z.literal("committed"),
		initiatingAdminId: id,
		commandId: z.string(),
		receipt: z.object({
			receiptId: z.string(),
			committedAt: z.string(),
		}),
	}),
	z.strictObject({
		status: z.literal("rejected"),
		initiatingAdminId: id,
		commandId: z.string(),
		code: z.string(),
		message: z.optional(z.string()),
	}),
]);

type AdjustmentIntent = z.infer<typeof adjustmentIntentSchema>;

const openingEffectBalanceSchema = z.strictObject({
 ...previewEffectBalanceSchema.shape,
 outgoingTransferCommitted: z.object({ value: z.string(), unit: z.string() }),
 expected: z.object({ value: z.string(), unit: z.string() }),
 inTransit: z.object({ value: z.string(), unit: z.string() }),
});
const openingPreviewSchema = z.extend(z.omit(adjustmentPreviewSchema, { warnings: true }), {
 schema: z.literal("dinkuskit.inventory.opening-balance-preview/v1"),
 type: z.literal("stock.opening_balance"),
 effect: z.extend(adjustmentPreviewSchema.shape.effect, { balanceBefore: openingEffectBalanceSchema, balanceAfter: openingEffectBalanceSchema }),
 reason: z.strictObject({ code: z.string(), note: z.string() }),
 warning: z.string(),
});
type OpeningPreview = z.infer<typeof openingPreviewSchema>;

const openingEligibilitySchema = z.object({
	schema: z.literal("dinkuskit.inventory.opening-balance-eligibility-read-result/v1"),
	key: z.object({ poolId: z.string(), skuId: z.string(), locationId: z.string() }),
	eligibility: z.enum(["eligible", "history_exists"]),
	location: z.object({ locationId: z.string(), status: z.literal("active") }),
	balance: z.nullable(z.catchall(z.extend(openingEffectBalanceSchema, { hasStockHistory: z.boolean() }), z.unknown())),
	hasStockHistory: z.boolean(),
});

const openingCommandSchema = z.extend(stockCommandSchema, {
 type: z.literal("stock.opening_balance"),
 payload: z.strictObject({ skuId: z.string(), quantity: z.strictObject({ value: z.string(), unit: z.string() }) }),
 reason: openingPreviewSchema.shape.reason,
 expectedVersions: stockCommandSchema.shape.expectedVersions.check(z.length(1)),
});
type OpeningCommand = z.infer<typeof openingCommandSchema>;
const openingProgressSchema = z.strictObject({ initiatingAdminId: id, preview: openingPreviewSchema, command: openingCommandSchema, expiresAt: z.number() });
const openingIntentSchema = z.discriminatedUnion("status", [
 z.extend(openingProgressSchema, { status: z.literal("preview") }),
 z.extend(openingProgressSchema, { status: z.literal("pending") }),
 adjustmentIntentSchema.def.options[2],
 adjustmentIntentSchema.def.options[3],
]);
type OpeningIntent = z.infer<typeof openingIntentSchema>;

const registrationBaseSchema = z.object({ initiatingAdminId: id, commandId: id });
const registrationResultBaseSchema = z.object({ schema: z.optional(z.literal("dinkuskit.inventory.command-result/v1")), commandId: id });
const registrationResultSchema = z.discriminatedUnion("outcome", [
 z.extend(registrationResultBaseSchema, { outcome: z.enum(["registered", "existing"]), inventorySku: managedSkuIdentitySchema }),
 z.extend(registrationResultBaseSchema, { outcome: z.literal("rejected"), code: z.string(), message: z.optional(z.string()) }),
]);
const registrationIntentSchema = z.discriminatedUnion("status", [
 z.strictObject({ ...registrationBaseSchema.shape, status: z.literal("pending"), sku: z.string(), displayNameIfNew: z.string() }),
 z.strictObject({ ...registrationBaseSchema.shape, status: z.literal("committed"), inventorySku: managedSkuIdentitySchema }),
 z.strictObject({ ...registrationBaseSchema.shape, status: z.literal("rejected"), code: z.string(), message: z.optional(z.string()) }),
]);
type RegistrationIntent = z.infer<typeof registrationIntentSchema>;

const canonicalStockAdjustmentResultSchema = z.discriminatedUnion("outcome", [
	z.object({
		schema: z.optional(z.literal("dinkuskit.inventory.command-result/v1")),
		outcome: z.literal("committed"),
		commandId: z.string(),
		receipt: receiptSchema,
	}),
	z.object({
		schema: z.optional(z.literal("dinkuskit.inventory.command-result/v1")),
		outcome: z.literal("rejected"),
		commandId: z.string(),
		code: z.string(),
		message: z.optional(z.string()),
	}),
]);

const moveDataSchema = z.object({
	initiatingAdminId: id,
	commandId: id,
	originLocationId: id,
	originLocationName: z.string(),
	destinationLocationId: id,
	destinationLocationName: z.string(),
	skuId: id,
	skuDisplayName: z.string(),
	quantity: qty,
	expiresAt: z.number(),
	transferId: z.optional(z.string()),
	transferVersion: z.optional(z.string()),
});
const locationMoveIntentSchema = z.discriminatedUnion("status", [
	z.extend(moveDataSchema, { status: z.literal("preview") }),
	z.extend(moveDataSchema, { status: z.literal("pending") }),
	z.extend(moveDataSchema, { status: z.literal("committed"), receipt: receiptSchema }),
	adjustmentIntentSchema.def.options[3],
]);
type LocationMoveIntent = z.infer<typeof locationMoveIntentSchema>;

const CONFIRMATION_FAILURE_CODES = new Set([
	"confirmation_expired",
	"confirmation_mismatch",
	"confirmation_already_used",
	"confirmation_not_found",
]);

const interactionSchema = z.union([
	z.object({ type: z.literal("page_load"), page: z.literal("/inventory") }),
	z.object({ type: z.literal("block_action"), action_id: z.string(), block_id: z.optional(z.string()), value: z.optional(z.unknown()) }),
	z.object({ type: z.literal("form_submit"), action_id: z.string(), block_id: z.optional(z.string()), values: z.any() }),
]);

const btn = (action_id: string, label: string, value?: unknown) => ({ type: "button" as const, action_id, label, value: value !== undefined ? value : undefined });
const button = (action_id: string, label: string, value?: unknown): Block => ({ type: "actions", elements: [btn(action_id, label, value)] });
const twoButtons = (a1: string, l1: string, v1: unknown, a2: string, l2: string, v2: unknown): Block => ({ type: "actions", elements: [btn(a1, l1, v1), btn(a2, l2, v2)] });
const terminalPage = (title: string, desc: string, clearAction: string, cmdId: string, alert?: boolean) => page([
	{ type: "banner", ...(alert ? { variant: "alert" } : {}), title, description: desc },
	twoButtons(clearAction, "Back to Inventory", cmdId, "refresh", "Refresh Inventory", undefined),
]);
const selectField = (action_id: string, label: string, options: any[], initial_value?: string) => ({ type: "select" as const, action_id, label, options, initial_value });
const textField = (action_id: string, label: string) => ({ type: "text_input" as const, action_id, label });

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

const apiHeaders = async (ctx: PluginContext, token: string) => ({ Authorization: `Bearer ${token}`, "X-Inventory-Site": await siteId(ctx), "Content-Type": APP_JSON });

async function api(ctx: PluginContext, token: string, path: string, input?: unknown) {
	const { response, body } = await fetchJson(ctx, SERVICE + path, {
		method: input ? "POST" : "GET",
		headers: await apiHeaders(ctx, token),
		body: input ? JSON.stringify(input) : undefined,
	});
	if (!response.ok) {
		if (response.status === 401) throw new Error("sign_in_required");
		const rejected = z.object({ error: z.string(), message: z.optional(z.string()) }).safeParse(body);
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
		method: "POST", headers: { "Content-Type": APP_JSON }, body: JSON.stringify(request),
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
			method: "POST", headers: { "Content-Type": APP_JSON },
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

async function executeStockConfirm(
	ctx: PluginContext,
	adminId: string,
	token: string,
	targetCommandId: unknown,
	type: "adjustment" | "opening",
): Promise<BlockResponse> {
	if (typeof targetCommandId !== "string" || !targetCommandId.trim()) return render(ctx, adminId);
	const key = type === "adjustment" ? ADJ_KEY : OPEN_KEY;
	const schema = type === "adjustment" ? adjustmentIntentSchema : openingIntentSchema;
	const path = type === "adjustment" ? "/v1/stock/adjust/confirm" : "/v1/stock/opening/confirm";
	const record = await ctx.kv.getVersioned<unknown>(key);
	if (!record) return render(ctx, adminId);
	const parsed = schema.safeParse(record.value);
	if (!parsed.success) return render(ctx, adminId);
	const intent = parsed.data as any;
	requireOriginatingAdministrator(intent.initiatingAdminId, adminId);
	if ((intent.status !== "preview" && intent.status !== "pending") || intent.command.commandId !== targetCommandId) return render(ctx, adminId);
	let revision: string | null = record.revision;
	let frozen: any;
	if (intent.status === "preview") {
		if (intent.expiresAt <= Date.now()) {
			await ctx.kv.compareAndDelete(key, record.revision);
			return notice("Preview expired", "The preview has expired. Prepare it again.");
		}
		const pending = { ...intent, status: "pending" };
		const cas = await ctx.kv.compareAndSet(key, record.revision, pending);
		if (!cas.applied) return render(ctx, adminId);
		revision = (cas as { revision?: string }).revision ?? null;
		frozen = pending;
	} else {
		frozen = intent;
	}
	let response: Response;
	let body: unknown;
	try {
		({ response, body } = await fetchJson(ctx, SERVICE + path, {
			method: "POST",
			headers: await apiHeaders(ctx, token),
			body: JSON.stringify({ confirmation: frozen.preview.confirmation.value, command: frozen.command }),
		}));
	} catch {
		return render(ctx, adminId);
	}
	const canonical = canonicalStockAdjustmentResultSchema.safeParse(body);
	if (canonical.success) {
		const res = canonical.data;
		if (res.commandId !== frozen.command.commandId) return render(ctx, adminId);
		if (response.status !== (res.outcome === "committed" ? 200 : 409)) return render(ctx, adminId);
		const terminal = res.outcome === "committed"
			? { status: "committed", initiatingAdminId: frozen.initiatingAdminId, commandId: res.commandId, receipt: { receiptId: res.receipt.receiptId, committedAt: res.receipt.committedAt } }
			: { status: "rejected", initiatingAdminId: frozen.initiatingAdminId, commandId: res.commandId, code: res.code, message: res.message };
		if (revision) await ctx.kv.compareAndSet(key, revision, terminal);
		return await render(ctx, adminId);
	}
	if (response.status === 409) {
		const parsedError = z.object({ error: z.string(), message: z.optional(z.string()) }).safeParse(body);
		if (parsedError.success && CONFIRMATION_FAILURE_CODES.has(parsedError.data.error) && revision) {
			await ctx.kv.compareAndSet(key, revision, {
				status: "rejected", initiatingAdminId: frozen.initiatingAdminId, commandId: frozen.command.commandId, code: parsedError.data.error, message: parsedError.data.message,
			});
		}
	}
	return render(ctx, adminId);
}

const executeAdjustmentConfirm = (ctx: PluginContext, adminId: string, token: string, id: unknown) => executeStockConfirm(ctx, adminId, token, id, "adjustment");
const executeOpeningConfirm = (ctx: PluginContext, adminId: string, token: string, id: unknown) => executeStockConfirm(ctx, adminId, token, id, "opening");

async function executeRegistration(
	ctx: PluginContext,
	adminId: string,
	token: string,
	targetCommandId: string,
): Promise<BlockResponse> {
	const record = await ctx.kv.getVersioned<unknown>(SKU_REG_KEY);
	if (!record) return render(ctx, adminId);
	const parsed = registrationIntentSchema.safeParse(record.value);
	if (!parsed.success || parsed.data.status !== "pending" || parsed.data.commandId !== targetCommandId) return render(ctx, adminId);
	requireOriginatingAdministrator(parsed.data.initiatingAdminId, adminId);
	let response: Response;
	let body: unknown;
	try {
		({ response, body } = await fetchJson(ctx, SERVICE + "/v1/skus/register", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": await siteId(ctx), "Content-Type": APP_JSON },
			body: JSON.stringify({
				commandId: parsed.data.commandId,
				sku: parsed.data.sku,
				displayNameIfNew: parsed.data.displayNameIfNew,
			}),
		}));
	} catch {
		return render(ctx, adminId);
	}
	const canonical = registrationResultSchema.safeParse(body);
	const expectedStatus = canonical.success && canonical.data.outcome === "rejected" ? 409 : 200;
	if (!canonical.success || response.status !== expectedStatus || canonical.data.commandId !== parsed.data.commandId) return render(ctx, adminId);
	const next: RegistrationIntent = canonical.data.outcome === "rejected"
		? { status: "rejected", initiatingAdminId: parsed.data.initiatingAdminId, commandId: canonical.data.commandId, code: canonical.data.code, message: canonical.data.message }
		: { status: "committed", initiatingAdminId: parsed.data.initiatingAdminId, commandId: canonical.data.commandId, inventorySku: canonical.data.inventorySku };
	await ctx.kv.compareAndSet(SKU_REG_KEY, record.revision, next);
	return render(ctx, adminId);
}

async function executeLocationMoveConfirm(ctx: PluginContext, adminId: string, token: string, targetCommandId: unknown): Promise<BlockResponse> {
	if (typeof targetCommandId !== "string" || !targetCommandId.trim()) return render(ctx, adminId);
	const record = await ctx.kv.getVersioned<any>(LOC_MOVE_KEY);
	if (!record) return render(ctx, adminId);
	const parsed = locationMoveIntentSchema.safeParse(record.value);
	if (!parsed.success) return render(ctx, adminId);
	const intent = parsed.data;
	requireOriginatingAdministrator(intent.initiatingAdminId, adminId);
	if ((intent.status !== "preview" && intent.status !== "pending") || intent.commandId !== targetCommandId) return render(ctx, adminId);

	let revision: string | null = record.revision;
	let frozen = intent;
	if (intent.status === "preview") {
		if (intent.expiresAt <= Date.now()) {
			await ctx.kv.compareAndDelete(LOC_MOVE_KEY, record.revision);
			return notice("Preview expired", "The preview expired. Prepare it again.");
		}
		frozen = { ...intent, status: "pending" };
		const cas = await ctx.kv.compareAndSet(LOC_MOVE_KEY, record.revision, frozen);
		if (!cas.applied) return render(ctx, adminId);
		revision = (cas as { revision?: string }).revision ?? null;
	}

	const headers = await apiHeaders(ctx, token);
	const send = async (type: string, suffix: string, payload: any, expectedVersions: any[]) => {
		try {
			const commandId = `${frozen.commandId}:${suffix}`;
			const { response: res, body } = await fetchJson(ctx, SERVICE + "/v1/transfers", {
				method: "POST", headers,
				body: JSON.stringify({ command: { schema: CMD_SCHEMA, commandId, type, payload, references: [], expectedVersions } }),
			});
			const raw = body as { commandId?: string };
			if (raw?.commandId !== commandId) return null;
			return { ok: res.ok, raw: body as any };
		} catch { return null; }
	};

	let tid = frozen.transferId;
	let tver = frozen.transferVersion ?? "1";

	const updateKv = async (val: any) => {
		if (revision) {
			const cas = await ctx.kv.compareAndSet(LOC_MOVE_KEY, revision, val);
			if (cas.applied && cas.revision) revision = cas.revision;
		}
	};
	const fail = async (raw: any, fallback: string) => {
		await updateKv({ status: "rejected", initiatingAdminId: frozen.initiatingAdminId, commandId: frozen.commandId, code: raw?.code ?? fallback, message: raw?.message });
		return render(ctx, adminId);
	};

	if (!tid) {
		const today = new Date().toISOString().slice(0, 10);
		const res = await send("transfer.create", "create", {
			reference: null,
			originLocationId: frozen.originLocationId,
			destinationLocationId: frozen.destinationLocationId,
			lines: [{ skuId: frozen.skuId, quantity: frozen.quantity }],
			note: null,
			expectedDispatchDate: today,
			expectedArrivalDate: today,
		}, []);
		if (!res) return render(ctx, adminId);
		if (!res.ok || res.raw?.outcome === "rejected") return fail(res.raw, "transfer_create_failed");
		tid = res.raw?.transfer?.transferId;
		tver = String(res.raw?.transfer?.version ?? "1");
		if (!tid) return render(ctx, adminId);
		await updateKv({ ...frozen, transferId: tid, transferVersion: tver });
	}

	for (const [step, ver] of [["dispatch", "1"], ["receive", "2"]] as const) {
		if (tver === ver) {
			const res = await send(`transfer.${step}`, step, { transferId: tid }, [{ transferId: tid, version: ver }]);
			if (!res) return render(ctx, adminId);
			if (!res.ok || res.raw?.outcome === "rejected") return fail(res.raw, `transfer_${step}_failed`);
			if (step === "receive") {
				const r = res.raw?.receipt;
				if (r) await updateKv({ ...frozen, status: "committed", receipt: { receiptId: r.receiptId, committedAt: r.committedAt } });
				return render(ctx, adminId);
			}
			tver = String(res.raw?.transfer?.version ?? "2");
			await updateKv({ ...frozen, transferId: tid, transferVersion: tver });
		}
	}
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

	const registrationRaw = await ctx.kv.getVersioned<unknown>(SKU_REG_KEY);
	if (registrationRaw) {
		const registrationParsed = registrationIntentSchema.safeParse(registrationRaw.value);
		if (!registrationParsed.success) return notice("SKU registration requires its originating administrator", "The saved request is invalid. Contact support.");
		const registration = registrationParsed.data;
		if (registration.initiatingAdminId !== adminId) return notice("SKU registration belongs to another administrator", "The originating administrator must resolve this request.");
		if (registration.status === "pending") return page([
			{ type: "banner", variant: "alert", title: "SKU registration outcome unknown / pending", description: `Command ${registration.commandId} has an unconfirmed outcome. Retry safely.` },
			button("retry_registration", "Retry SKU registration", registration.commandId),
		]);
		if (registration.status === "committed") return terminalPage("SKU registered", `${registration.inventorySku.displayName} (${registration.inventorySku.sku}) is registered. Stock was unchanged.`, "clear_registration_result", registration.commandId);
		return terminalPage("SKU registration rejected", `Rejected code: ${registration.code}.`, "clear_registration_result", registration.commandId, true);
	}

	const openingRaw = await ctx.kv.getVersioned<unknown>(OPEN_KEY);
	if (openingRaw) {
		const openingParsed = openingIntentSchema.safeParse(openingRaw.value);
		if (!openingParsed.success) return notice("Opening stock requires its originating administrator", "This opening-stock request is preserved safely.");
		const opening = openingParsed.data;
		if (opening.initiatingAdminId !== adminId) return notice("Opening stock belongs to another administrator", "Only that administrator can change it.");
		if (opening.status === "preview") return page([
			{ type: "banner", variant: "alert", title: "Confirm initial stock", description: `SKU: ${opening.preview.effect.skuId} | Location: ${opening.preview.context.locationId} | On hand: ${opening.preview.effect.onHandDelta.value} ${opening.preview.effect.onHandDelta.unit}` },
			{ type: "section", text: `${opening.preview.warning} Reason: ${opening.preview.reason.note}` },
twoButtons("confirm_opening_balance", "Confirm initial stock", opening.command.commandId, "cancel_opening_balance", "Cancel", opening.command.commandId),
		]);
		if (opening.status === "pending") return page([
			{ type: "banner", variant: "alert", title: "Initial stock outcome unknown / pending", description: `Command ${opening.command.commandId} was sent but the outcome is unconfirmed. Retry the original command safely.` },
			button("retry_opening_balance", "Retry initial stock", opening.command.commandId),
		]);
		if (opening.status === "committed") return terminalPage("Initial stock committed", `Receipt: ${opening.receipt.receiptId}.`, "clear_opening_balance_result", opening.commandId);
		return terminalPage("Initial stock rejected", `Rejected code: ${opening.code}.`, "clear_opening_balance_result", opening.commandId, true);
	}

	const moveRaw = await ctx.kv.getVersioned<any>(LOC_MOVE_KEY);
	if (moveRaw) {
		const moveParsed = locationMoveIntentSchema.safeParse(moveRaw.value);
		if (!moveParsed.success) return notice("Location move requires its originating administrator", "This move is preserved.");
		const move = moveParsed.data;
		if (move.initiatingAdminId !== adminId) return notice("Location move belongs to another administrator", "Only that administrator can change it.");
		if (move.status === "preview") {
			if (move.expiresAt <= Date.now()) {
				await ctx.kv.compareAndDelete(LOC_MOVE_KEY, moveRaw.revision);
				return await render(ctx, adminId);
			}
			return page([
				{ type: "banner", variant: "alert", title: "Confirm location move", description: `SKU: ${move.skuDisplayName} (${move.skuId}) | Quantity: ${move.quantity.value} ${move.quantity.unit}` },
				{ type: "section", text: `Move ${move.quantity.value} ${move.quantity.unit} from ${move.originLocationName} to ${move.destinationLocationName}.` },
				twoButtons("confirm_location_move", "Confirm location move", move.commandId, "cancel_location_move", "Cancel", move.commandId),
			]);
		}
		if (move.status === "pending") return page([
			{ type: "banner", variant: "alert", title: "Location move outcome unknown / pending", description: `Command ${move.commandId} is unconfirmed. Retry.` },
			button("retry_location_move", "Retry move", move.commandId),
		]);
		if (move.status === "committed") return terminalPage("Location move committed", `Moved ${move.quantity.value} ${move.quantity.unit} to ${move.destinationLocationName}. Receipt ${move.receipt.receiptId}.`, "clear_location_move_result", move.commandId);
		return terminalPage("Location move rejected", `Rejected code: ${move.code}. ${move.message ?? ""}`, "clear_location_move_result", move.commandId, true);
	}

	// Check for active stock adjustment intent first
	const intentRaw = await ctx.kv.getVersioned<unknown>(ADJ_KEY);
	if (intentRaw) {
		const intentParsed = adjustmentIntentSchema.safeParse(intentRaw.value);
		if (!intentParsed.success) {
			return notice("Adjustment requires its originating administrator", "This adjustment is preserved safely. The administrator who created it must continue, or support must resolve legacy state.");
		}
		const intent = intentParsed.data;
		if (intent.initiatingAdminId !== adminId) {
			return notice("Adjustment belongs to another administrator", "Only the administrator who created this adjustment can confirm, retry, cancel, clear, or replace it.");
		}
		if (intent.status === "preview") {
			if (intent.expiresAt <= Date.now()) {
				const cleared = await ctx.kv.compareAndDelete(ADJ_KEY, intentRaw.revision);
				if (!cleared.applied) return notice("Preview changed", "Reload Inventory to inspect the current adjustment.");
				return await render(ctx, adminId);
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
			return terminalPage("Stock adjustment committed", `Receipt: ${intent.receipt.receiptId}. Committed at: ${intent.receipt.committedAt}.`, "clear_adjustment_result", intent.commandId);
		} else if (intent.status === "rejected") {
			return terminalPage("Stock adjustment rejected", `Rejected code: ${intent.code}.`, "clear_adjustment_result", intent.commandId, true);
		}
	}

	let result: z.infer<typeof statusSchema>;
	try {
		result = statusSchema.parse(await api(ctx, session.token, "/v1/status"));
	} catch {
		return page([{ type: "banner", variant: "alert", title: "Connection could not be confirmed", description: "Account or Inventory service is unavailable. Reload or retry safely; your original connection is preserved." }, button("refresh", "Check status"), button("retry", "Retry connection")]);
	}
	if (result.status === "unconnected") {
		const saved = await ctx.kv.get<unknown>(CONN_INTENT_KEY);
		if (saved) return page([{ type: "banner", variant: "alert", title: "Connection outcome unknown", description: "Check or retry the original connection. Its Inventory operation will be preserved." }, button("retry", "Retry connection")]);
		const { operations } = z.object({ operations: z.array(operationSchema) }).parse(await api(ctx, session.token, "/v1/operations"));
		const blocks: Block[] = [trial, { type: "form", block_id: "first-location", fields: [textField("location_name", "Name your first stock location")], submit: { label: "Create Inventory", action_id: "create" } }];
		if (operations.length) blocks.push({ type: "form", block_id: "existing-operation", fields: [{ type: "select", action_id: "operation_id", label: "Connect an existing Inventory operation", options: operations.map(op => ({ label: `${op.locationName} (${op.status})`, value: op.operationId })) }], submit: { label: "Connect selected operation", action_id: "reconnect" } });
		return page(blocks);
	}
	if (result.status === "pending") return page([{ type: "banner", variant: "alert", title: "Inventory provisioning pending", description: "The outcome is not confirmed. Retry safely to check the same operation." }, button("retry", "Retry provisioning")]);
	if (result.status === "failed") return notice("Inventory setup failed", `Provisioning was rejected (${result.operation.failureCode}). Your original operation is preserved. Contact DinkusKit support.`);

	const locations = locationsSchema.parse(await api(ctx, session.token, "/v1/locations"));
	if (locations.locations.length === 0) {
		return page([{ type: "banner", title: "Inventory connected", description: "No stock locations found." }, button("refresh", "Refresh Inventory")]);
	}

	const skuList = managedSkuListSchema.parse(await api(ctx, session.token, "/v1/skus"));
	const selectedLocId = await ctx.kv.get<string>("state:selected-location");
	const storedSkuId = await ctx.kv.get<string>("state:selected-sku");
	const selectedSku = skuList.skus.find(sku => sku.inventorySkuId === storedSkuId) ?? skuList.skus[0];
	const selectedSkuId = selectedSku?.inventorySkuId;
	const activeLocation = locations.locations.find(l => l.locationId === selectedLocId) ?? locations.locations[0];
	const locationOptions = locations.locations.map(location => ({ label: location.name, value: location.locationId }));
	const skuOptions = skuList.skus.map(sku => ({ label: `${sku.displayName} (${sku.sku})`, value: sku.inventorySkuId }));

	let stockBalance: {
		onHand: string;
		reserved: string;
		outgoingTransferCommitted: string;
		available: string;
		expected: string;
		inTransit: string;
		version: string;
	} | null = null;
	let openingEligible = false;

	if (selectedSkuId && activeLocation) {
		try {
			const stockRaw: any = await api(ctx, session.token, `/v1/stock?sku_id=${encodeURIComponent(selectedSkuId)}&location_id=${encodeURIComponent(activeLocation.locationId)}`);
			if (stockRaw?.ok && stockRaw?.balance?.outcome === "found") {
				const b = stockRaw.balance.balance;
				if (b?.hasStockHistory) stockBalance = {
					onHand: `${b.onHand.value} ${b.onHand.unit}`,
					reserved: `${b.reserved.value} ${b.reserved.unit}`,
					outgoingTransferCommitted: `${b.outgoingTransferCommitted?.value ?? "0"} ${b.onHand.unit}`,
					available: `${b.available.value} ${b.available.unit}`,
					expected: `${b.expected?.value ?? "0"} ${b.onHand.unit}`,
					inTransit: `${b.inTransit?.value ?? "0"} ${b.onHand.unit}`,
					version: b.version,
				};
			}
		} catch {}
	}

 if (selectedSkuId && activeLocation && !stockBalance) {
  try {
   const eligibility = openingEligibilitySchema.parse(await api(ctx, session.token, `/v1/stock/opening/eligibility?sku_id=${encodeURIComponent(selectedSkuId)}&location_id=${encodeURIComponent(activeLocation.locationId)}`));
   openingEligible = eligibility.key.poolId === result.operation.poolId && eligibility.key.skuId === selectedSkuId && eligibility.key.locationId === activeLocation.locationId && eligibility.location.locationId === activeLocation.locationId && eligibility.eligibility === "eligible" && !eligibility.hasStockHistory;
  } catch { /* Missing or unavailable authoritative eligibility offers no mutation. */ }
 }

	const blocks: Block[] = [
		{ type: "banner", title: "Inventory connected", description: "Your Inventory operation is ready." },
		{ type: "section", text: `Active stock locations: ${locations.locations.map(l => l.name).join(", ")}` },
		{ type: "form", block_id: "register-sku", fields: [textField("sku", "Visible Commerce SKU"), textField("display_name", "Display name")], submit: { label: "Register SKU for Inventory", action_id: "register_sku" } },
	];

	if (skuOptions.length > 0) blocks.push({
		type: "form",
		block_id: "select-stock-view",
		fields: [selectField("location_id", "Active location", locationOptions, activeLocation?.locationId), selectField("sku_id", "Registered SKU", skuOptions, selectedSku?.inventorySkuId)],
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
				fields: [selectField("location_id", "Active location", locationOptions, activeLocation.locationId), selectField("sku_id", "Registered SKU", skuOptions, selectedSkuId), textField("delta_value", "Signed quantity delta (e.g. -2 or 5)"), textField("note", "Reason note")],
				submit: { label: "Preview stock adjustment", action_id: "preview_adjustment" },
			});
		} else {
			blocks.push({
				type: "context",
				text: openingEligible
					? `No stock history exists for SKU "${selectedSkuId}" at ${activeLocation.name}. Set Initial Stock to begin stock adjustments.`
					: `No authoritative stock balance found for SKU "${selectedSkuId}" at ${activeLocation.name}.`,
			});
			if (openingEligible) {
				blocks.push({
					type: "form",
					block_id: "opening-stock",
					fields: [selectField("location_id", "Active location", locationOptions, activeLocation.locationId), selectField("sku_id", "Registered SKU", skuOptions, selectedSkuId), textField("quantity_value", "Initial quantity (non-negative)")],
					submit: { label: "Preview initial stock", action_id: "preview_opening_balance" },
				});
			}
		}
	}
	if (locations.locations.length >= 2 && skuOptions.length > 0) {
		const defaultFrom = activeLocation?.locationId ?? locations.locations[0].locationId;
		const defaultTo = (locations.locations.find(l => l.locationId !== defaultFrom) ?? locations.locations[1]).locationId;
		blocks.push({
			type: "form",
			block_id: "location-move",
			fields: [selectField("from_location_id", "From location", locationOptions, defaultFrom), selectField("to_location_id", "To location", locationOptions, defaultTo), selectField("sku_id", "Registered SKU", skuOptions, selectedSkuId ?? skuOptions[0].value), textField("quantity_value", "Quantity")],
			submit: { label: "Preview location move", action_id: "preview_location_move" },
		});
	}

	blocks.push(button("refresh", "Refresh Inventory"));
	return page(blocks);
}

async function clearIntentIfMatching(ctx: PluginContext, key: string, adminId: string, commandId: unknown, validStatuses: string[]) {
	if (typeof commandId !== "string" || !commandId.trim()) return;
	const record = await ctx.kv.getVersioned<unknown>(key);
	if (!record || !record.value || typeof record.value !== "object") return;
	const v = record.value as any;
	if (!validStatuses.includes(v.status)) return;
	requireOriginatingAdministrator(v.initiatingAdminId, adminId);
	const cmdId = v.commandId ?? v.command?.commandId;
	if (cmdId === commandId) await ctx.kv.compareAndDelete(key, record.revision);
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

		if (interaction.type === "form_submit" && interaction.action_id === "preview_location_move") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);

			const existingIntentRecord = await ctx.kv.getVersioned<any>(LOC_MOVE_KEY);
			if (existingIntentRecord) {
				const existingParsed = locationMoveIntentSchema.safeParse(existingIntentRecord.value);
				if (!existingParsed.success) return notice("Location move requires originating administrator", "Resolve preserved request first.");
				requireOriginatingAdministrator(existingParsed.data.initiatingAdminId, adminId);
				if (existingParsed.data.status === "pending") return notice("Location move pending", "Move is pending. Resolve or retry first.");
			}

			const fromId = interaction.values.from_location_id;
			const toId = interaction.values.to_location_id;
			const skuVal = interaction.values.sku_id;
			const qtyVal = interaction.values.quantity_value?.trim();

			if (!fromId || !toId || !skuVal || !qtyVal) return notice("Invalid move parameters", "All fields are required.");
			if (fromId === toId) return notice("Locations must be distinct", "Locations must differ.");
			const numQty = Number(qtyVal);
			if (isNaN(numQty) || numQty <= 0) return notice("Invalid quantity", "Quantity must be positive.");

			const locationsData = locationsSchema.parse(await api(ctx, stored.session.token, "/v1/locations"));
			const fromLoc = locationsData.locations.find(l => l.locationId === fromId);
			const toLoc = locationsData.locations.find(l => l.locationId === toId);
			if (!fromLoc || !toLoc) return notice("Location not found", "Location not active.");

			const skuList = managedSkuListSchema.parse(await api(ctx, stored.session.token, "/v1/skus"));
			const foundSku = skuList.skus.find(s => s.inventorySkuId === skuVal);
			if (!foundSku) return notice("SKU not registered", "SKU not registered.");

			const moveIntent: LocationMoveIntent = {
				status: "preview",
				initiatingAdminId: adminId,
				commandId: crypto.randomUUID(),
				originLocationId: fromId,
				originLocationName: fromLoc.name,
				destinationLocationId: toId,
				destinationLocationName: toLoc.name,
				skuId: skuVal,
				skuDisplayName: foundSku.displayName,
				quantity: { value: qtyVal, unit: "each" },
				expiresAt: Date.now() + 5 * 60 * 1000,
			};

			const cas = await ctx.kv.compareAndSet(LOC_MOVE_KEY, existingIntentRecord?.revision ?? null, moveIntent);
			if (!cas.applied) return notice("Location move changed", "Reload to prepare move.");
			return await render(ctx, adminId);
		}

		if (interaction.type === "form_submit" && interaction.action_id === "register_sku") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);
			const existing = await ctx.kv.getVersioned<unknown>(SKU_REG_KEY);
			if (existing) {
				const prior = registrationIntentSchema.safeParse(existing.value);
				if (!prior.success) return notice("SKU registration requires its originating administrator", "Resolve the preserved registration request first.");
				requireOriginatingAdministrator(prior.data.initiatingAdminId, adminId);
				return notice("SKU registration pending", "Retry or resolve the existing registration before replacing it.");
			}
			const pending: RegistrationIntent = {
				status: "pending",
				initiatingAdminId: adminId,
				commandId: crypto.randomUUID(),
				sku: interaction.values.sku,
				displayNameIfNew: interaction.values.display_name,
			};
			const saved = await ctx.kv.compareAndSet(SKU_REG_KEY, null, pending);
			if (!saved.applied) return render(ctx, adminId);
			return await executeRegistration(ctx, adminId, stored.session.token, pending.commandId);
		}

		if (interaction.type === "form_submit" && interaction.action_id === "preview_opening_balance") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);
			const existing = await ctx.kv.getVersioned<unknown>(OPEN_KEY);
			const admittedRevision = existing?.revision ?? null;
			if (existing) {
				const prior = openingIntentSchema.safeParse(existing.value);
				if (!prior.success) return notice("Opening stock requires its originating administrator", "Resolve the preserved opening-stock request first.");
				requireOriginatingAdministrator(prior.data.initiatingAdminId, adminId);
				if (prior.data.status === "pending") return notice("Initial stock pending", "Retry or resolve the existing initial-stock command first.");
			}
			const locationsData = locationsSchema.parse(await api(ctx, stored.session.token, "/v1/locations"));
			if (!locationsData.locations.some(l => l.locationId === interaction.values.location_id)) return notice("Location not found", "The selected location is not active in this inventory operation.");
			const eligibility = openingEligibilitySchema.parse(await api(ctx, stored.session.token, "/v1/stock/opening/eligibility?sku_id=" + encodeURIComponent(interaction.values.sku_id) + "&location_id=" + encodeURIComponent(interaction.values.location_id)));
			if (eligibility.key.skuId !== interaction.values.sku_id || eligibility.key.locationId !== interaction.values.location_id || eligibility.location.locationId !== interaction.values.location_id) return notice("Initial stock unavailable", "The authoritative SKU or location identity did not match the request.");
			if (eligibility.eligibility !== "eligible" || eligibility.hasStockHistory) return notice("Initial stock unavailable", "This SKU-location has physical stock history, including zero balances. Review it as an adjustment.");
			const preview = openingPreviewSchema.parse(await api(ctx, stored.session.token, "/v1/stock/opening/preview", {
				locationId: interaction.values.location_id,
				skuId: interaction.values.sku_id,
				quantity: { value: interaction.values.quantity_value, unit: "each" },
				reason: { code: "physical_count", note: "Set Initial Stock after reviewing the authoritative SKU-location history" },
				references: [],
			}));
			const command: OpeningCommand = {
				schema: CMD_SCHEMA,
				commandId: crypto.randomUUID(),
				type: "stock.opening_balance",
				context: preview.context,
				payload: { skuId: preview.effect.skuId, quantity: preview.effect.onHandDelta },
				reason: preview.reason,
				references: preview.references,
				expectedVersions: [{ skuId: preview.effect.skuId, locationId: preview.context.locationId, version: preview.effect.balanceBefore.version }],
			};
			const next: OpeningIntent = { status: "preview", initiatingAdminId: adminId, preview, command, expiresAt: Date.parse(preview.confirmation.expiresAt) };
			await ctx.kv.compareAndSet(OPEN_KEY, admittedRevision, next);
			return await render(ctx, adminId);
		}

		// Handle preview stock adjustment form submission
		if (interaction.type === "form_submit" && interaction.action_id === "preview_adjustment") {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);

			// Check if an adjustment is already pending
			const existingIntentRecord = await ctx.kv.getVersioned<unknown>(ADJ_KEY);
			if (existingIntentRecord) {
				const existingParsed = adjustmentIntentSchema.safeParse(existingIntentRecord.value);
				if (!existingParsed.success) return notice("Adjustment requires its originating administrator", "This adjustment is preserved safely. Resolve the existing legacy state before preparing another.");
				requireOriginatingAdministrator(existingParsed.data.initiatingAdminId, adminId);
				if (existingParsed.data.status === "pending") return notice("Adjustment pending", "An adjustment is currently pending confirmation. Resolve or retry the pending adjustment first.");
			}

			const locId = interaction.values.location_id ?? (await ctx.kv.get<string>("state:selected-location"));
			if (!locId) return notice("Location required", "Explicit active stock location is required.");

			const locationsData = locationsSchema.parse(await api(ctx, stored.session.token, "/v1/locations"));
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
				schema: CMD_SCHEMA,
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
				initiatingAdminId: adminId,
				preview,
				command,
				expiresAt: Date.parse(preview.confirmation.expiresAt),
			};
			const latestIntent = await ctx.kv.getVersioned<unknown>(ADJ_KEY);
			if (latestIntent) {
				const latestParsed = adjustmentIntentSchema.safeParse(latestIntent.value);
				if (!latestParsed.success) return notice("Adjustment requires its originating administrator", "This adjustment is preserved safely. Resolve the existing legacy state before preparing another.");
				requireOriginatingAdministrator(latestParsed.data.initiatingAdminId, adminId);
				if (latestParsed.data.status === "pending") {
					return notice("Adjustment pending", "An adjustment is currently pending confirmation.");
				}
				await ctx.kv.compareAndSet(ADJ_KEY, latestIntent.revision, intent);
			} else {
				await ctx.kv.compareAndSet(ADJ_KEY, null, intent);
			}
			return await render(ctx, adminId);
		}

		if (interaction.type === "block_action") {
			const a = interaction.action_id;
			const v = interaction.value;
			const withToken = async (fn: (token: string) => Promise<BlockResponse>) => {
				const s = await readSession(ctx);
				if (!s || s.session.phase !== "token" || s.session.expiresAt <= Date.now()) return render(ctx, adminId);
				return await fn(s.session.token);
			};
			if (a === "confirm_adjustment" || a === "retry_adjustment") return await withToken(t => executeAdjustmentConfirm(ctx, adminId, t, v));
			if (a === "cancel_adjustment") { await clearIntentIfMatching(ctx, ADJ_KEY, adminId, v, ["preview"]); return render(ctx, adminId); }
			if (a === "clear_adjustment_result") { await clearIntentIfMatching(ctx, ADJ_KEY, adminId, v, ["committed", "rejected"]); return render(ctx, adminId); }
			if (a === "confirm_opening_balance" || a === "retry_opening_balance") return await withToken(t => executeOpeningConfirm(ctx, adminId, t, v));
			if (a === "cancel_opening_balance") { await clearIntentIfMatching(ctx, OPEN_KEY, adminId, v, ["preview"]); return render(ctx, adminId); }
			if (a === "clear_opening_balance_result") { await clearIntentIfMatching(ctx, OPEN_KEY, adminId, v, ["committed", "rejected"]); return render(ctx, adminId); }
			if (a === "retry_registration") return await withToken(t => typeof v === "string" ? executeRegistration(ctx, adminId, t, v) : render(ctx, adminId));
			if (a === "clear_registration_result") { await clearIntentIfMatching(ctx, SKU_REG_KEY, adminId, v, ["committed", "rejected"]); return render(ctx, adminId); }
			if (a === "confirm_location_move" || a === "retry_location_move") return await withToken(t => executeLocationMoveConfirm(ctx, adminId, t, v));
			if (a === "cancel_location_move") { await clearIntentIfMatching(ctx, LOC_MOVE_KEY, adminId, v, ["preview"]); return render(ctx, adminId); }
			if (a === "clear_location_move_result") { await clearIntentIfMatching(ctx, LOC_MOVE_KEY, adminId, v, ["committed", "rejected"]); return render(ctx, adminId); }
		}

		if ((interaction.type === "form_submit" && (interaction.action_id === "create" || interaction.action_id === "reconnect")) || (interaction.type === "block_action" && interaction.action_id === "retry")) {
			const stored = await readSession(ctx);
			if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx, adminId);
			let intent = await ctx.kv.get<unknown>(CONN_INTENT_KEY);
			if (interaction.type === "form_submit") {
				const values = interaction.values ?? {};
				const locationName = typeof values.location_name === "string" ? values.location_name.trim() : "";
				const operationId = typeof values.operation_id === "string" ? values.operation_id.trim() : "";
				if (interaction.action_id === "create" ? locationName.length < 1 || locationName.length > 200 : operationId.length < 1) return render(ctx, adminId);
				const candidate = interaction.action_id === "create" ? { type: "create", requestId: crypto.randomUUID(), locationName } : { type: "reconnect", requestId: crypto.randomUUID(), operationId };
				if (!intent) { await ctx.kv.compareAndSet(CONN_INTENT_KEY, null, candidate); intent = await ctx.kv.get(CONN_INTENT_KEY); }
				else {
					const previous = intentSchema.parse(intent);
					if (previous.type !== candidate.type || JSON.stringify({ ...previous, requestId: "" }) !== JSON.stringify({ ...candidate, requestId: "" })) return notice("Connection already started", "Use Retry to resolve your original connection before changing the setup.");
				}
			} else if (!intent) {
				const result = statusSchema.parse(await api(ctx, stored.session.token, "/v1/status"));
				if (result.status === "unconnected") return render(ctx, adminId);
				await ctx.kv.compareAndSet(CONN_INTENT_KEY, null, { type: "reconnect", requestId: crypto.randomUUID(), operationId: result.operation.operationId });
				intent = await ctx.kv.get(CONN_INTENT_KEY);
			}
			const frozen = intentSchema.parse(intent);
			activeRequestId = frozen.requestId;
			await api(ctx, stored.session.token, "/v1/connect", frozen);
		}
		return await render(ctx, adminId);
	} catch (error) {
		if (error instanceof StoreConnectError) {
			if (error.code === "wrong_originating_admin" && ((parsed.data.type === "form_submit" && ["preview_adjustment", "preview_opening_balance", "register_sku", "preview_location_move"].includes(parsed.data.action_id)) || (parsed.data.type === "block_action" && ["confirm_adjustment", "retry_adjustment", "cancel_adjustment", "clear_adjustment_result", "confirm_opening_balance", "retry_opening_balance", "cancel_opening_balance", "clear_opening_balance_result", "retry_registration", "clear_registration_result", "confirm_location_move", "retry_location_move", "cancel_location_move", "clear_location_move_result"].includes(parsed.data.action_id)))) {
				return notice("Request belongs to another administrator", "Only the administrator who created this request can continue or change it.");
			}
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
				const saved = await ctx.kv.getVersioned<unknown>(CONN_INTENT_KEY);
				if (saved && intentSchema.parse(saved.value).requestId === activeRequestId) await ctx.kv.compareAndDelete(CONN_INTENT_KEY, saved.revision);
				return notice("Operation unavailable", "The selected operation is not owned by this account. Reload Inventory to select an owned operation or create a new one.");
			}
			if (error.code === "opening_balance_required") {
				return notice("Opening balance required", "Set Initial Stock before making a stock adjustment.");
			}
			if (["opening_balance_already_set", "sku_not_registered", "sku_unit_mismatch", "stale_version"].includes(error.code)) {
				return notice("Initial stock unavailable", "The authoritative stock state changed or the SKU is not eligible. Reload and inspect the stock balance.");
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
			const connectionId = z.object({ connection_id: z.string().check(z.trim(), z.minLength(1), z.maxLength(200)) }).safeParse(routeCtx.input);
			if (!connectionId.success) {
				return pluginResponse({ status: 404, headers: { "content-type": APP_JSON }, body: { kind: "text", value: JSON.stringify({ error: "not_found" }) } });
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
				return pluginResponse({ status: 404, headers: { "content-type": APP_JSON }, body: { kind: "text", value: JSON.stringify({ error: "not_found" }) } });
			}
			return pluginResponse({
				status: 200,
				headers: { "content-type": APP_JSON },
				body: { kind: "text", value: JSON.stringify(published) },
			});
		},
	},
} };
export default plugin;
