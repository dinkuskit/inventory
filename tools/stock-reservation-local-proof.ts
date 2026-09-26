import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { createExecuteLocationCommand } from "../src/application/location-registry.ts";
import { createSetOpeningBalance } from "../src/application/set-opening-balance.ts";
import { createRegisterManagedSku } from "../src/features/managed-sku/index.ts";
import {
	createPackAllStock,
	createReserveStock,
	type PackAllStockCommandV1,
	type ReserveStockCommandV1,
} from "../src/features/stock-reservation/index.ts";
import { createCloudflareSqliteInventoryStore } from "../src/storage/cloudflare-sqlite-inventory-store.ts";
import { initializeCloudflareInventorySchema } from "../src/cloudflare/schema.ts";

const SITE_ID = "site_local_proof";
const POOL_ID = "pool_reservation_proof";
const LOCATION_ID = "location_proof_shelf";
const HAT_SKU = "inventory_sku_proof_hat";
const SHIRT_SKU = "inventory_sku_proof_shirt";

const principal = Object.freeze({
	kind: "human" as const,
	id: "proof_operator",
	displayName: "Proof Operator",
	surface: "local-wrangler-proof",
});

type ProofAction = "commit" | "replay";

interface StockReservationProofEnv {
	STOCK_RESERVATION_PROOF_POOLS: DurableObjectNamespace<StockReservationProofPool>;
}

function packAllCommand(): PackAllStockCommandV1 {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_pack_all",
		type: "stock.pack_all",
		context: { siteId: SITE_ID, poolId: POOL_ID },
		payload: { reservationIds: ["rsv_proof_hat", "rsv_proof_shirt"] },
		references: [],
	};
}

function reserveCommand(
	commandId: string,
	skuId: string,
	quantity: string,
	lineId: string,
): ReserveStockCommandV1 {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.reserve",
		context: { siteId: SITE_ID, poolId: POOL_ID, locationId: LOCATION_ID },
		payload: {
			skuId,
			quantity: { value: quantity, unit: "each" },
			orderLine: { kind: "commerce.order_line", id: lineId },
		},
		references: [],
	};
}

export class StockReservationProofPool extends DurableObject<StockReservationProofEnv> {
	constructor(ctx: DurableObjectState, env: StockReservationProofEnv) {
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

	async #registerSku(skuId: string, sku: string, displayName: string, commandId: string) {
		const store = await this.#store();
		const result = await createRegisterManagedSku({
			store,
			now: () => new Date("2026-09-25T16:00:01.000Z"),
			createInventorySkuId: () => skuId,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "sku.register",
				context: { siteId: SITE_ID, poolId: POOL_ID },
				payload: { sku, displayNameIfNew: displayName, unit: "each" },
				references: [],
			},
			{ principal },
		);
		if (result.outcome !== "registered" && result.outcome !== "existing") {
			throw new Error(`Proof SKU setup failed: ${result.outcome}`);
		}
	}

	async #openSku(skuId: string, quantity: string, commandId: string, receiptId: string) {
		const store = await this.#store();
		const opening = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-09-25T16:00:02.000Z"),
			createReceiptId: () => receiptId,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.opening_balance",
				context: { siteId: SITE_ID, poolId: POOL_ID, locationId: LOCATION_ID },
				payload: { skuId, quantity: { value: quantity, unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{ skuId, locationId: LOCATION_ID, version: "0" }],
			},
			{ principal },
		);
		if (opening.outcome !== "committed") {
			throw new Error(`Proof opening setup failed: ${opening.outcome}`);
		}
	}

	async #ensureProofSetup(): Promise<void> {
		const store = await this.#store();
		const location = await createExecuteLocationCommand({
			store,
			now: () => new Date("2026-09-25T16:00:00.000Z"),
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
			throw new Error(`Proof location setup failed: ${location.outcome}`);
		}
		await this.#registerSku(HAT_SKU, "PROOF-HAT", "Proof Hat", "cmd_proof_register_hat");
		await this.#registerSku(
			SHIRT_SKU,
			"PROOF-SHIRT",
			"Proof Shirt",
			"cmd_proof_register_shirt",
		);
		await this.#openSku(HAT_SKU, "10", "cmd_proof_opening_hat", "rcpt_proof_opening_hat");
		await this.#openSku(
			SHIRT_SKU,
			"6",
			"cmd_proof_opening_shirt",
			"rcpt_proof_opening_shirt",
		);
	}

	async #durableBalances() {
		const store = await this.#store();
		return {
			hat: await store.readBalance({
				poolId: POOL_ID,
				locationId: LOCATION_ID,
				skuId: HAT_SKU,
			}),
			shirt: await store.readBalance({
				poolId: POOL_ID,
				locationId: LOCATION_ID,
				skuId: SHIRT_SKU,
			}),
		};
	}

	async #commit() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const hat = await createReserveStock({
			store,
			now: () => new Date("2026-09-25T16:01:00.000Z"),
			createReservationId: () => "rsv_proof_hat",
			createReceiptId: () => "rcpt_proof_reserve_hat",
		})(reserveCommand("cmd_proof_reserve_hat", HAT_SKU, "3", "OL-PROOF-HAT"), {
			principal,
		});
		const shirt = await createReserveStock({
			store,
			now: () => new Date("2026-09-25T16:01:01.000Z"),
			createReservationId: () => "rsv_proof_shirt",
			createReceiptId: () => "rcpt_proof_reserve_shirt",
		})(reserveCommand("cmd_proof_reserve_shirt", SHIRT_SKU, "2", "OL-PROOF-SHIRT"), {
			principal,
		});
		const packed = await createPackAllStock({
			store,
			now: () => new Date("2026-09-25T16:05:00.000Z"),
			createReceiptId: () => "rcpt_proof_pack_all",
		})(packAllCommand(), { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "commit",
			remote: false,
			reserve: { hat: hat.outcome, shirt: shirt.outcome },
			packAll: packed,
			durable: { balances: await this.#durableBalances() },
		};
	}

	async #replay() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const result = await createPackAllStock({
			store,
			now: () => new Date("2026-09-25T16:06:00.000Z"),
			createReceiptId: () => "must_not_write_replay",
		})(packAllCommand(), { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "replay_after_restart",
			remote: false,
			result,
			durable: { balances: await this.#durableBalances() },
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

export default class StockReservationLocalProof extends WorkerEntrypoint<StockReservationProofEnv> {
	async fetch(request: Request): Promise<Response> {
		return this.env.STOCK_RESERVATION_PROOF_POOLS.getByName(POOL_ID).fetch(request);
	}
}
