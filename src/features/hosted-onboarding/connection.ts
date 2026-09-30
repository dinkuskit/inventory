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
	getSite(id: string): SiteConnection | null;
	putSite(id: string, connection: SiteConnection): void;
	getRequest(id: string): string | null;
	putRequest(id: string, digest: string): void;
};
export type ConnectionStore = { transaction<T>(fn: (tx: ConnectionTransaction) => T): T };
export type ProvisionResult = { outcome: "committed"; locationId: string } | { outcome: "rejected"; code: string };
export class ConnectionError extends Error {
	readonly code: "request_id_conflict" | "site_already_connected" | "operation_not_found";
	constructor(code: "request_id_conflict" | "site_already_connected" | "operation_not_found") { super(code); this.code = code; }
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
	return { connect, status, listOperations: () => store.transaction(tx => tx.listOperations()) };
}
