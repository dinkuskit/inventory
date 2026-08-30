import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { createExecuteLocationCommand } from "../src/application/location-registry.ts";
import { createReadReceiptHistory } from "../src/application/read-inventory.ts";
import { createSetOpeningBalance } from "../src/application/set-opening-balance.ts";
import { createRegisterManagedSku } from "../src/features/managed-sku/index.ts";
import {
	createConfirmStockAdjustment,
	createPreviewStockAdjustment,
	type AdjustStockCommandV1,
} from "../src/features/stock-adjustment/index.ts";
import { createCloudflareSqliteInventoryStore } from "../src/storage/cloudflare-sqlite-inventory-store.ts";
import { initializeCloudflareInventorySchema } from "../src/cloudflare/schema.ts";

const SITE_ID = "site_local_proof";
const POOL_ID = "pool_stock_adjustment_proof";
const LOCATION_ID = "location_proof_shelf";
const SKU_ID = "inventory_sku_proof_hat";
const CONFIRMATION = "proof_confirmation_value_not_logged";

const principal = Object.freeze({
	kind: "human" as const,
	id: "proof_operator",
	displayName: "Proof Operator",
	surface: "local-wrangler-proof",
});

type ProofAction = "commit" | "replay";

interface StockAdjustmentProofEnv {
	STOCK_ADJUSTMENT_PROOF_POOLS: DurableObjectNamespace<StockAdjustmentProofPool>;
}

function adjustmentCommand(expectedVersion: string): AdjustStockCommandV1 {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_stock_adjustment",
		type: "stock.adjust",
		context: { siteId: SITE_ID, poolId: POOL_ID, locationId: LOCATION_ID },
		payload: { skuId: SKU_ID, delta: { value: "-3", unit: "each" } },
		reason: { note: "Three proof hats damaged" },
		references: [],
		expectedVersions: [{ skuId: SKU_ID, locationId: LOCATION_ID, version: expectedVersion }],
	};
}

export class StockAdjustmentProofPool extends DurableObject<StockAdjustmentProofEnv> {
	constructor(ctx: DurableObjectState, env: StockAdjustmentProofEnv) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			initializeCloudflareInventorySchema(ctx.storage);
		});
	}

	async #store() {
		return createCloudflareSqliteInventoryStore({
			storage: this.ctx.storage,
			poolId: POOL_ID,
		});
	}

	async #ensureProofSetup(): Promise<void> {
		const store = await this.#store();
		const location = await createExecuteLocationCommand({
			store,
			now: () => new Date("2026-08-30T19:00:00.000Z"),
			createLocationId: () => LOCATION_ID,
			createReceiptId: () => "rcpt_proof_location",
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_proof_location",
				type: "location.create",
				context: { siteId: SITE_ID, poolId: POOL_ID },
				payload: { name: "Proof Shelf" },
				references: [],
			},
			{ principal },
		);
		if (location.outcome !== "committed") {
			throw new Error(`Proof location setup failed: ${location.code}`);
		}

		const sku = await createRegisterManagedSku({
			store,
			now: () => new Date("2026-08-30T19:00:01.000Z"),
			createInventorySkuId: () => SKU_ID,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_proof_register_sku",
				type: "sku.register",
				context: { siteId: SITE_ID, poolId: POOL_ID },
				payload: {
					sku: "PROOF-HAT",
					displayNameIfNew: "Proof Hat",
					unit: "each",
				},
				references: [],
			},
			{ principal },
		);
		if (sku.outcome !== "registered") {
			throw new Error(`Proof SKU setup failed: ${sku.outcome}`);
		}

		const opening = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-08-30T19:00:02.000Z"),
			createReceiptId: () => "rcpt_proof_opening",
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId: "cmd_proof_opening",
				type: "stock.opening_balance",
				context: { siteId: SITE_ID, poolId: POOL_ID, locationId: LOCATION_ID },
				payload: { skuId: SKU_ID, quantity: { value: "10", unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{ skuId: SKU_ID, locationId: LOCATION_ID, version: "0" }],
			},
			{ principal },
		);
		if (opening.outcome !== "committed") {
			throw new Error(`Proof opening setup failed: ${opening.code}`);
		}
	}

	async #durableSummary() {
		const store = await this.#store();
		const [balance, history] = await Promise.all([
			store.readBalance({ poolId: POOL_ID, locationId: LOCATION_ID, skuId: SKU_ID }),
			createReadReceiptHistory({ store })({
				poolId: POOL_ID,
				scope: { kind: "location", locationId: LOCATION_ID },
			}),
		]);
		return {
			balance,
			receiptTypes: history.receipts.map((receipt) => receipt.type),
			adjustmentReceiptCount: history.receipts.filter(
				(receipt) => receipt.type === "stock.adjust",
			).length,
		};
	}

	async #commit() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const preview = await createPreviewStockAdjustment({
			store,
			now: () => new Date("2026-08-30T19:01:00.000Z"),
			createConfirmation: () => CONFIRMATION,
		})(
			{
				schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1",
				type: "stock.adjust",
				context: { siteId: SITE_ID, poolId: POOL_ID, locationId: LOCATION_ID },
				payload: { skuId: SKU_ID, delta: { value: "-3", unit: "each" } },
				reason: { note: "Three proof hats damaged" },
				references: [],
			},
			{ principal },
		);
		const command = adjustmentCommand(preview.effect.balanceBefore.version);
		const result = await createConfirmStockAdjustment({
			store,
			now: () => new Date("2026-08-30T19:01:01.000Z"),
			createReceiptId: () => "rcpt_proof_stock_adjustment",
		})(preview.confirmation.value, command, { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "commit",
			remote: false,
			preview: {
				effect: preview.effect,
				reason: preview.reason,
				warnings: preview.warnings,
				confirmation: "<redacted>",
				confirmationExpiresAt: preview.confirmation.expiresAt,
			},
			result,
			durable: await this.#durableSummary(),
		};
	}

	async #replay() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const result = await createConfirmStockAdjustment({
			store,
			now: () => new Date("2026-08-30T19:01:02.000Z"),
			createReceiptId: () => "must_not_be_used_for_replay",
		})(CONFIRMATION, adjustmentCommand("1"), { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "replay_after_restart",
			remote: false,
			confirmation: "<redacted>",
			result,
			durable: await this.#durableSummary(),
		};
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "method_not_allowed" }, { status: 405 });
		}
		try {
			const input = (await request.json()) as { action?: unknown };
			if (input.action !== "commit" && input.action !== "replay") {
				return Response.json({ error: "invalid_action" }, { status: 400 });
			}
			const action: ProofAction = input.action;
			return Response.json(action === "commit" ? await this.#commit() : await this.#replay());
		} catch (error) {
			return Response.json(
				{
					error: "proof_failed",
					message: error instanceof Error ? error.message : "Unknown proof failure.",
				},
				{ status: 500 },
			);
		}
	}
}

export default class StockAdjustmentLocalProof extends WorkerEntrypoint<StockAdjustmentProofEnv> {
	async fetch(request: Request): Promise<Response> {
		return this.env.STOCK_ADJUSTMENT_PROOF_POOLS.getByName(POOL_ID).fetch(request);
	}
}
