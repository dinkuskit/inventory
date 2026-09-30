import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import { connectInputSchema, type AccountPrincipal } from "../features/hosted-onboarding/index.ts";
import { createAccountAuthenticator } from "./account-auth.ts";
import { InventoryAccount } from "./account-connections.ts";
import { InventoryPool } from "./worker.ts";
export { InventoryAccount, InventoryPool };

export interface HostedInventoryEnv {
	INVENTORY_POOLS: DurableObjectNamespace<InventoryPool>;
	INVENTORY_ACCOUNTS: DurableObjectNamespace<InventoryAccount>;
	ACCOUNT_ISSUER?: string;
	ACCOUNT_JWKS_URL?: string;
	ACCOUNT_AUDIENCE?: string;
}
export function createHostedInventoryHandler(env: HostedInventoryEnv, authenticate?: (request: Request) => Promise<AccountPrincipal>) {
	return async (request: Request): Promise<Response> => {
		const path = new URL(request.url).pathname;
		if (!["/v1/connect", "/v1/status", "/v1/operations", "/v1/locations"].includes(path)) return new Response("Not Found", { status: 404 });
		const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
		if (!authenticate && (!env.ACCOUNT_ISSUER || !env.ACCOUNT_JWKS_URL || !env.ACCOUNT_AUDIENCE)) return respond({ error: "account_service_unconfigured" }, 503);
		let principal: AccountPrincipal;
		try {
			const verify = authenticate ?? createAccountAuthenticator({ issuer: env.ACCOUNT_ISSUER!, jwksUrl: env.ACCOUNT_JWKS_URL!, audience: env.ACCOUNT_AUDIENCE! });
			principal = await verify(request);
		} catch { return respond({ error: "unauthorized" }, 401); }
		const account = env.INVENTORY_ACCOUNTS.getByName(principal.accountId);
		try {
			if (path === "/v1/connect") {
				if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
				if (!request.headers.get("content-type")?.startsWith("application/json")) return respond({ error: "invalid_request" }, 400);
				// Bound before buffering, including chunked requests.
				const reader = request.body?.getReader();
				if (!reader) return respond({ error: "invalid_request" }, 400);
				let text = "", bytes = 0;
				const decoder = new TextDecoder();
				while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 4096) { await reader.cancel(); return respond({ error: "request_too_large" }, 413); } text += decoder.decode(chunk.value, { stream: true }); }
				text += decoder.decode();
				let input;
				try { input = connectInputSchema.parse(JSON.parse(text)); } catch { return respond({ error: "invalid_request" }, 400); }
				const result = await account.connectAccount(principal, input);
				if (result.status === "rejected") return respond({ error: result.error }, result.error === "operation_not_found" ? 404 : 409);
				return respond(result, result.status === "pending" ? 202 : 200);
			}
			if (request.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
			if (path === "/v1/operations") return respond({ operations: await account.operations() });
			const result = await account.status(principal.siteId);
			if (path === "/v1/status") return respond(result);
			if (result.status !== "ready") return respond({ error: "inventory_not_ready", connection: result }, 409);
			return respond(await env.INVENTORY_POOLS.getByName(result.operation.poolId).listLocations(result.operation.poolId));
		} catch (error) {
			// DO RPC preserves message, not custom Error prototypes. No internal errors leak.
			const code = error instanceof Error ? error.message : "";
			if (["request_id_conflict", "site_already_connected"].includes(code)) return respond({ error: code }, 409);
			if (code === "operation_not_found") return respond({ error: code }, 404);
			if (error instanceof z.ZodError) return respond({ error: "invalid_request" }, 400);
			return respond({ error: "service_unavailable" }, 503);
		}
	};
}
export default class HostedInventoryService extends WorkerEntrypoint<HostedInventoryEnv> {
	async fetch(request: Request) { return createHostedInventoryHandler(this.env)(request); }
}
