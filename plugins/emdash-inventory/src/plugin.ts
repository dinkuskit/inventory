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
	proofReceiptSchema,
	publicProofFor,
	requireBoundAdministrator,
	requireOriginatingAdministrator,
	resumeActiveChallenge,
	startRequestSchema,
	startResponseSchema,
	storeConnectSessionSchema,
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
const interactionSchema = z.union([
	z.object({ type: z.literal("page_load"), page: z.literal("/inventory") }),
	z.object({ type: z.literal("block_action"), action_id: z.enum(["connect", "check_sign_in", "retry", "refresh"]), block_id: z.string().optional(), value: z.unknown().optional() }),
	z.object({ type: z.literal("form_submit"), action_id: z.literal("create"), block_id: z.string().optional(), values: z.object({ location_name: z.string().trim().min(1).max(200) }).strict() }),
	z.object({ type: z.literal("form_submit"), action_id: z.literal("reconnect"), block_id: z.string().optional(), values: z.object({ operation_id: id }).strict() }),
]);
const button = (action_id: string, label: string): Block => ({ type: "actions", elements: [{ type: "button", action_id, label }] });
const page = (blocks: Block[]): BlockResponse => ({ blocks: [{ type: "header", text: "Inventory" }, ...blocks] });
const notice = (title: string, description: string) => page([{ type: "banner", variant: "alert", title, description }]);
const trial: Block = { type: "context", text: "Start your Inventory trial. No payment details are needed to connect or begin use." };

async function siteId(ctx: PluginContext): Promise<string> {
	let found = await ctx.kv.get<string>("state:site-id");
	if (found) return found;
	await ctx.kv.compareAndSet("state:site-id", null, crypto.randomUUID());
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
	return { session: storeConnectSessionSchema.parse(JSON.parse(stored.value)), revision: stored.revision };
}
async function saveSession(ctx: PluginContext, session: Session, revision: string | null) {
	const result = await ctx.settings.compareAndSet("connectionSession", revision, JSON.stringify(session));
	if (!result.applied) throw new Error("Session changed; reload Inventory");
}
async function clearSession(ctx: PluginContext, revision: string | null) {
	return revision ? (await ctx.settings.compareAndDelete("connectionSession", revision)).applied : false;
}
async function readProof(ctx: PluginContext, connectionId: string) {
	const stored = await ctx.kv.get<unknown>(`state:store-proof:${connectionId}`);
	if (!stored) return null;
	return proofReceiptSchema.parse(stored);
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
		method: input ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "X-Inventory-Site": await siteId(ctx), "Content-Type": "application/json" }, body: input ? JSON.stringify(input) : undefined,
	});
	if (!response.ok) {
		if (response.status === 401) throw new Error("sign_in_required");
		const rejected = z.object({ error: z.enum(["operation_not_found", "request_id_conflict", "site_already_connected"]) }).safeParse(body);
		if (rejected.success && [404, 409].includes(response.status)) throw new InventoryApiError(rejected.data.error);
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
		// Never adopt a competing start's revision after removing our expired state.
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
	await saveSession(ctx, { ...session, nextPoll: Date.now() + session.interval }, stored.revision);
	const reserved = await readSession(ctx);
	if (!reserved || reserved.session.phase !== "challenge") return;
	const { response, body } = await fetchJson(ctx, WEBSITE + "/api/store-connections/token", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: STORE_CONNECT_CLIENT_ID, connection_id: session.connectionId, code_verifier: session.codeVerifier }),
	});
	if (!response.ok) {
		const pending = tokenPendingSchema.safeParse(body);
		if (pending.success) return;
		const failure = tokenFailureSchema.safeParse(body);
		if (failure.success && failure.data.error === "slow_down") {
			await saveSession(ctx, { ...session, interval: session.interval + 5000, nextPoll: Date.now() + session.interval + 5000 }, reserved.revision);
			return;
		}
		if (failure.success && ["access_denied", "expired_token", "invalid_grant", "already_redeemed", "proof_mismatch", "ownership_conflict"].includes(failure.data.error)) {
			await deleteProof(ctx, session.connectionId);
			await clearSession(ctx, reserved.revision);
			if (failure.data.error === "already_redeemed") throw new StoreConnectError("unexpected_website_response");
			return;
		}
		throw new StoreConnectError("unexpected_website_response");
	}
	const token = tokenSuccessSchema.parse(body);
	if (token.site_id !== session.siteId) throw new StoreConnectError("unexpected_website_response");
	await saveSession(ctx, { phase: "token", token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 }, reserved.revision);
	await deleteProof(ctx, session.connectionId);
}

async function render(ctx: PluginContext, adminId: string): Promise<BlockResponse> {
	const stored = await readSession(ctx);
	if (!stored || stored.session.expiresAt <= Date.now()) {
		if (stored?.session.phase === "challenge") await deleteProof(ctx, stored.session.connectionId);
		return page([
			{ type: "section", text: "Connect Inventory, then sign in or create your DinkusKit account and approve this site. Your stock stays in one Inventory operation." }, trial, button("connect", "Connect Inventory"),
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
	return page([{ type: "banner", title: "Inventory connected", description: "Your Inventory operation is ready." }, ...locations.locations.map(location => ({ type: "section" as const, text: `Stock location: ${location.name}` })), { type: "context", text: "Stock administration stays inside EmDash. This setup slice provisions your location; receiving and adjustment screens follow separately." }, button("refresh", "Refresh Inventory")]);
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
			const active = (await readSession(ctx))?.session;
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
