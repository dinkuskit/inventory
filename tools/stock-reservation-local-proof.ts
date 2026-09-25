import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { createExecuteLocationCommand } from "../src/application/location-registry.ts";
import { createSetOpeningBalance } from "../src/application/set-opening-balance.ts";
import { createRegisterManagedSku } from "../src/features/managed-sku/index.ts";
import {
	createReleaseStock,
	createReserveStock,
	type ReleaseStockCommandV1,
	type ReserveStockCommandV1,
} from "../src/features/stock-reservation/index.ts";
import { createCloudflareSqliteInventoryStore } from "../src/storage/cloudflare-sqlite-inventory-store.ts";
import {
	initializeCloudflareInventorySchema,
	readCloudflareInventorySchemaStatus,
} from "../src/cloudflare/schema.ts";

const SITE_ID = "site_local_proof";
const POOL_ID = "pool_reservation_proof";
const LOCATION_ID = "location_proof_shelf";
const SKU_ID = "inventory_sku_proof_hat";

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

function reserveCommand(
	commandId: string,
	quantity: string,
): ReserveStockCommandV1 {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.reserve",
		context: { siteId: SITE_ID, poolId: POOL_ID, locationId: LOCATION_ID },
		payload: {
			skuId: SKU_ID,
			quantity: { value: quantity, unit: "each" },
			orderLine: { kind: "commerce.order_line", id: "OL-PROOF-1" },
		},
		references: [],
	};
}

function releaseCommand(): ReleaseStockCommandV1 {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_release",
		type: "stock.release",
		context: { siteId: SITE_ID, poolId: POOL_ID },
		payload: { reservationId: "rsv_proof_hat" },
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

	#schemaHistory(): number[] {
		return this.ctx.storage.sql
			.exec("SELECT version FROM inventory_schema_migrations ORDER BY version")
			.toArray()
			.map((row) => Number(row.version));
	}

	#upgradeExactV4(): { before: number[]; after: number[]; currentVersion: number } {
		const before = this.#schemaHistory();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DROP TABLE inventory_reservations").toArray();
			this.ctx.storage.sql.exec("DELETE FROM inventory_schema_migrations").toArray();
			this.ctx.storage.sql
				.exec(
					"INSERT INTO inventory_schema_migrations (version, applied_at) VALUES (4, 'v4-proof')",
				)
				.toArray();
		});
		initializeCloudflareInventorySchema(this.ctx.storage);
		return {
			before,
			after: this.#schemaHistory(),
			currentVersion: readCloudflareInventorySchemaStatus(this.ctx.storage).version,
		};
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

		const sku = await createRegisterManagedSku({
			store,
			now: () => new Date("2026-09-25T16:00:01.000Z"),
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
		if (sku.outcome !== "registered" && sku.outcome !== "existing") {
			throw new Error(`Proof SKU setup failed: ${sku.outcome}`);
		}

		const opening = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-09-25T16:00:02.000Z"),
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
			throw new Error(`Proof opening setup failed: ${opening.outcome}`);
		}
	}

	async #durableBalance() {
		const store = await this.#store();
		return store.readBalance({
			poolId: POOL_ID,
			locationId: LOCATION_ID,
			skuId: SKU_ID,
		});
	}

	async #commit() {
		const upgrade = this.#upgradeExactV4();
		await this.#ensureProofSetup();
		const store = await this.#store();
		const reserved = await createReserveStock({
			store,
			now: () => new Date("2026-09-25T16:01:00.000Z"),
			createReservationId: () => "rsv_proof_hat",
			createReceiptId: () => "rcpt_proof_reserve",
		})(reserveCommand("cmd_proof_reserve", "3"), { principal });
		const conflict = await createReserveStock({
			store,
			now: () => new Date("2026-09-25T16:01:30.000Z"),
			createReservationId: () => "must_not_mint_conflict",
			createReceiptId: () => "must_not_write_conflict",
		})(reserveCommand("cmd_proof_conflict", "4"), { principal });
		const released = await createReleaseStock({
			store,
			now: () => new Date("2026-09-25T16:02:00.000Z"),
			createReceiptId: () => "rcpt_proof_release",
		})(releaseCommand(), { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "commit",
			remote: false,
			upgrade,
			reserve: reserved,
			conflict,
			release: released,
			durable: { balance: await this.#durableBalance() },
		};
	}

	async #replay() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const result = await createReserveStock({
			store,
			now: () => new Date("2026-09-25T16:03:00.000Z"),
			createReservationId: () => "must_not_mint_replay",
			createReceiptId: () => "must_not_write_replay",
		})(reserveCommand("cmd_proof_reserve", "3"), { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "replay_after_restart",
			remote: false,
			result,
			durable: { balance: await this.#durableBalance() },
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
