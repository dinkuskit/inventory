import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createReadSkuLocationBalance } from "../../src/application/read-inventory.ts";
import {
	createCheckoutInventoryPort,
	createReleaseCheckoutBasket,
	createReserveCheckoutBasket,
} from "../../src/features/checkout-inventory/index.ts";
import { createCloudflareSqliteInventoryStore } from "../../src/storage/cloudflare-sqlite-inventory-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_checkout",
	displayName: "Checkout Operator",
	surface: "emdash",
});

async function seed(store, poolId) {
	await createFixtureLocation(store, { poolId });
	await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
	await createFixtureManagedSku(store, { poolId, skuId: "sku_shirt" });
	for (const [skuId, quantity, commandId, receiptId] of [
		["sku_hat", "3", "cmd_cf_opening_hat", "rcpt_cf_opening_hat"],
		["sku_shirt", "2", "cmd_cf_opening_shirt", "rcpt_cf_opening_shirt"],
	]) {
		const opening = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-09-30T10:00:00.000Z"),
			createReceiptId: () => receiptId,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.opening_balance",
				context: { siteId: "site_test", poolId, locationId: "location_north" },
				payload: { skuId, quantity: { value: quantity, unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{ skuId, locationId: "location_north", version: "0" }],
			},
			{ principal },
		);
		if (opening.outcome !== "committed") {
			throw new Error(`Cloudflare seed failed: ${opening.code}`);
		}
	}
}

function bindingFor(poolId, providerRef = "dinkuskit.inventory") {
	return {
		providerRef,
		poolId,
		defaultFulfillmentLocationId: "location_north",
	};
}

function request(poolId, operationId = "op_cf_checkout", providerRef) {
	return {
		operationId,
		binding: bindingFor(poolId, providerRef),
		requirements: [
			{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
			{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
		],
	};
}

function deps(store, poolId, prefix, providerRef) {
	let reservation = 0;
	let receipt = 0;
	return {
		store,
		binding: bindingFor(poolId, providerRef),
		now: () => new Date("2026-09-30T12:00:00.000Z"),
		createReservationId: () => `${prefix}_rsv_${++reservation}`,
		createReceiptId: () => `${prefix}_rcpt_${++receipt}`,
	};
}

describe("checkout inventory Cloudflare durable storage", () => {
	it("reserves, replays, and fences against workerd SQLite", async ({ expect }) => {
		const poolId = "pool_checkout_cf";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await seed(store, poolId);
			const factory = deps(store, poolId, "cf_checkout");
			const reserve = createReserveCheckoutBasket(factory);
			const held = await reserve(request(poolId), {
				principal,
				siteId: "site_test",
			});
			expect(held.outcome).toBe("reserved");
			expect(await reserve(request(poolId), { principal, siteId: "site_test" })).toEqual(
				held,
			);
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.reserved.value,
			).toBe("3");

			const released = await createReleaseCheckoutBasket(factory)(request(poolId), {
				principal,
				siteId: "site_test",
			});
			expect(released.outcome).toBe("released");
			expect(
				(
					await reserve(request(poolId), { principal, siteId: "site_test" })
				).outcome,
			).toBe("rejected");
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.available.value,
			).toBe("3");
		});
	});

	it("serializes scarce-stock concurrency inside one Durable Object", async ({
		expect,
	}) => {
		const poolId = "pool_checkout_cf_race";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await seed(store, poolId);
			const reserve = createReserveCheckoutBasket(
				deps(store, poolId, "cf_race"),
			);
			const [left, right] = await Promise.all([
				reserve(request(poolId, "op_left"), { principal, siteId: "site_test" }),
				reserve(request(poolId, "op_right"), { principal, siteId: "site_test" }),
			]);
			expect([left.outcome, right.outcome].sort()).toEqual([
				"rejected",
				"reserved",
			]);
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.reserved.value,
			).toBe("3");
		});
	});

	it("release-before-reserve and release-racing-reserve cannot reacquire", async ({
		expect,
	}) => {
		const poolId = "pool_checkout_cf_fence";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await seed(store, poolId);
			const factory = deps(store, poolId, "cf_fence");
			const port = createCheckoutInventoryPort({
				...factory,
				principal,
				siteId: "site_test",
			});
			expect(await port.release(request(poolId, "op_fence"))).toBe("released");
			expect(await port.reserve(request(poolId, "op_fence"))).toBe("rejected");

			const reserve = createReserveCheckoutBasket(factory);
			const release = createReleaseCheckoutBasket(factory);
			const raced = request(poolId, "op_race");
			const [reserveResult, releaseResult] = await Promise.all([
				reserve(raced, { principal, siteId: "site_test" }),
				release(raced, { principal, siteId: "site_test" }),
			]);
			expect(["rejected", "reserved"]).toContain(reserveResult.outcome);
			expect(releaseResult.outcome).toBe("released");
			expect(
				(await reserve(raced, { principal, siteId: "site_test" })).outcome,
			).toBe("rejected");
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.reserved.value,
			).toBe("0");
		});
	});

	it("rejects a binding mismatch on first call and after factory restart, and isolates a second workerd pool", async ({
		expect,
	}) => {
		const providerRef = "configured.opaque-handle";
		const poolId = "pool_checkout_cf_bound";
		const otherPoolId = "pool_checkout_cf_other";
		const stub = env.INVENTORY_POOLS.getByName(poolId);
		const otherStub = env.INVENTORY_POOLS.getByName(otherPoolId);
		await runInDurableObject(stub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId,
			});
			await seed(store, poolId);
			const factory = deps(store, poolId, "cf_bound", providerRef);
			const port = createCheckoutInventoryPort({
				...factory,
				principal,
				siteId: "site_test",
			});
			const mismatched = request(poolId, "op_cf_bound", "some.other.provider");
			expect(await port.reserve(mismatched)).toBe("rejected");
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.reserved.value,
			).toBe("0");

			const matched = request(poolId, "op_cf_bound", providerRef);
			expect(await port.reserve(matched)).toBe("reserved");
			const restarted = createCheckoutInventoryPort({
				...deps(store, poolId, "cf_bound_restart", providerRef),
				principal,
				siteId: "site_test",
			});
			expect(await restarted.reserve(mismatched)).toBe("rejected");
			expect(await restarted.reserve(matched)).toBe("reserved");
			expect(
				(
					await read({
						poolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.reserved.value,
			).toBe("3");
		});

		await runInDurableObject(otherStub, async (_instance, state) => {
			const store = createCloudflareSqliteInventoryStore({
				storage: state.storage,
				poolId: otherPoolId,
			});
			await seed(store, otherPoolId);
			const port = createCheckoutInventoryPort({
				...deps(store, otherPoolId, "cf_other", providerRef),
				principal,
				siteId: "site_test",
			});
			expect(await port.reserve(request(poolId, "op_cf_bound", providerRef))).toBe(
				"rejected",
			);
			expect(
				await port.reserve(request(otherPoolId, "op_cf_other", providerRef)),
			).toBe("reserved");
			const read = createReadSkuLocationBalance({ store });
			expect(
				(
					await read({
						poolId: otherPoolId,
						locationId: "location_north",
						skuId: "sku_hat",
					})
				).balance.reserved.value,
			).toBe("3");
		});
	});
});
