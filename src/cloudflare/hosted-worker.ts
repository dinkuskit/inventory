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

const adjustPreviewInputSchema = z.object({
	locationId: z.string().trim().min(1).max(200),
	skuId: z.string().trim().min(1).max(200),
	delta: z.object({
		value: z.string().trim().min(1).max(50),
		unit: z.string().trim().min(1).max(50),
	}).strict(),
	reason: z.object({
		note: z.string().trim().min(1).max(500),
	}).strict(),
	references: z.array(z.object({
		kind: z.string().trim().min(1).max(100),
		id: z.string().trim().min(1).max(200),
	}).strict()).optional().default([]),
}).strict();

const adjustConfirmInputSchema = z.object({
	confirmation: z.string().trim().min(1).max(500),
	command: z.object({
		schema: z.literal("dinkuskit.inventory.command/v1"),
		commandId: z.string().trim().min(1).max(200),
		type: z.literal("stock.adjust"),
		context: z.object({
			siteId: z.string().trim().min(1).max(200),
			poolId: z.string().trim().min(1).max(200),
			locationId: z.string().trim().min(1).max(200),
		}).strict(),
		payload: z.object({
			skuId: z.string().trim().min(1).max(200),
			delta: z.object({
				value: z.string().trim().min(1).max(50),
				unit: z.string().trim().min(1).max(50),
			}).strict(),
		}).strict(),
		reason: z.object({
			note: z.string().trim().min(1).max(500),
		}).strict(),
		references: z.array(z.object({
			kind: z.string().trim().min(1).max(100),
			id: z.string().trim().min(1).max(200),
		}).strict()).default([]),
		expectedVersions: z.array(z.object({
			skuId: z.string().trim().min(1).max(200),
			locationId: z.string().trim().min(1).max(200),
			version: z.string().trim().min(1).max(50),
		}).strict()).min(1),
	}).strict(),
}).strict();

const openingPreviewInputSchema = z.object({
	locationId: z.string().trim().min(1).max(200),
	skuId: z.string().trim().min(1).max(200),
	quantity: z.object({
		value: z.string().trim().regex(/^\d+(?:\.\d+)?$/u).max(50),
		unit: z.string().trim().min(1).max(50),
	}).strict(),
	reason: z.object({
		code: z.string().trim().min(1).max(100),
		note: z.string().trim().min(1).max(500),
	}).strict(),
	references: z.array(z.object({
		kind: z.string().trim().min(1).max(100),
		id: z.string().trim().min(1).max(200),
	}).strict()).optional().default([]),
}).strict();

const openingConfirmInputSchema = z.object({
	confirmation: z.string().trim().min(1).max(500),
	command: z.object({
		schema: z.literal("dinkuskit.inventory.command/v1"),
		commandId: z.string().trim().min(1).max(200),
		type: z.literal("stock.opening_balance"),
		context: z.object({
			siteId: z.string().trim().min(1).max(200),
			poolId: z.string().trim().min(1).max(200),
			locationId: z.string().trim().min(1).max(200),
		}).strict(),
		payload: z.object({
			skuId: z.string().trim().min(1).max(200),
			quantity: z.object({
				value: z.string().trim().regex(/^\d+(?:\.\d+)?$/u).max(50),
				unit: z.string().trim().min(1).max(50),
			}).strict(),
		}).strict(),
		reason: z.object({
			code: z.string().trim().min(1).max(100),
			note: z.string().trim().min(1).max(500),
		}).strict(),
		references: z.array(z.object({
			kind: z.string().trim().min(1).max(100),
			id: z.string().trim().min(1).max(200),
		}).strict()),
		expectedVersions: z.array(z.object({
			skuId: z.string().trim().min(1).max(200),
			locationId: z.string().trim().min(1).max(200),
			version: z.string().trim().regex(/^\d+$/u).max(50),
		}).strict()).length(1),
	}).strict(),
}).strict();

async function readBoundedJson(request: Request, maxBytes = 8192): Promise<{ text: string } | { error: "request_too_large" | "invalid_request" }> {
	if (!request.headers.get("content-type")?.startsWith("application/json")) return { error: "invalid_request" };
	const reader = request.body?.getReader();
	if (!reader) return { error: "invalid_request" };
	let text = "", bytes = 0;
	const decoder = new TextDecoder();
	while (true) {
		const chunk = await reader.read();
		if (chunk.done) break;
		bytes += chunk.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel();
			return { error: "request_too_large" };
		}
		text += decoder.decode(chunk.value, { stream: true });
	}
	text += decoder.decode();
	return { text };
}

