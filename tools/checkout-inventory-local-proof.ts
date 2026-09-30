import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

import { createExecuteLocationCommand } from "../src/application/location-registry.ts";
import { createSetOpeningBalance } from "../src/application/set-opening-balance.ts";
import { createRegisterManagedSku } from "../src/features/managed-sku/index.ts";
import {
	createCheckoutInventoryPort,
	createReleaseCheckoutBasket,
	createReserveCheckoutBasket,
} from "../src/features/checkout-inventory/index.ts";
import { createCloudflareSqliteInventoryStore } from "../src/storage/cloudflare-sqlite-inventory-store.ts";
import { initializeCloudflareInventorySchema } from "../src/cloudflare/schema.ts";

const SITE_ID = "site_local_proof";
const POOL_ID = "pool_checkout_proof";
const LOCATION_ID = "location_proof_shelf";
const HAT_SKU = "sku_hat";
const SHIRT_SKU = "sku_shirt";

const principal = Object.freeze({
	kind: "human" as const,
	id: "proof_operator",
	displayName: "Proof Operator",
	surface: "local-wrangler-proof",
});

const binding = Object.freeze({
	providerRef: "dinkuskit.inventory",
	poolId: POOL_ID,
	defaultFulfillmentLocationId: LOCATION_ID,
});

type ProofAction = "commit" | "replay" | "race";

interface CheckoutInventoryProofEnv {
	CHECKOUT_INVENTORY_PROOF_POOLS: DurableObjectNamespace<CheckoutInventoryProofPool>;
}

function request(operationId: string) {
	return {
		operationId,
		binding,
		requirements: [
			{ skuId: HAT_SKU, quantity: 3, allowBackorders: false },
			{ skuId: SHIRT_SKU, quantity: 2, allowBackorders: false },
		],
	};
}

