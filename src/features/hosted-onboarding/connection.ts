import { z } from "zod";

const id = z.string().trim().min(1).max(200);
export const connectInputSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("create"), requestId: id, locationName: z.string().trim().min(1).max(200) }).strict(),
	z.object({ type: z.literal("reconnect"), requestId: id, operationId: id }).strict(),
]);
export type ConnectInput = z.infer<typeof connectInputSchema>;
/** Populated only by the resource server's verified access-token boundary. */
export type AccountPrincipal = Readonly<{ accountId: string; siteId: string }>;
export type Operation = Readonly<{
	operationId: string; poolId: string; locationName: string; locationId: string | null;
	commandId: string; originSiteId: string; status: "pending" | "ready" | "failed"; failureCode: string | null;
}>;
export type SiteConnection = Readonly<{ operationId: string; intent: string }>;
export type ConnectionResult = Readonly<{ status: "unconnected" }> | Readonly<{ status: "pending" | "ready" | "failed"; operation: Operation }>;
export type ConnectionTransaction = {
	getOperation(id: string): Operation | null;
	putOperation(operation: Operation): void;
	listOperations(): Operation[];
	listSites(): Array<{ siteId: string; connection: SiteConnection }>;
	getSite(id: string): SiteConnection | null;
	putSite(id: string, connection: SiteConnection): void;
	getRequest(id: string): string | null;
	putRequest(id: string, digest: string): void;
};
export type ConnectionStore = { transaction<T>(fn: (tx: ConnectionTransaction) => T): T };
export type AccountMetadataSnapshot = Readonly<{
	operations: readonly Operation[];
	sites: ReadonlyArray<{ siteId: string; connection: SiteConnection }>;
}>;
export type AccountOverviewPool = Readonly<{
	poolId: string;
	siteCount: number;
	provisioning: Operation["status"];
}>;
export type AccountOverviewSite = Readonly<{
	siteId: string;
	poolId: string;
	provisioning: Operation["status"];
}>;
export type AccountOverview = Readonly<{
	schema: "dinkuskit.inventory.account-overview/v1";
	snapshot: Readonly<{
		sampledAt: string;
		asOf: string;
		health: Readonly<{ availability: "unavailable"; reason: "live_pool_health_not_read" }>;
	}>;
	metadata: Readonly<{ availability: "available" }> | Readonly<{ availability: "unavailable"; reason: "service_unconfigured" | "read_unavailable" | "invalid_metadata" }>;
	counts: Readonly<{ pools: number; sites: number }> | null;
	pools: readonly AccountOverviewPool[] | null;
	sites: readonly AccountOverviewSite[] | null;
}>;
export type ProvisionResult = { outcome: "committed"; locationId: string } | { outcome: "rejected"; code: string };
export class ConnectionError extends Error {
	readonly code: "request_id_conflict" | "site_already_connected" | "operation_not_found";
	constructor(code: "request_id_conflict" | "site_already_connected" | "operation_not_found") { super(code); this.code = code; }
}

function overviewSnapshot(sampledAt: string): Pick<AccountOverview, "schema" | "snapshot"> {
	return {
		schema: "dinkuskit.inventory.account-overview/v1",
		snapshot: {
			sampledAt,
			asOf: sampledAt,
			health: { availability: "unavailable", reason: "live_pool_health_not_read" },
		},
	};
}

export function unavailableAccountOverview(
	sampledAt: string,
	reason: "service_unconfigured" | "read_unavailable" | "invalid_metadata" = "invalid_metadata",
): AccountOverview {
	return {
		...overviewSnapshot(sampledAt),
		metadata: { availability: "unavailable", reason },
		counts: null,
		pools: null,
		sites: null,
	};
}