export function createHostedInventoryHandler(env: HostedInventoryEnv, authenticate?: (request: Request) => Promise<AccountPrincipal>) {
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;
		const allowedPaths = [
			"/v1/connect",
			"/v1/status",
			"/v1/operations",
			"/v1/locations",
			"/v1/stock",
			"/v1/stock/opening/eligibility",
			"/v1/stock/adjust/preview",
			"/v1/stock/adjust/confirm",
			"/v1/stock/opening/preview",
			"/v1/stock/opening/confirm",
			"/v1/receipts",
		];
		if (!allowedPaths.includes(path)) return new Response("Not Found", { status: 404 });
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
				const bodyRead = await readBoundedJson(request, 4096);
				if ("error" in bodyRead) return respond({ error: bodyRead.error }, bodyRead.error === "request_too_large" ? 413 : 400);
				let input;
				try { input = connectInputSchema.parse(JSON.parse(bodyRead.text)); } catch { return respond({ error: "invalid_request" }, 400); }
				const result = await account.connectAccount(principal, input);
				if (result.status === "rejected") return respond({ error: result.error }, result.error === "operation_not_found" ? 404 : 409);
				return respond(result, result.status === "pending" ? 202 : 200);
			}

			if (path === "/v1/stock/adjust/preview") {
				if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
				const statusResult = await account.status(principal.siteId);
				if (statusResult.status !== "ready") return respond({ error: "inventory_not_ready", connection: statusResult }, 409);
				const bodyRead = await readBoundedJson(request, 4096);
				if ("error" in bodyRead) return respond({ error: bodyRead.error }, bodyRead.error === "request_too_large" ? 413 : 400);
				let parsed;
				try { parsed = adjustPreviewInputSchema.parse(JSON.parse(bodyRead.text)); } catch { return respond({ error: "invalid_request" }, 400); }
				const pool = env.INVENTORY_POOLS.getByName(statusResult.operation.poolId);
				const input = {
					schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1" as const,
					type: "stock.adjust" as const,
					context: {
						siteId: principal.siteId,
						poolId: statusResult.operation.poolId,
						locationId: parsed.locationId,
					},
					payload: {
						skuId: parsed.skuId,
						delta: parsed.delta,
					},
					reason: parsed.reason,
					references: parsed.references,
				};
				const previewResult = await pool.previewStockAdjustment(input, {
					principal: { kind: "human", id: principal.accountId, displayName: "Site Administrator", surface: "emdash" },
				});
				if (!previewResult.ok) {
					const status = ["stale_version", "opening_balance_required"].includes(previewResult.error) ? 409 : 400;
					return respond({ error: previewResult.error, message: previewResult.message }, status);
				}
				return respond(previewResult.preview, 200);
			}

			if (path === "/v1/stock/adjust/confirm") {
				if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
				const statusResult = await account.status(principal.siteId);
				if (statusResult.status !== "ready") return respond({ error: "inventory_not_ready", connection: statusResult }, 409);
				const bodyRead = await readBoundedJson(request, 8192);
				if ("error" in bodyRead) return respond({ error: bodyRead.error }, bodyRead.error === "request_too_large" ? 413 : 400);
				let parsed;
				try { parsed = adjustConfirmInputSchema.parse(JSON.parse(bodyRead.text)); } catch { return respond({ error: "invalid_request" }, 400); }
				if (parsed.command.context.siteId !== principal.siteId || parsed.command.context.poolId !== statusResult.operation.poolId) {
					return respond({ error: "unauthorized_context" }, 403);
				}
				const pool = env.INVENTORY_POOLS.getByName(statusResult.operation.poolId);
				const confirmResult = await pool.confirmStockAdjustment(parsed.confirmation, parsed.command, {
					principal: { kind: "human", id: principal.accountId, displayName: "Site Administrator", surface: "emdash" },
				});
				if (!confirmResult.ok) {
					const status = ["confirmation_expired", "confirmation_mismatch", "confirmation_already_used"].includes(confirmResult.error) ? 409 : 400;
					return respond({ error: confirmResult.error, message: confirmResult.message }, status);
				}
				if (confirmResult.result.outcome === "rejected") {
					return respond(confirmResult.result, 409);
				}
				return respond(confirmResult.result, 200);
			}

			if (path === "/v1/stock/opening/preview") {
				if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
				const statusResult = await account.status(principal.siteId);
				if (statusResult.status !== "ready") return respond({ error: "inventory_not_ready", connection: statusResult }, 409);
				const bodyRead = await readBoundedJson(request, 4096);
				if ("error" in bodyRead) return respond({ error: bodyRead.error }, bodyRead.error === "request_too_large" ? 413 : 400);
				let parsed;
				try { parsed = openingPreviewInputSchema.parse(JSON.parse(bodyRead.text)); } catch { return respond({ error: "invalid_request" }, 400); }
				const pool = env.INVENTORY_POOLS.getByName(statusResult.operation.poolId);
				if (!(await pool.listLocations(statusResult.operation.poolId)).locations.some((location) => location.locationId === parsed.locationId)) {
					return respond({ error: "location_not_active" }, 409);
				}
				const result = await pool.previewOpeningBalance({
					schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
					type: "stock.opening_balance",
					context: { siteId: principal.siteId, poolId: statusResult.operation.poolId, locationId: parsed.locationId },
					payload: { skuId: parsed.skuId, quantity: parsed.quantity },
					reason: parsed.reason,
					references: parsed.references,
				}, { principal: { kind: "human", id: principal.accountId, displayName: "Site Administrator", surface: "emdash" } });
				if (!result.ok) return respond({ error: result.error, message: result.message }, 409);
				return respond(result.preview);
			}

			if (path === "/v1/stock/opening/eligibility") {
				if (request.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
				const statusResult = await account.status(principal.siteId);
				if (statusResult.status !== "ready") return respond({ error: "inventory_not_ready", connection: statusResult }, 409);
				const skuId = url.searchParams.get("sku_id") ?? url.searchParams.get("skuId");
				const locationId = url.searchParams.get("location_id") ?? url.searchParams.get("locationId");
				if (!skuId || !locationId) return respond({ error: "invalid_request" }, 400);
				const result = await env.INVENTORY_POOLS.getByName(statusResult.operation.poolId).readOpeningBalanceEligibility({
					poolId: statusResult.operation.poolId, skuId, locationId,
				});
				return respond(result);
			}

			if (path === "/v1/stock/opening/confirm") {
				if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
				const statusResult = await account.status(principal.siteId);
				if (statusResult.status !== "ready") return respond({ error: "inventory_not_ready", connection: statusResult }, 409);
				const bodyRead = await readBoundedJson(request, 8192);
				if ("error" in bodyRead) return respond({ error: bodyRead.error }, bodyRead.error === "request_too_large" ? 413 : 400);
				let parsed;
				try { parsed = openingConfirmInputSchema.parse(JSON.parse(bodyRead.text)); } catch { return respond({ error: "invalid_request" }, 400); }
				if (parsed.command.context.siteId !== principal.siteId || parsed.command.context.poolId !== statusResult.operation.poolId) {
					return respond({ error: "unauthorized_context" }, 403);
				}
				const result = await env.INVENTORY_POOLS.getByName(statusResult.operation.poolId).confirmOpeningBalance(
					parsed.confirmation,
					parsed.command,
					{ principal: { kind: "human", id: principal.accountId, displayName: "Site Administrator", surface: "emdash" } },
				);
				if (!result.ok) {
					const status = ["confirmation_expired", "confirmation_mismatch", "confirmation_already_used", "confirmation_not_found"].includes(result.error) ? 409 : 400;
					return respond({ error: result.error, message: result.message }, status);
				}
				return respond(result.result, result.result.outcome === "rejected" ? 409 : 200);
			}

			if (request.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
			if (path === "/v1/operations") return respond({ operations: await account.operations() });
			const result = await account.status(principal.siteId);
			if (path === "/v1/status") return respond(result);
			if (result.status !== "ready") return respond({ error: "inventory_not_ready", connection: result }, 409);

			const pool = env.INVENTORY_POOLS.getByName(result.operation.poolId);

			if (path === "/v1/locations") {
				return respond(await pool.listLocations(result.operation.poolId));
			}

			if (path === "/v1/stock") {
				const skuId = url.searchParams.get("sku_id") ?? url.searchParams.get("skuId");
				if (!skuId) return respond({ error: "invalid_request", message: "sku_id is required" }, 400);
				const locationId = url.searchParams.get("location_id") ?? url.searchParams.get("locationId");
				if (locationId) {
					const balance = await pool.readSkuLocationBalance({
						poolId: result.operation.poolId,
						skuId,
						locationId,
					});
					return respond({ ok: true, balance });
				}
				const stock = await pool.readSkuStock({
					poolId: result.operation.poolId,
					skuId,
					scope: { kind: "all_locations" },
				});
				return respond({ ok: true, stock });
			}

			if (path === "/v1/receipts") {
				const locationId = url.searchParams.get("location_id") ?? url.searchParams.get("locationId");
				const receipts = await pool.readReceiptHistory({
					poolId: result.operation.poolId,
					scope: locationId ? { kind: "location", locationId } : { kind: "all_locations" },
				});
				return respond(receipts);
			}

			return new Response("Not Found", { status: 404 });
		} catch (error) {
			// DO RPC preserves message, not custom Error prototypes. No internal errors leak.
			const code = error instanceof Error ? error.message : "";
			if (["request_id_conflict", "site_already_connected"].includes(code)) return respond({ error: code }, 409);
			if (code === "operation_not_found") return respond({ error: code }, 404);
			if (code === "sku_not_registered") return respond({ error: code }, 404);
			if (code === "location_not_active") return respond({ error: code }, 409);
			if (error instanceof z.ZodError) return respond({ error: "invalid_request" }, 400);
			return respond({ error: "service_unavailable" }, 503);
		}
	};
}
export default class HostedInventoryService extends WorkerEntrypoint<HostedInventoryEnv> {
	async fetch(request: Request) { return createHostedInventoryHandler(this.env)(request); }
}
