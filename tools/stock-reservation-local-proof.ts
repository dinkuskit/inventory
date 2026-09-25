import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { createExecuteLocationCommand } from "../src/application/location-registry.ts";
import { createSetOpeningBalance } from "../src/application/set-opening-balance.ts";
import { createRegisterManagedSku } from "../src/features/managed-sku/index.ts";
import {
	createPackStock,
	type PackStockCommandV1,
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

function packCommand(): PackStockCommandV1 {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_pack",
		type: "stock.pack",
		context: { siteId: SITE_ID, poolId: POOL_ID },
		payload: { reservationId: "rsv_proof_hat" },
		references: [],
	};
}

const V5_RESERVATION = Object.freeze({
	schema: "dinkuskit.inventory.reservation/v1",
	reservationId: "rsv_proof_hat",
	poolId: POOL_ID,
	locationId: LOCATION_ID,
	skuId: SKU_ID,
	quantity: { value: "3", unit: "each" },
	orderLine: { kind: "commerce.order_line", id: "OL-PROOF-1" },
	status: "active",
	version: "1",
	createdAt: "2026-09-25T16:01:00.000Z",
	canceledAt: null,
	createdBy: principal,
	canceledBy: null,
});

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

	#upgradeExactV5Hold(): {
		before: number[];
		after: number[];
		currentVersion: number;
		upgradedHold: { packedAt: unknown; packedBy: unknown; status: unknown };
	} {
		const before = this.#schemaHistory();
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec("DROP TABLE inventory_reservations").toArray();
			this.ctx.storage.sql
				.exec(
					`CREATE TABLE inventory_reservations (
						pool_id TEXT NOT NULL,
						reservation_id TEXT NOT NULL,
						order_line_key TEXT NOT NULL,
						status TEXT NOT NULL CHECK (status IN ('active', 'canceled')),
						version INTEGER NOT NULL CHECK (version >= 1),
						reservation_json TEXT NOT NULL,
						PRIMARY KEY (pool_id, reservation_id)
					) STRICT`,
				)
				.toArray();
			this.ctx.storage.sql
				.exec(
					`CREATE UNIQUE INDEX inventory_reservations_active_order_line
					 ON inventory_reservations (pool_id, order_line_key)
					 WHERE status = 'active'`,
				)
				.toArray();
			this.ctx.storage.sql
				.exec(
					`INSERT INTO inventory_reservations
					   (pool_id, reservation_id, order_line_key, status, version, reservation_json)
					 VALUES (?, ?, ?, 'active', 1, ?)`,
					POOL_ID,
					"rsv_proof_hat",
					JSON.stringify(["commerce.order_line", "OL-PROOF-1"]),
					JSON.stringify(V5_RESERVATION),
				)
				.toArray();
			this.ctx.storage.sql
				.exec(
					`UPDATE inventory_balances
					 SET reserved_value = '3', available_value = '7', version = 2
					 WHERE pool_id = ? AND location_id = ? AND sku_id = ?`,
					POOL_ID,
					LOCATION_ID,
					SKU_ID,
				)
				.toArray();
			this.ctx.storage.sql.exec("DELETE FROM inventory_schema_migrations").toArray();
			this.ctx.storage.sql
				.exec(
					"INSERT INTO inventory_schema_migrations (version, applied_at) VALUES (5, 'v5-proof')",
				)
				.toArray();
		});
		initializeCloudflareInventorySchema(this.ctx.storage);
		const upgraded = JSON.parse(
			String(
				this.ctx.storage.sql
					.exec(
						"SELECT reservation_json FROM inventory_reservations WHERE reservation_id = 'rsv_proof_hat'",
					)
					.one().reservation_json,
				),
		);
		return {
			before,
			after: this.#schemaHistory(),
			currentVersion: readCloudflareInventorySchemaStatus(this.ctx.storage).version,
			upgradedHold: {
				packedAt: upgraded.packedAt,
				packedBy: upgraded.packedBy,
				status: upgraded.status,
			},
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
		await this.#ensureProofSetup();
		const upgrade = this.#upgradeExactV5Hold();
		const store = await this.#store();
		const packed = await createPackStock({
			store,
			now: () => new Date("2026-09-25T16:05:00.000Z"),
			createReceiptId: () => "rcpt_proof_pack",
		})(packCommand(), { principal });
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "commit",
			remote: false,
			upgrade,
			pack: packed,
			durable: { balance: await this.#durableBalance() },
		};
	}

	async #replay() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const result = await createPackStock({
			store,
			now: () => new Date("2026-09-25T16:06:00.000Z"),
			createReceiptId: () => "must_not_write_replay",
		})(packCommand(), { principal });
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