export function projectAccountOverview(
	metadata: AccountMetadataSnapshot,
	clock: () => string = () => new Date().toISOString(),
): AccountOverview {
	const sampledAt = clock();
	try {
		const operations = [...metadata.operations].sort((a, b) => a.poolId.localeCompare(b.poolId) || a.operationId.localeCompare(b.operationId));
		const sites = [...metadata.sites].sort((a, b) => a.siteId.localeCompare(b.siteId));
		const seenOperationIds = new Set<string>();
		const seenPoolIds = new Set<string>();
		const seenCommandIds = new Set<string>();
		const seenOriginSiteIds = new Set<string>();
		for (const operation of operations) {
			if (
				typeof operation.operationId !== "string" || !operation.operationId ||
				typeof operation.poolId !== "string" || !operation.poolId ||
				typeof operation.commandId !== "string" || !operation.commandId ||
				typeof operation.originSiteId !== "string" || !operation.originSiteId ||
				!["pending", "ready", "failed"].includes(operation.status) ||
				seenOperationIds.has(operation.operationId) ||
				seenPoolIds.has(operation.poolId) ||
				seenCommandIds.has(operation.commandId) ||
				seenOriginSiteIds.has(operation.originSiteId)
			) throw new Error("invalid metadata");
			seenOperationIds.add(operation.operationId);
			seenPoolIds.add(operation.poolId);
			seenCommandIds.add(operation.commandId);
			seenOriginSiteIds.add(operation.originSiteId);
		}
		const seenSiteIds = new Set<string>();
		for (const { siteId, connection } of sites) {
			if (
				typeof siteId !== "string" || !siteId ||
				typeof connection?.operationId !== "string" || !connection.operationId ||
				seenSiteIds.has(siteId)
			) throw new Error("invalid metadata");
			seenSiteIds.add(siteId);
		}
		const byId = new Map(operations.map((operation) => [operation.operationId, operation]));
		const siteRows = sites.map(({ siteId, connection }) => {
			const operation = byId.get(connection.operationId);
			if (!operation) throw new Error("invalid relation");
			return { siteId, poolId: operation.poolId, provisioning: operation.status };
		});
		for (const operation of operations) {
			if (!siteRows.some((site) => site.siteId === operation.originSiteId && site.poolId === operation.poolId && site.provisioning === operation.status)) {
				throw new Error("invalid relation");
			}
		}
		const pools = new Map<string, AccountOverviewPool>();
		for (const operation of operations) {
			const existing = pools.get(operation.poolId);
			if (existing && existing.provisioning !== operation.status) throw new Error("invalid relation");
			if (!existing) pools.set(operation.poolId, {
				poolId: operation.poolId,
				siteCount: siteRows.filter((site) => site.poolId === operation.poolId).length,
				provisioning: operation.status,
			});
		}
		return {
			...overviewSnapshot(sampledAt),
			metadata: { availability: "available" },
			counts: { pools: pools.size, sites: siteRows.length },
			pools: [...pools.values()].sort((a, b) => a.poolId.localeCompare(b.poolId)),
			sites: siteRows,
		};
	} catch {
		return unavailableAccountOverview(sampledAt);
	}
}

export function createAccountConnections(dependencies: {
	store: ConnectionStore;
	newId: () => string;
	provision: (operation: Operation, principal: AccountPrincipal) => Promise<ProvisionResult>;
}) {
	const { store } = dependencies;
	function status(siteId: string): ConnectionResult {
		return store.transaction(tx => {
			const connection = tx.getSite(siteId);
			if (!connection) return { status: "unconnected" };
			const operation = tx.getOperation(connection.operationId);
			if (!operation) throw new Error("Broken operation binding");
			return { status: operation.status, operation };
		});
	}
	async function connect(principal: AccountPrincipal, rawInput: ConnectInput): Promise<ConnectionResult> {
		const input = connectInputSchema.parse(rawInput);
		const intent = input.type === "create" ? JSON.stringify(["create", input.locationName.normalize("NFKC").toLowerCase()]) : JSON.stringify(["reconnect", input.operationId]);
		const requestKey = JSON.stringify([principal.siteId, input.requestId]);
		const operation = store.transaction(tx => {
			const previous = tx.getRequest(requestKey);
			if (previous !== null && previous !== intent) throw new ConnectionError("request_id_conflict");
			const existing = tx.getSite(principal.siteId);
			let selected: Operation;
			if (input.type === "reconnect") {
				const found = tx.getOperation(input.operationId);
				if (!found) throw new ConnectionError("operation_not_found");
				if (existing && existing.operationId !== found.operationId) throw new ConnectionError("site_already_connected");
				selected = found;
			} else if (existing) {
				if (existing.intent !== intent) throw new ConnectionError("site_already_connected");
				const found = tx.getOperation(existing.operationId);
				if (!found) throw new Error("Broken operation binding");
				selected = found;
			} else {
				const operationId = dependencies.newId();
				selected = { operationId, poolId: `pool_${operationId}`, commandId: `onboarding_${operationId}`, originSiteId: principal.siteId, locationName: input.locationName, locationId: null, status: "pending", failureCode: null };
				tx.putOperation(selected);
			}
			// Persist the pool identity and frozen location command before any network hop.
			tx.putRequest(requestKey, intent);
			tx.putSite(principal.siteId, { operationId: selected.operationId, intent: existing?.intent ?? intent });
			return selected;
		});
		if (operation.status !== "pending") return status(principal.siteId);
		let result: ProvisionResult;
		try { result = await dependencies.provision(operation, principal); }
		catch { return status(principal.siteId); } // Unknown outcome. Retain the same pool and command for retry.
		store.transaction(tx => {
			const current = tx.getOperation(operation.operationId);
			// A delayed retry cannot regress a terminal result committed by another caller.
			if (!current || current.status !== "pending") return;
			tx.putOperation(result.outcome === "committed"
				? { ...current, status: "ready", locationId: result.locationId }
				: { ...current, status: "failed", failureCode: result.code });
		});
		return status(principal.siteId);
	}
	return {
		connect,
		status,
		listOperations: () => store.transaction(tx => tx.listOperations()),
		listSites: () => store.transaction(tx => tx.listSites()),
		readMetadata: () => store.transaction(tx => ({
			operations: tx.listOperations(),
			sites: tx.listSites(),
		})),
	};
}
