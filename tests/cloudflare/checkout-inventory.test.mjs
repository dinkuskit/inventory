import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, it } from "vitest";

import { createSetOpeningBalance } from "../../src/application/set-opening-balance.ts";
import { createReadSkuLocationBalance } from "../../src/application/read-inventory.ts";
import {
	checkoutReleaseCommandId,
	checkoutReserveCommandId,
	createCheckoutInventoryPort,
	createReleaseCheckoutBasket,
	createReserveCheckoutBasket,
	digestCheckoutStockRequest,
	normalizeStockRequest,
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

function snapshotDurableCheckoutState(storage) {
	return {
		commands: storage.sql
			.exec(
				`SELECT command_id, command_digest, terminal_result_json
				 FROM inventory_command_results
				 ORDER BY command_id`,
			)
			.toArray(),
		receipts: storage.sql
			.exec(
				`SELECT receipt_id, command_id, receipt_json
				 FROM inventory_receipts
				 ORDER BY receipt_id`,
			)
			.toArray(),
		reservations: storage.sql
			.exec(
				`SELECT pool_id, reservation_id, order_line_key, status, version,
				        reservation_json
				 FROM inventory_reservations
				 ORDER BY reservation_id`,
			)
			.toArray(),
	};
}

function rowsForCommand(rows, commandId) {
	return rows.filter((row) => String(row.command_id) === commandId);
}

function parsedJson(value) {
	return JSON.parse(String(value));
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

	it("wrong-site release-first conflicts without persisting reserve in both directions", async ({
		expect,
	}) => {
		const recoveryPrincipal = Object.freeze({
			kind: "human",
			id: "principal_recovery",
			displayName: "Recovery Operator",
			surface: "emdash",
		});
		for (const [releaseSite, foreignSite] of [
			["site_beta", "site_alpha"],
			["site_alpha", "site_beta"],
		]) {
			const poolId = `pool_checkout_cf_site_fence_${releaseSite}`;
			const stub = env.INVENTORY_POOLS.getByName(poolId);
			await runInDurableObject(stub, async (_instance, state) => {
				const store = createCloudflareSqliteInventoryStore({
					storage: state.storage,
					poolId,
				});
				await seed(store, poolId);
				const factory = deps(store, poolId, `cf_site_fence_${releaseSite}`);
				const reserve = createReserveCheckoutBasket(factory);
				const release = createReleaseCheckoutBasket(factory);
				const shared = request(poolId, "op_shared_release_first");
				const control = request(poolId, "op_current_hold");
				const currentHold = await reserve(control, {
					principal,
					siteId: foreignSite,
				});
				expect(currentHold.outcome).toBe("reserved");

				const firstRelease = await release(shared, {
					principal,
					siteId: releaseSite,
				});
				expect(firstRelease.outcome).toBe("released");
				const controlReserveId = checkoutReserveCommandId(control.operationId);
				const sharedReserveId = checkoutReserveCommandId(shared.operationId);
				const sharedReleaseId = checkoutReleaseCommandId(shared.operationId);
				const releaseBefore = await store.readCommand(sharedReleaseId);
				expect(releaseBefore.result.outcome).toBe("released");
				expect(releaseBefore.commandDigest).toBe(
					await digestCheckoutStockRequest(
						normalizeStockRequest(shared),
						releaseSite,
					),
				);

				const beforeForeign = snapshotDurableCheckoutState(state.storage);
				expect(
					beforeForeign.reservations.map((row) =>
						parsedJson(row.reservation_json),
					),
				).toEqual(currentHold.reservations);
				expect(
					rowsForCommand(beforeForeign.receipts, controlReserveId).map((row) =>
						parsedJson(row.receipt_json),
					),
				).toEqual([currentHold.receipt]);
				expect(
					rowsForCommand(beforeForeign.commands, sharedReleaseId).map((row) =>
						parsedJson(row.terminal_result_json),
					),
				).toEqual([firstRelease]);
				expect(rowsForCommand(beforeForeign.commands, sharedReserveId)).toEqual(
					[],
				);
				expect(rowsForCommand(beforeForeign.receipts, sharedReserveId)).toEqual(
					[],
				);

				const foreignReserve = await reserve(shared, {
					principal,
					siteId: foreignSite,
				});
				expect(foreignReserve.outcome).toBe("rejected");
				expect(foreignReserve.code).toBe("command_id_conflict");
				expect(await store.readCommand(sharedReserveId)).toBeNull();
				expect(await store.readCommand(sharedReleaseId)).toEqual(releaseBefore);
				const afterForeign = snapshotDurableCheckoutState(state.storage);
				expect(afterForeign).toEqual(beforeForeign);
				expect(rowsForCommand(afterForeign.receipts, sharedReserveId)).toEqual(
					[],
				);
				expect(
					await reserve(shared, { principal, siteId: foreignSite }),
				).toEqual(foreignReserve);
				expect(snapshotDurableCheckoutState(state.storage)).toEqual(
					beforeForeign,
				);

				expect(
					await release(shared, {
						principal: recoveryPrincipal,
						siteId: releaseSite,
					}),
				).toEqual(firstRelease);
				expect(snapshotDurableCheckoutState(state.storage)).toEqual(
					beforeForeign,
				);

				const ownerReserve = await reserve(shared, {
					principal: recoveryPrincipal,
					siteId: releaseSite,
				});
				expect(ownerReserve.outcome).toBe("rejected");
				expect(ownerReserve.code).toBe("checkout_released");
				const storedOwnerReserve = await store.readCommand(sharedReserveId);
				expect(storedOwnerReserve.result.code).toBe("checkout_released");
				expect(storedOwnerReserve.commandDigest).toBe(
					await digestCheckoutStockRequest(
						normalizeStockRequest(shared),
						releaseSite,
					),
				);
				expect(
					await reserve(shared, { principal, siteId: releaseSite }),
				).toEqual(ownerReserve);
				expect(await store.readCommand(sharedReleaseId)).toEqual(releaseBefore);

				const afterOwnerFence = snapshotDurableCheckoutState(state.storage);
				expect(afterOwnerFence.receipts).toEqual(beforeForeign.receipts);
				expect(afterOwnerFence.reservations).toEqual(beforeForeign.reservations);
				expect(rowsForCommand(afterOwnerFence.receipts, sharedReserveId)).toEqual(
					[],
				);
				expect(
					rowsForCommand(afterOwnerFence.commands, sharedReleaseId),
				).toEqual(rowsForCommand(beforeForeign.commands, sharedReleaseId));
				expect(
					rowsForCommand(afterOwnerFence.commands, sharedReserveId).map((row) =>
						parsedJson(row.terminal_result_json),
					),
				).toEqual([ownerReserve]);

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

				const restartedReserve = createReserveCheckoutBasket(
					deps(store, poolId, `cf_site_fence_restart_${releaseSite}`),
				);
				const restartedRelease = createReleaseCheckoutBasket(
					deps(store, poolId, `cf_site_fence_restart_${releaseSite}`),
				);
				expect(
					await restartedRelease(shared, {
						principal: recoveryPrincipal,
						siteId: releaseSite,
					}),
				).toEqual(firstRelease);
				expect(
					await restartedReserve(shared, { principal, siteId: foreignSite }),
				).toEqual(foreignReserve);
				expect(
					await restartedReserve(shared, {
						principal: recoveryPrincipal,
						siteId: releaseSite,
					}),
				).toEqual(ownerReserve);
				expect(snapshotDurableCheckoutState(state.storage)).toEqual(
					afterOwnerFence,
				);
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
		}
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
			const heldTickets = {
				outcome: "reserved",
				ticketIds: ["cf_bound_rsv_1", "cf_bound_rsv_2"],
			};
			expect(await port.reserve(matched)).toEqual(heldTickets);
			const restarted = createCheckoutInventoryPort({
				...deps(store, poolId, "cf_bound_restart", providerRef),
				principal,
				siteId: "site_test",
			});
			expect(await restarted.reserve(mismatched)).toBe("rejected");
			expect(await restarted.reserve(matched)).toEqual(heldTickets);
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
			).toEqual({
				outcome: "reserved",
				ticketIds: ["cf_other_rsv_1", "cf_other_rsv_2"],
			});
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
