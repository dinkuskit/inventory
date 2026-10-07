import { DurableObject } from "cloudflare:workers";
import { ConnectionError, createAccountConnections, projectAccountOverview, unavailableAccountOverview, type AccountPrincipal, type ConnectInput, type ConnectionStore, type Operation, type SiteConnection } from "../features/hosted-onboarding/index.ts";
import type { HostedInventoryEnv } from "./hosted-worker.ts";

/** Control-plane metadata only. Stock remains in InventoryPool's kernel tables. */
export class InventoryAccount extends DurableObject<HostedInventoryEnv> {
	constructor(ctx: DurableObjectState, env: HostedInventoryEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS account_connections (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))");
		});
	}
	private connections() {
		const sql = this.ctx.storage.sql;
		const get = <T>(kind: string, id: string): T | null => {
			const row = sql.exec<{ value: string }>("SELECT value FROM account_connections WHERE kind = ? AND id = ?", kind, id).toArray()[0];
			return row ? JSON.parse(row.value) : null;
		};
		const put = (kind: string, id: string, value: unknown) => {
			sql.exec("INSERT INTO account_connections (kind,id,value) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value", kind, id, JSON.stringify(value));
		};
		const store: ConnectionStore = { transaction: fn => this.ctx.storage.transactionSync(() => fn({
			getOperation: id => get<Operation>("operation", id), putOperation: op => put("operation", op.operationId, op),
			listOperations: () => sql.exec<{ value: string }>("SELECT value FROM account_connections WHERE kind='operation' ORDER BY id").toArray().map(row => JSON.parse(row.value)),
			listSites: () => sql.exec<{ id: string; value: string }>("SELECT id, value FROM account_connections WHERE kind='site' ORDER BY id").toArray().map(row => ({ siteId: row.id, connection: JSON.parse(row.value) })),
			getSite: id => get<SiteConnection>("site", id), putSite: (id, connection) => put("site", id, connection),
			getRequest: id => get<string>("request", id), putRequest: (id, digest) => put("request", id, digest),
		})) };
		return createAccountConnections({ store, newId: () => crypto.randomUUID(), provision: async (operation, principal) => {
			return this.env.INVENTORY_POOLS.getByName(operation.poolId).provisionFirstLocation(operation, principal);
		} });
	}
	async connectAccount(principal: AccountPrincipal, input: ConnectInput) {
		try { return await this.connections().connect(principal, input); }
		catch (error) { if (error instanceof ConnectionError) return { status: "rejected" as const, error: error.code }; throw error; }
	}
	async status(siteId: string) { return this.connections().status(siteId); }
	async operations() { return this.connections().listOperations(); }
	async readOverview() {
		const sampledAt = new Date().toISOString();
		let metadata;
		try {
			metadata = this.connections().readMetadata();
		} catch {
			return unavailableAccountOverview(sampledAt, "read_unavailable");
		}
		return projectAccountOverview(metadata, () => sampledAt);
	}
}
