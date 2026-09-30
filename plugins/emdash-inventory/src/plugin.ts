import type { SandboxedPlugin } from "emdash/plugin";
import type { PluginContext } from "emdash";
import type { Block, BlockResponse } from "@emdash-cms/blocks/server";
import { z } from "zod";

// Reserved non-routable defaults until DinkusKit's account and service deployment is approved.
// The proof host maps these declared origins to local fixtures; shop owners never configure them.
const SERVICE = "https://inventory.dinkuskit.invalid";
const ACCOUNT = "https://accounts.dinkuskit.invalid";
const CLIENT = "dinkus-inventory-emdash";
const id = z.string().min(1).max(200);
const intentSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("create"), requestId: id, locationName: z.string().trim().min(1).max(200) }).strict(),
	z.object({ type: z.literal("reconnect"), requestId: id, operationId: id }).strict(),
]);
const operationSchema = z.object({ operationId: id, poolId: id, locationName: z.string(), locationId: z.string().nullable(), status: z.enum(["pending", "ready", "failed"]), failureCode: z.string().nullable() });
const statusSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("unconnected") }), z.object({ status: z.enum(["pending", "ready", "failed"]), operation: operationSchema })]);
const sessionSchema = z.discriminatedUnion("phase", [
	z.object({ phase: z.literal("device"), deviceCode: z.string(), userCode: z.string(), verificationUri: z.url(), expiresAt: z.number(), interval: z.number(), nextPoll: z.number() }),
	z.object({ phase: z.literal("token"), token: z.string(), expiresAt: z.number() }),
]);
type Session = z.infer<typeof sessionSchema>;
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
async function readSession(ctx: PluginContext) {
	const stored = await ctx.settings.getVersioned<string>("connectionSession");
	if (!stored) return null;
	return { session: sessionSchema.parse(JSON.parse(stored.value)), revision: stored.revision };
}
async function saveSession(ctx: PluginContext, session: Session, revision: string | null) {
	const result = await ctx.settings.compareAndSet("connectionSession", revision, JSON.stringify(session));
	if (!result.applied) throw new Error("Session changed; reload Inventory");
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
async function startSignIn(ctx: PluginContext) {
	const stored = await readSession(ctx);
	if (stored && stored.session.expiresAt > Date.now()) return;
	const { response, body } = await fetchJson(ctx, ACCOUNT + "/oauth/device_authorization", {
		method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: CLIENT, scope: "inventory:admin", site_id: await siteId(ctx) }).toString(),
	});
	if (!response.ok) throw new Error("Account service unavailable");
	const grant = z.object({ device_code: z.string().min(1), user_code: z.string().min(1), verification_uri: z.url(), expires_in: z.number().int().positive(), interval: z.number().int().positive().optional() }).parse(body);
	if (new URL(grant.verification_uri).origin !== ACCOUNT) throw new Error("Unexpected sign-in origin");
	const interval = (grant.interval ?? 5) * 1000;
	await saveSession(ctx, { phase: "device", deviceCode: grant.device_code, userCode: grant.user_code, verificationUri: grant.verification_uri, expiresAt: Date.now() + grant.expires_in * 1000, interval, nextPoll: Date.now() + interval }, stored?.revision ?? null);
}
async function pollSignIn(ctx: PluginContext) {
	const stored = await readSession(ctx);
	if (!stored || stored.session.phase !== "device") return;
	const session = stored.session;
	if (session.expiresAt <= Date.now() || session.nextPoll > Date.now()) return;
	// Reserve the poll via host CAS before network access: repeated admin actions cannot overspeed OAuth.
	await saveSession(ctx, { ...session, nextPoll: Date.now() + session.interval }, stored.revision);
	const reserved = await readSession(ctx);
	if (!reserved) return;
	const { response, body } = await fetchJson(ctx, ACCOUNT + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT, device_code: session.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }).toString() });
	if (!response.ok) {
		const failure = z.object({ error: z.string() }).parse(body);
		if (failure.error === "authorization_pending") return;
		if (failure.error === "slow_down") { await saveSession(ctx, { ...session, interval: session.interval + 5000, nextPoll: Date.now() + session.interval + 5000 }, reserved.revision); return; }
		if (["access_denied", "expired_token", "invalid_grant"].includes(failure.error)) { await ctx.settings.compareAndDelete("connectionSession", reserved.revision); return; }
		throw new Error("Account service unavailable");
	}
	const token = z.object({ access_token: z.string().min(1), token_type: z.literal("Bearer"), expires_in: z.number().int().positive() }).parse(body);
	await saveSession(ctx, { phase: "token", token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 }, reserved.revision);
}

async function render(ctx: PluginContext): Promise<BlockResponse> {
	const stored = await readSession(ctx);
	if (!stored || stored.session.expiresAt <= Date.now()) return page([
		{ type: "section", text: "Connect Inventory, then sign in or create your DinkusKit account. Your stock stays in one Inventory operation." }, trial, button("connect", "Connect Inventory"),
	]);
	const session = stored.session;
	if (session.phase === "device") return page([
		{ type: "section", text: `Sign in or create your DinkusKit account and enter code ${session.userCode}.` },
		{ type: "actions", elements: [{ type: "link", label: "Sign in / create account", target: { kind: "external", url: session.verificationUri } }] },
		button("check_sign_in", "I’ve signed in — check connection"), { type: "context", text: "Waiting for account approval. Stock has not been provisioned yet." },
	]);
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

const plugin: SandboxedPlugin = { routes: { admin: {
	permission: "plugins:manage",
	handler: async (routeCtx, ctx): Promise<BlockResponse> => {
		const parsed = interactionSchema.safeParse(routeCtx.input);
		if (!parsed.success) return notice("Invalid Inventory action", "Reload Inventory and try again.");
		let activeRequestId: string | null = null;
		try {
			const interaction = parsed.data;
			if (interaction.type === "block_action" && interaction.action_id === "connect") await startSignIn(ctx);
			if (interaction.type === "block_action" && interaction.action_id === "check_sign_in") await pollSignIn(ctx);
			if (interaction.type === "form_submit" || (interaction.type === "block_action" && interaction.action_id === "retry")) {
				const stored = await readSession(ctx);
				if (!stored || stored.session.phase !== "token" || stored.session.expiresAt <= Date.now()) return render(ctx);
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
					if (result.status === "unconnected") return render(ctx);
					await ctx.kv.compareAndSet("state:connection-intent", null, { type: "reconnect", requestId: crypto.randomUUID(), operationId: result.operation.operationId });
					intent = await ctx.kv.get("state:connection-intent");
				}
				const frozen = intentSchema.parse(intent);
				activeRequestId = frozen.requestId;
				await api(ctx, stored.session.token, "/v1/connect", frozen);
			}
			return await render(ctx);
		} catch (error) {
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
	},
} } };
export default plugin;