export class CheckoutInventoryProofPool extends DurableObject<CheckoutInventoryProofEnv> {
	constructor(ctx: DurableObjectState, env: CheckoutInventoryProofEnv) {
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
			now: () => new Date("2026-09-30T16:00:00.000Z"),
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
		for (const [skuId, sku, displayName, commandId] of [
			[HAT_SKU, "PROOF-HAT", "Proof Hat", "cmd_proof_register_hat"],
			[SHIRT_SKU, "PROOF-SHIRT", "Proof Shirt", "cmd_proof_register_shirt"],
		] as const) {
			const registered = await createRegisterManagedSku({
				store,
				now: () => new Date("2026-09-30T16:00:01.000Z"),
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
			if (registered.outcome !== "registered" && registered.outcome !== "existing") {
				throw new Error(`Proof SKU setup failed: ${registered.outcome}`);
			}
		}
		for (const [skuId, quantity, commandId, receiptId] of [
			[HAT_SKU, "10", "cmd_proof_opening_hat", "rcpt_proof_opening_hat"],
			[SHIRT_SKU, "6", "cmd_proof_opening_shirt", "rcpt_proof_opening_shirt"],
		] as const) {
			const opening = await createSetOpeningBalance({
				store,
				now: () => new Date("2026-09-30T16:00:02.000Z"),
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
		let reservation = 0;
		const deps = {
			store,
			binding,
			now: () => new Date("2026-09-30T16:01:00.000Z"),
			createReservationId: () => `rsv_proof_${++reservation}`,
			createReceiptId: () => "rcpt_proof_reserve",
		};
		const reserve = createReserveCheckoutBasket(deps);
		const held = await reserve(request("op_proof_checkout"), {
			principal,
			siteId: SITE_ID,
		});
		const replay = await reserve(request("op_proof_checkout"), {
			principal,
			siteId: SITE_ID,
		});
		const short = await reserve(
			{
				operationId: "op_proof_short",
				binding,
				requirements: [
					{ skuId: HAT_SKU, quantity: 8, allowBackorders: false },
					{ skuId: SHIRT_SKU, quantity: 1, allowBackorders: false },
				],
			},
			{ principal, siteId: SITE_ID },
		);
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "commit",
			remote: false,
			held: held.outcome,
			replay: replay.outcome,
			sameResult: JSON.stringify(held) === JSON.stringify(replay),
			short: short.outcome,
			durable: { balances: await this.#durableBalances() },
		};
	}

	async #replay() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		const reserve = createReserveCheckoutBasket({
			store,
			binding,
			now: () => new Date("2026-09-30T16:02:00.000Z"),
			createReservationId: () => "must_not_mint",
			createReceiptId: () => "must_not_write",
		});
		const replay = await reserve(request("op_proof_checkout"), {
			principal,
			siteId: SITE_ID,
		});
		const released = await createReleaseCheckoutBasket({
			store,
			binding,
			now: () => new Date("2026-09-30T16:03:00.000Z"),
			createReservationId: () => "unused",
			createReceiptId: () => "rcpt_proof_release",
		})(request("op_proof_checkout"), { principal, siteId: SITE_ID });
		const fenced = await reserve(request("op_proof_checkout"), {
			principal,
			siteId: SITE_ID,
		});
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "replay_after_restart",
			remote: false,
			replay: replay.outcome,
			released: released.outcome,
			fenced: fenced.outcome,
			durable: { balances: await this.#durableBalances() },
		};
	}

	async #race() {
		await this.#ensureProofSetup();
		const store = await this.#store();
		let reservation = 0;
		const reserve = createReserveCheckoutBasket({
			store,
			binding,
			now: () => new Date("2026-09-30T16:04:00.000Z"),
			createReservationId: () => `rsv_race_${++reservation}`,
			createReceiptId: () => `rcpt_race_${reservation}`,
		});
		const scarce = {
			binding,
			requirements: [
				{ skuId: HAT_SKU, quantity: 10, allowBackorders: false },
				{ skuId: SHIRT_SKU, quantity: 6, allowBackorders: false },
			],
		};
		const [left, right] = await Promise.all([
			reserve({ ...scarce, operationId: "op_race_left" }, { principal, siteId: SITE_ID }),
			reserve({ ...scarce, operationId: "op_race_right" }, { principal, siteId: SITE_ID }),
		]);
		const port = createCheckoutInventoryPort({
			store,
			binding,
			now: () => new Date("2026-09-30T16:05:00.000Z"),
			createReservationId: () => "unused",
			createReceiptId: () => "rcpt_fence",
			principal,
			siteId: SITE_ID,
		});
		const fence = await port.release({
			operationId: "op_release_first",
			binding,
			requirements: [
				{ skuId: HAT_SKU, quantity: 1, allowBackorders: false },
			],
		});
		const afterFence = await port.reserve({
			operationId: "op_release_first",
			binding,
			requirements: [
				{ skuId: HAT_SKU, quantity: 1, allowBackorders: false },
			],
		});
		return {
			proof: "real-local-wrangler-durable-object",
			phase: "race",
			remote: false,
			outcomes: [left.outcome, right.outcome].sort(),
			fence,
			afterFence,
			durable: { balances: await this.#durableBalances() },
		};
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return Response.json({ error: "method_not_allowed" }, { status: 405 });
		}
		try {
			const input = (await request.json()) as { action?: unknown };
			if (input.action !== "commit" && input.action !== "replay" && input.action !== "race") {
				return Response.json({ error: "invalid_action" }, { status: 400 });
			}
			const action: ProofAction = input.action;
			if (action === "commit") return Response.json(await this.#commit());
			if (action === "replay") return Response.json(await this.#replay());
			return Response.json(await this.#race());
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

export default class CheckoutInventoryLocalProof extends WorkerEntrypoint<CheckoutInventoryProofEnv> {
	async fetch(request: Request): Promise<Response> {
		return this.env.CHECKOUT_INVENTORY_PROOF_POOLS.getByName(POOL_ID).fetch(request);
	}
}
