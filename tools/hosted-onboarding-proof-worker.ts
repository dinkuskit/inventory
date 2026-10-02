/** Local proof only. Never a deploy target; accepts ephemeral synthetic issuer keys. */
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { createAccountAuthenticator } from "../src/cloudflare/account-auth.ts";
import { createHostedInventoryHandler, type HostedInventoryEnv, InventoryAccount, InventoryPool } from "../src/cloudflare/hosted-worker.ts";
import { createCloudflareSqliteInventoryStore } from "../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createRegisterManagedSku } from "../src/features/managed-sku/index.ts";
import { createSetOpeningBalance, type SetOpeningBalanceExecution } from "../src/application/set-opening-balance.ts";
import type { OpeningBalanceResult, SetOpeningBalanceCommandV1 } from "../src/domain/opening-balance.ts";

export class ProofInventoryPool extends InventoryPool {
	/** Test harness helper to seed managed SKU and opening balance in SQLite DO storage */
	async seedOpeningBalance(
		command: SetOpeningBalanceCommandV1,
		execution: SetOpeningBalanceExecution,
	): Promise<OpeningBalanceResult> {
		const store = createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: command.context.poolId,
		});
		const registerSku = createRegisterManagedSku({
			store,
			now: () => new Date(),
			createInventorySkuId: () => command.payload.skuId,
		});
		await registerSku({
			schema: "dinkuskit.inventory.command/v1",
			commandId: `cmd_reg_${command.payload.skuId}`,
			type: "sku.register",
			context: { siteId: command.context.siteId, poolId: command.context.poolId },
			payload: {
				sku: `VISIBLE-${command.payload.skuId}`,
				displayNameIfNew: command.payload.skuId,
				unit: command.payload.quantity.unit as "each",
			},
			references: [],
		}, execution);

		const setOpening = createSetOpeningBalance({
			store,
			now: () => new Date(),
			createReceiptId: () => crypto.randomUUID(),
		});
		return setOpening(command, execution);
	}
}

export { InventoryAccount, ProofInventoryPool as InventoryPool };
export default {
	async fetch(request: Request, env: HostedInventoryEnv & { PROOF_JWKS: string }) {
		const auth = createAccountAuthenticator({ issuer: "https://accounts.dinkuskit.invalid", jwksUrl: "https://accounts.dinkuskit.invalid/jwks", audience: "inventory" }, createLocalJWKSet(JSON.parse(env.PROOF_JWKS) as JSONWebKeySet));
		return createHostedInventoryHandler(env, auth)(request);
	},
};
