// Authenticated client for the hosted Inventory API. It only moves requests and
// responses; balances, versions and business rules stay in the service.
import { CliError, EXIT, createHttp, expectJson, usageError, validateEndpoint } from "../cli/kernel.mjs";

export const TOKEN_ENV = "DINKUS_INVENTORY_TOKEN";

export function resolveConnection(ctx) {
	const endpointText = ctx.config.resolve("endpoint");
	if (!endpointText) {
		throw usageError("No Inventory endpoint. Pass --endpoint, set DINKUS_INVENTORY_ENDPOINT, or add it to a profile.", "missing_endpoint");
	}
	const siteId = ctx.config.resolve("site");
	if (!siteId) throw usageError("No site. Pass --site, set DINKUS_INVENTORY_SITE, or add it to a profile.", "missing_site");
	const token = ctx.env[TOKEN_ENV];
	if (!token) {
		throw new CliError("missing_credential", `Set ${TOKEN_ENV} to an Inventory access token for this site.`, { exit: EXIT.blocked });
	}
	return { endpoint: validateEndpoint(endpointText), siteId, token };
}

export function createInventoryClient(ctx, connection = resolveConnection(ctx)) {
	const request = createHttp({
		baseUrl: connection.endpoint,
		headers: { authorization: `Bearer ${connection.token}`, "x-inventory-site": connection.siteId },
		timeoutMs: ctx.timeoutMs,
		fetchImpl: ctx.fetchImpl,
		signal: ctx.signal,
	});
	const get = async (path, query, what) => expectJson(await request("GET", path, { query }), what);
	return {
		connection,
		request,
		status: () => get("/v1/status", undefined, "Read connection status"),
		locations: () => get("/v1/locations", undefined, "List locations"),
		skus: () => get("/v1/skus", undefined, "List SKUs"),
		stock: (skuId, locationId) => get("/v1/stock", { sku_id: skuId, location_id: locationId }, "Read stock"),
		receipts: (locationId) => get("/v1/receipts", { location_id: locationId }, "Read receipts"),
		openingEligibility: (skuId, locationId) =>
			get("/v1/stock/opening/eligibility", { sku_id: skuId, location_id: locationId }, "Read opening-balance eligibility"),
		async preview(path, body, what) {
			const response = await request("POST", path, { body });
			if (response.status === 409 && typeof response.json?.error === "string") {
				throw new CliError(response.json.error, response.json.message ?? `${what} was rejected (${response.json.error}).`, {
					exit: EXIT.failure,
					outcome: "rejected",
				});
			}
			return expectJson(response, what);
		},
	};
}

// Every command except `status` first proves the site is connected and that an
// explicitly named pool is the pool the service binds to this site.
export async function readyContext(client, { poolId } = {}) {
	const status = await client.status();
	if (status.status !== "ready" || typeof status.operation?.poolId !== "string") {
		throw new CliError("inventory_not_ready", `Inventory is not ready for site ${client.connection.siteId} (status: ${status.status ?? "unknown"}).`, {
			exit: EXIT.failure,
		});
	}
	if (poolId !== undefined && poolId !== status.operation.poolId) {
		throw new CliError("pool_mismatch", `Site ${client.connection.siteId} is bound to a different pool than --pool ${poolId}.`, {
			exit: EXIT.blocked,
		});
	}
	return { siteId: client.connection.siteId, poolId: status.operation.poolId };
}
