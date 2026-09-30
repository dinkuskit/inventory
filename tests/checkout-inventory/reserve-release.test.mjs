import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import {
	InvalidCheckoutInventoryRequestError,
	checkoutReleaseCommandId,
	checkoutReserveCommandId,
	createCheckoutInventoryPort,
	createReadSkuLocationBalance,
	createReleaseCheckoutBasket,
	createReleaseStock,
	createReserveCheckoutBasket,
	createReserveStock,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "principal_checkout_operator",
	displayName: "Checkout Operator",
	surface: "test",
});

const binding = Object.freeze({
	providerRef: "dinkuskit.inventory",
	poolId: "pool_test",
	defaultFulfillmentLocationId: "location_north",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-checkout-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function seedBasket(store, { hat = "10", shirt = "6" } = {}) {
	await createFixtureLocation(store);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	await createFixtureManagedSku(store, { skuId: "sku_shirt" });
	for (const [skuId, quantity, commandId, receiptId] of [
		["sku_hat", hat, "cmd_opening_hat", "rcpt_opening_hat"],
		["sku_shirt", shirt, "cmd_opening_shirt", "rcpt_opening_shirt"],
	]) {
		const result = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-09-30T10:00:00.000Z"),
			createReceiptId: () => receiptId,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.opening_balance",
				context: {
					siteId: "site_test",
					poolId: "pool_test",
					locationId: "location_north",
				},
				payload: { skuId, quantity: { value: quantity, unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [
					{ skuId, locationId: "location_north", version: "0" },
				],
			},
			{ principal },
		);
		assert.equal(result.outcome, "committed");
	}
}

function stockRequest(overrides = {}) {
	return {
		operationId: "op_checkout_hat_shirt",
		binding: { ...binding },
		requirements: [
			{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
			{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
		],
		...overrides,
	};
}

function factories(store, ids = {}) {
	let reservation = 0;
	let receipt = 0;
	return {
		store,
		binding: ids.binding ?? binding,
		now: () => new Date("2026-09-30T12:00:00.000Z"),
		createReservationId:
			ids.createReservationId ??
			(() => `rsv_checkout_${String(++reservation).padStart(3, "0")}`),
		createReceiptId:
			ids.createReceiptId ??
			(() => `rcpt_checkout_${String(++receipt).padStart(3, "0")}`),
	};
}

async function balances(store) {
	const read = createReadSkuLocationBalance({ store });
	return {
		hat: (
			await read({
				poolId: "pool_test",
				locationId: "location_north",
				skuId: "sku_hat",
			})
		).balance,
		shirt: (
			await read({
				poolId: "pool_test",
				locationId: "location_north",
				skuId: "sku_shirt",
			})
		).balance,
	};
}

function wrapPostcommitLostResponse(store) {
	const originalRunTransaction = store.runTransaction.bind(store);
	let thrown = false;
	let captured = null;
	store.runTransaction = async (poolId, operation) => {
		const value = await originalRunTransaction(poolId, operation);
		if (!thrown) {
			thrown = true;
			captured = value;
			throw new Error("lost service response after commit");
		}
		return value;
	};
	return {
		get captured() {
			return captured;
		},
	};
}

function durableMutationCounts(filePath, commandId) {
	const database = new DatabaseSync(filePath);
	try {
		const count = (sql, ...params) =>
			Number(database.prepare(sql).get(...params).n);
		return {
			commandResults: count(
				"SELECT COUNT(*) AS n FROM inventory_command_results WHERE command_id = ?",
				commandId,
			),
			receipts: count(
				"SELECT COUNT(*) AS n FROM inventory_receipts WHERE command_id = ?",
				commandId,
			),
			reservations: count("SELECT COUNT(*) AS n FROM inventory_reservations"),
			openReservations: count(
				"SELECT COUNT(*) AS n FROM inventory_reservations WHERE status IN ('not_shipped', 'partially_packed')",
			),
		};
	} finally {
		database.close();
	}
}

const configuredBinding = Object.freeze({
	providerRef: "configured.opaque-handle",
	poolId: "pool_test",
	defaultFulfillmentLocationId: "location_north",
});

test("reserve holds the whole basket and replays after SQLite restart", async (t) => {
	const filePath = await databasePath(t, "restart");
	const store = createLocalSqliteTestStore({ filePath });
	await seedBasket(store);
	const reserve = createReserveCheckoutBasket(factories(store));
	const first = await reserve(stockRequest(), { principal, siteId: "site_test" });
	assert.equal(first.outcome, "reserved");
	assert.equal(first.reservations.length, 2);
	assert.deepEqual((await balances(store)).hat.reserved.value, "3");
	assert.deepEqual((await balances(store)).shirt.reserved.value, "2");
	assert.deepEqual((await balances(store)).hat.available.value, "7");
	await store.close();

	const reopened = createLocalSqliteTestStore({ filePath });
	const replay = await createReserveCheckoutBasket(factories(reopened))(
		stockRequest(),
		{ principal, siteId: "site_test" },
	);
	assert.equal(replay.outcome, "reserved");
	assert.deepEqual(replay, first);
	assert.deepEqual((await balances(reopened)).hat.reserved.value, "3");
	assert.deepEqual((await balances(reopened)).shirt.reserved.value, "2");
});

test("one insufficient SKU rejects the basket and leaves no holds", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "partial"),
	});
	await seedBasket(store, { hat: "10", shirt: "1" });
	const result = await createReserveCheckoutBasket(factories(store))(
		stockRequest(),
		{ principal, siteId: "site_test" },
	);
	assert.equal(result.outcome, "rejected");
	assert.equal(result.code, "insufficient_available");
	assert.equal((await balances(store)).hat.reserved.value, "0");
	assert.equal((await balances(store)).shirt.reserved.value, "0");
	assert.equal((await balances(store)).hat.available.value, "10");
	assert.equal((await balances(store)).shirt.available.value, "1");
});

test("duplicate reserve and release replay the original result without a second mutation", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "idempotent"),
	});
	await seedBasket(store);
	const deps = factories(store);
	const reserve = createReserveCheckoutBasket(deps);
	const release = createReleaseCheckoutBasket(deps);
	const held = await reserve(stockRequest(), { principal, siteId: "site_test" });
	assert.equal(held.outcome, "reserved");
	assert.deepEqual(
		await reserve(stockRequest(), { principal, siteId: "site_test" }),
		held,
	);
	const released = await release(stockRequest(), {
		principal,
		siteId: "site_test",
	});
	assert.equal(released.outcome, "released");
	assert.deepEqual(
		await release(stockRequest(), { principal, siteId: "site_test" }),
		released,
	);
	assert.equal((await balances(store)).hat.reserved.value, "0");
	assert.equal((await balances(store)).shirt.reserved.value, "0");
	assert.equal((await balances(store)).hat.available.value, "10");
});

test("lost reserve response after SQLite commit recovers the original durable hold", async (t) => {
	const filePath = await databasePath(t, "lost-reserve");
	const store = createLocalSqliteTestStore({ filePath });
	await seedBasket(store);
	const loss = wrapPostcommitLostResponse(store);
	const request = stockRequest({
		operationId: "op_lost_reserve",
		binding: configuredBinding,
	});
	const port = createCheckoutInventoryPort({
		...factories(store, { binding: configuredBinding }),
		principal,
		siteId: "site_test",
	});
	assert.equal(await port.reserve(request), "unknown");
	assert.equal(loss.captured?.outcome, "reserved");
	assert.equal(loss.captured.reservations.length, 2);
	assert.equal((await balances(store)).hat.reserved.value, "3");
	assert.equal((await balances(store)).shirt.reserved.value, "2");
	assert.equal((await balances(store)).hat.available.value, "7");
	assert.equal((await balances(store)).shirt.available.value, "4");
	const reserveCommandId = checkoutReserveCommandId(request.operationId);
	const stored = await store.readCommand(reserveCommandId);
	assert.deepEqual(stored.result, loss.captured);
	await store.close();
	const afterLoss = durableMutationCounts(filePath, reserveCommandId);
	assert.deepEqual(afterLoss, {
		commandResults: 1,
		receipts: 1,
		reservations: 2,
		openReservations: 2,
	});

	const reopened = createLocalSqliteTestStore({ filePath });
	const replayPort = createCheckoutInventoryPort({
		...factories(reopened, { binding: configuredBinding }),
		principal,
		siteId: "site_test",
	});
	assert.equal(await replayPort.reserve(request), "reserved");
	const replayed = await createReserveCheckoutBasket(
		factories(reopened, { binding: configuredBinding }),
	)(request, { principal, siteId: "site_test" });
	assert.deepEqual(replayed, loss.captured);
	assert.deepEqual(await reopened.readCommand(reserveCommandId), stored);
	assert.equal(replayed.receipt.receiptId, loss.captured.receipt.receiptId);
	assert.deepEqual(
		replayed.reservations.map((hold) => hold.reservationId),
		loss.captured.reservations.map((hold) => hold.reservationId),
	);
	assert.equal((await balances(reopened)).hat.reserved.value, "3");
	assert.equal((await balances(reopened)).shirt.reserved.value, "2");
	await reopened.close();
	assert.deepEqual(durableMutationCounts(filePath, reserveCommandId), afterLoss);
});

test("lost release response after SQLite commit recovers the original fence", async (t) => {
	const filePath = await databasePath(t, "lost-release");
	const store = createLocalSqliteTestStore({ filePath });
	await seedBasket(store);
	const request = stockRequest({
		operationId: "op_lost_release",
		binding: configuredBinding,
	});
	const liveDeps = factories(store, { binding: configuredBinding });
	const held = await createReserveCheckoutBasket(liveDeps)(request, {
		principal,
		siteId: "site_test",
	});
	assert.equal(held.outcome, "reserved");
	const loss = wrapPostcommitLostResponse(store);
	const port = createCheckoutInventoryPort({
		...liveDeps,
		principal,
		siteId: "site_test",
	});
	assert.equal(await port.release(request), "unknown");
	assert.equal(loss.captured?.outcome, "released");
	assert.equal(loss.captured.reservations.length, 2);
	assert.equal((await balances(store)).hat.reserved.value, "0");
	assert.equal((await balances(store)).shirt.reserved.value, "0");
	assert.equal((await balances(store)).hat.available.value, "10");
	const delayed = await createReserveCheckoutBasket(liveDeps)(request, {
		principal,
		siteId: "site_test",
	});
	assert.equal(delayed.outcome, "rejected");
	assert.equal(delayed.code, "checkout_released");
	assert.equal((await balances(store)).hat.reserved.value, "0");
	const releaseCommandId = checkoutReleaseCommandId(request.operationId);
	const stored = await store.readCommand(releaseCommandId);
	assert.deepEqual(stored.result, loss.captured);
	await store.close();
	const afterLoss = durableMutationCounts(filePath, releaseCommandId);
	assert.deepEqual(afterLoss, {
		commandResults: 1,
		receipts: 1,
		reservations: 2,
		openReservations: 0,
	});

	const reopened = createLocalSqliteTestStore({ filePath });
	const replayPort = createCheckoutInventoryPort({
		...factories(reopened, { binding: configuredBinding }),
		principal,
		siteId: "site_test",
	});
	assert.equal(await replayPort.release(request), "released");
	const replayed = await createReleaseCheckoutBasket(
		factories(reopened, { binding: configuredBinding }),
	)(request, { principal, siteId: "site_test" });
	assert.deepEqual(replayed, loss.captured);
	assert.deepEqual(await reopened.readCommand(releaseCommandId), stored);
	assert.equal(replayed.receipt.receiptId, loss.captured.receipt.receiptId);
	assert.deepEqual(
		replayed.reservations.map((hold) => hold.reservationId),
		loss.captured.reservations.map((hold) => hold.reservationId),
	);
	assert.equal((await balances(reopened)).hat.reserved.value, "0");
	assert.equal((await balances(reopened)).shirt.reserved.value, "0");
	assert.equal((await balances(reopened)).hat.available.value, "10");
	const later = await createReserveCheckoutBasket(
		factories(reopened, { binding: configuredBinding }),
	)(request, { principal, siteId: "site_test" });
	assert.equal(later.outcome, "rejected");
	assert.equal(later.code, "checkout_released");
	await reopened.close();
	assert.deepEqual(
		durableMutationCounts(filePath, releaseCommandId),
		afterLoss,
	);
});

test("release-before-reserve and later reserve replay cannot reacquire", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "fence"),
	});
	await seedBasket(store);
	const deps = factories(store);
	const reserve = createReserveCheckoutBasket(deps);
	const release = createReleaseCheckoutBasket(deps);
	const fenced = await release(stockRequest(), { principal, siteId: "site_test" });
	assert.equal(fenced.outcome, "released");
	assert.equal(fenced.reservations.length, 0);
	const later = await reserve(stockRequest(), { principal, siteId: "site_test" });
	assert.equal(later.outcome, "rejected");
	assert.equal(later.code, "checkout_released");
	assert.equal((await balances(store)).hat.reserved.value, "0");
	assert.equal((await balances(store)).hat.available.value, "10");
	assert.deepEqual(
		await reserve(stockRequest(), { principal, siteId: "site_test" }),
		later,
	);
});

test("changed contents reject without extra holds", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "conflict"),
	});
	await seedBasket(store);
	const reserve = createReserveCheckoutBasket(factories(store));
	const held = await reserve(stockRequest(), { principal, siteId: "site_test" });
	assert.equal(held.outcome, "reserved");
	const result = await reserve(
		stockRequest({
			requirements: [
				{ skuId: "sku_hat", quantity: 4, allowBackorders: false },
				{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
			],
		}),
		{ principal, siteId: "site_test" },
	);
	assert.equal(result.outcome, "rejected");
	assert.equal(result.code, "command_id_conflict");
	assert.equal((await balances(store)).hat.reserved.value, "3");
});

test("configured binding mismatch rejects on first call and after factory restart", async (t) => {
	const filePath = await databasePath(t, "binding");
	const configured = Object.freeze({
		providerRef: "configured.opaque-handle",
		poolId: "pool_test",
		defaultFulfillmentLocationId: "location_north",
	});
	const store = createLocalSqliteTestStore({ filePath });
	await seedBasket(store);
	const firstPort = createCheckoutInventoryPort({
		...factories(store, { binding: configured }),
		principal,
		siteId: "site_test",
	});
	const mismatched = stockRequest({
		binding: { ...configured, providerRef: "some.other.provider" },
	});
	assert.equal(await firstPort.reserve(mismatched), "rejected");
	assert.equal((await balances(store)).hat.reserved.value, "0");
	assert.equal((await balances(store)).shirt.reserved.value, "0");
	await assert.rejects(
		() =>
			createReserveCheckoutBasket(factories(store, { binding: configured }))(
				stockRequest({ binding: { ...configured, poolId: "pool_other" } }),
				{ principal, siteId: "site_test" },
			),
		InvalidCheckoutInventoryRequestError,
	);
	const matched = stockRequest({
		operationId: "op_bound_checkout",
		binding: configured,
	});
	assert.equal(await firstPort.reserve(matched), "reserved");
	assert.equal((await balances(store)).hat.reserved.value, "3");
	await store.close();

	const reopened = createLocalSqliteTestStore({ filePath });
	const restarted = createCheckoutInventoryPort({
		...factories(reopened, { binding: configured }),
		principal,
		siteId: "site_test",
	});
	assert.equal(await restarted.reserve(mismatched), "rejected");
	assert.equal(await restarted.reserve(matched), "reserved");
	assert.equal((await balances(reopened)).hat.reserved.value, "3");
	assert.equal((await balances(reopened)).shirt.reserved.value, "2");
});

test("a changed site cannot recover or mutate another site's hold", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "site"),
	});
	await seedBasket(store);
	const deps = factories(store);
	const reserve = createReserveCheckoutBasket(deps);
	const release = createReleaseCheckoutBasket(deps);
	const held = await reserve(stockRequest(), {
		principal,
		siteId: "site_alpha",
	});
	assert.equal(held.outcome, "reserved");
	const recovered = await reserve(stockRequest(), {
		principal: {
			kind: "human",
			id: "principal_recovery",
			displayName: "Recovery Operator",
			surface: "test",
		},
		siteId: "site_alpha",
	});
	assert.deepEqual(recovered, held);
	const otherSite = await reserve(stockRequest(), {
		principal,
		siteId: "site_beta",
	});
	assert.equal(otherSite.outcome, "rejected");
	assert.equal(otherSite.code, "command_id_conflict");
	const otherRelease = await release(stockRequest(), {
		principal,
		siteId: "site_beta",
	});
	assert.equal(otherRelease.outcome, "rejected");
	assert.equal(otherRelease.code, "command_id_conflict");
	assert.equal((await balances(store)).hat.reserved.value, "3");
	assert.equal((await balances(store)).shirt.reserved.value, "2");
});

test("colon-bearing operation and SKU IDs keep distinct holds", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "colon-key"),
	});
	await seedBasket(store);
	for (const [skuId, commandId, receiptId] of [
		["c", "cmd_opening_c", "rcpt_opening_c"],
		["b:c", "cmd_opening_bc", "rcpt_opening_bc"],
	]) {
		await createFixtureManagedSku(store, { skuId });
		const opening = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-09-30T10:00:00.000Z"),
			createReceiptId: () => receiptId,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.opening_balance",
				context: {
					siteId: "site_test",
					poolId: "pool_test",
					locationId: "location_north",
				},
				payload: { skuId, quantity: { value: "2", unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{ skuId, locationId: "location_north", version: "0" }],
			},
			{ principal },
		);
		assert.equal(opening.outcome, "committed");
	}
	const reserve = createReserveCheckoutBasket(factories(store));
	const left = await reserve(
		stockRequest({
			operationId: "a:b",
			requirements: [{ skuId: "c", quantity: 1, allowBackorders: false }],
		}),
		{ principal, siteId: "site_test" },
	);
	const right = await reserve(
		stockRequest({
			operationId: "a",
			requirements: [{ skuId: "b:c", quantity: 1, allowBackorders: false }],
		}),
		{ principal, siteId: "site_test" },
	);
	assert.equal(left.outcome, "reserved");
	assert.equal(right.outcome, "reserved");
	assert.notEqual(left.reservations[0].orderLine.id, right.reservations[0].orderLine.id);
});

test("release fails closed when reservation rows are missing or ambiguous", async (t) => {
	const missingPath = await databasePath(t, "release-missing");
	const missingStore = createLocalSqliteTestStore({ filePath: missingPath });
	await seedBasket(missingStore);
	const missingHeld = await createReserveCheckoutBasket(factories(missingStore))(
		stockRequest(),
		{ principal, siteId: "site_test" },
	);
	assert.equal(missingHeld.outcome, "reserved");
	await missingStore.close();
	const missingDb = new DatabaseSync(missingPath);
	missingDb.exec("DELETE FROM inventory_reservations");
	missingDb.close();
	const missingReopened = createLocalSqliteTestStore({ filePath: missingPath });
	await assert.rejects(
		() =>
			createReleaseCheckoutBasket(factories(missingReopened))(stockRequest(), {
				principal,
				siteId: "site_test",
			}),
		/cannot find a listed reservation row/u,
	);
	assert.equal(
		await createCheckoutInventoryPort({
			...factories(missingReopened),
			principal,
			siteId: "site_test",
		}).release(stockRequest()),
		"unknown",
	);
	assert.equal((await balances(missingReopened)).hat.reserved.value, "3");

	const livePath = await databasePath(t, "release-live");
	const liveStore = createLocalSqliteTestStore({ filePath: livePath });
	await seedBasket(liveStore);
	assert.equal(
		(
			await createReserveCheckoutBasket(factories(liveStore))(stockRequest(), {
				principal,
				siteId: "site_test",
			})
		).outcome,
		"reserved",
	);
	await liveStore.close();
	const liveDb = new DatabaseSync(livePath);
	liveDb.exec(
		"DELETE FROM inventory_command_results WHERE command_id = 'checkout.reserve:op_checkout_hat_shirt'",
	);
	liveDb.close();
	const liveReopened = createLocalSqliteTestStore({ filePath: livePath });
	await assert.rejects(
		() =>
			createReleaseCheckoutBasket(factories(liveReopened))(stockRequest(), {
				principal,
				siteId: "site_test",
			}),
		/unexpected live hold/u,
	);
	assert.equal((await balances(liveReopened)).hat.reserved.value, "3");

	const ambiguousPath = await databasePath(t, "release-ambiguous");
	const ambiguousStore = createLocalSqliteTestStore({ filePath: ambiguousPath });
	await seedBasket(ambiguousStore);
	assert.equal(
		(
			await createReserveCheckoutBasket(factories(ambiguousStore))(stockRequest(), {
				principal,
				siteId: "site_test",
			})
		).outcome,
		"reserved",
	);
	await ambiguousStore.close();
	const ambiguousDb = new DatabaseSync(ambiguousPath);
	ambiguousDb.exec(
		"UPDATE inventory_reservations SET reservation_id = reservation_id || '_tampered'",
	);
	ambiguousDb.close();
	const ambiguousReopened = createLocalSqliteTestStore({ filePath: ambiguousPath });
	await assert.rejects(
		() =>
			createReleaseCheckoutBasket(factories(ambiguousReopened))(stockRequest(), {
				principal,
				siteId: "site_test",
			}),
		/cannot find a listed reservation row|ambiguous reservation rows/u,
	);
	assert.equal((await balances(ambiguousReopened)).hat.reserved.value, "3");
});

test("unsupported backorder policy rejects the whole basket", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "backorder"),
	});
	await seedBasket(store);
	const result = await createReserveCheckoutBasket(factories(store))(
		stockRequest({
			requirements: [
				{ skuId: "sku_hat", quantity: 1, allowBackorders: true },
			],
		}),
		{ principal, siteId: "site_test" },
	);
	assert.equal(result.outcome, "rejected");
	assert.equal(result.code, "unsupported_backorder_policy");
	assert.equal((await balances(store)).hat.reserved.value, "0");
});

test("named-hold release still allows a new named hold outside checkout operations", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "named-hold"),
	});
	await seedBasket(store);
	const reserve = createReserveStock({
		store,
		now: () => new Date("2026-09-30T12:00:00.000Z"),
		createReservationId: () => "rsv_named_hat",
		createReceiptId: () => "rcpt_named_reserve",
	});
	const first = await reserve(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_named_reserve",
			type: "stock.reserve",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: {
				skuId: "sku_hat",
				quantity: { value: "2", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-named" },
			},
			references: [],
		},
		{ principal },
	);
	assert.equal(first.outcome, "reserved");
	const released = await createReleaseStock({
		store,
		now: () => new Date("2026-09-30T12:05:00.000Z"),
		createReceiptId: () => "rcpt_named_release",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_named_release",
			type: "stock.release",
			context: { siteId: "site_test", poolId: "pool_test" },
			payload: { reservationId: "rsv_named_hat" },
			references: [],
		},
		{ principal },
	);
	assert.equal(released.outcome, "released");
	const again = await createReserveStock({
		store,
		now: () => new Date("2026-09-30T12:06:00.000Z"),
		createReservationId: () => "rsv_named_hat_2",
		createReceiptId: () => "rcpt_named_reserve_2",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_named_reserve_2",
			type: "stock.reserve",
			context: {
				siteId: "site_test",
				poolId: "pool_test",
				locationId: "location_north",
			},
			payload: {
				skuId: "sku_hat",
				quantity: { value: "2", unit: "each" },
				orderLine: { kind: "commerce.order_line", id: "OL-named" },
			},
			references: [],
		},
		{ principal },
	);
	assert.equal(again.outcome, "reserved");
	assert.equal(again.reservation.reservationId, "rsv_named_hat_2");
});

test("precommit transaction interruption rolls back every basket hold", async (t) => {
	const filePath = await databasePath(t, "rollback");
	const store = createLocalSqliteTestStore({ filePath });
	await seedBasket(store);
	const inner = store.runTransaction.bind(store);
	store.runTransaction = async (poolId, operation) =>
		inner(poolId, (transaction) => {
			const original = transaction.commitStockReservationBatch.bind(transaction);
			transaction.commitStockReservationBatch = (input) => {
				original(input);
				throw new Error("interrupted after batch write");
			};
			return operation(transaction);
		});
	await assert.rejects(
		() =>
			createReserveCheckoutBasket(factories(store))(stockRequest(), {
				principal,
				siteId: "site_test",
			}),
		/interrupted after batch write/u,
	);
	await store.close();
	const reopened = createLocalSqliteTestStore({ filePath });
	assert.equal((await balances(reopened)).hat.reserved.value, "0");
	assert.equal((await balances(reopened)).shirt.reserved.value, "0");
	assert.equal((await balances(reopened)).hat.available.value, "10");
});

test("the public port maps durable results and rejects malformed requests", async (t) => {
	const store = createLocalSqliteTestStore({
		filePath: await databasePath(t, "port"),
	});
	await seedBasket(store);
	const port = createCheckoutInventoryPort({
		...factories(store),
		principal,
		siteId: "site_test",
	});
	assert.equal(await port.reserve(stockRequest()), "reserved");
	assert.equal(await port.reserve(stockRequest()), "reserved");
	assert.equal(await port.release(stockRequest()), "released");
	assert.equal(await port.reserve(stockRequest()), "rejected");
	assert.equal(await port.reserve({}), "rejected");
	assert.equal(await port.release({}), "unknown");
});

test("release racing reserve cannot leave reacquireable stock", async (t) => {
	const filePath = await databasePath(t, "race-release");
	const setup = createLocalSqliteTestStore({ filePath });
	await seedBasket(setup);
	await setup.close();
	const reserver = createLocalSqliteTestStore({ filePath });
	const releaser = createLocalSqliteTestStore({ filePath });
	const [reserveResult, releaseResult] = await Promise.all([
		createReserveCheckoutBasket(
			factories(reserver, { createReceiptId: () => "rcpt_race_reserve" }),
		)(stockRequest(), {
			principal,
			siteId: "site_test",
		}),
		createReleaseCheckoutBasket(
			factories(releaser, { createReceiptId: () => "rcpt_race_release" }),
		)(stockRequest(), {
			principal,
			siteId: "site_test",
		}),
	]);
	assert.ok(
		reserveResult.outcome === "reserved" || reserveResult.outcome === "rejected",
	);
	assert.equal(releaseResult.outcome, "released");
	const later = await createReserveCheckoutBasket(factories(reserver))(
		stockRequest(),
		{ principal, siteId: "site_test" },
	);
	assert.equal(later.outcome, "rejected");
	assert.equal((await balances(reserver)).hat.reserved.value, "0");
	assert.equal((await balances(reserver)).shirt.reserved.value, "0");
});

test("two SQLite connections serialize scarce stock so only one basket wins", async (t) => {
	const filePath = await databasePath(t, "two-conn");
	const setup = createLocalSqliteTestStore({ filePath });
	await seedBasket(setup, { hat: "3", shirt: "2" });
	await setup.close();
	const left = createLocalSqliteTestStore({ filePath });
	const right = createLocalSqliteTestStore({ filePath });
	const [first, second] = await Promise.all([
		createReserveCheckoutBasket(factories(left))(
			stockRequest({ operationId: "op_left" }),
			{ principal, siteId: "site_test" },
		),
		createReserveCheckoutBasket(factories(right))(
			stockRequest({ operationId: "op_right" }),
			{ principal, siteId: "site_test" },
		),
	]);
	const outcomes = [first.outcome, second.outcome].sort();
	assert.deepEqual(outcomes, ["rejected", "reserved"]);
	const reserved = first.outcome === "reserved" ? first : second;
	assert.equal(reserved.reservations.length, 2);
	const reader = createLocalSqliteTestStore({ filePath });
	assert.equal((await balances(reader)).hat.reserved.value, "3");
	assert.equal((await balances(reader)).shirt.reserved.value, "2");
	assert.equal((await balances(reader)).hat.available.value, "0");
});

test("two processes serialize scarce stock against one SQLite file", async (t) => {
	const filePath = await databasePath(t, "two-proc");
	const setup = createLocalSqliteTestStore({ filePath });
	await seedBasket(setup, { hat: "3", shirt: "2" });
	await setup.close();
	const worker = fileURLToPath(
		new URL("../../tools/checkout-inventory-concurrency-proof.mjs", import.meta.url),
	);
	const run = (operationId) =>
		new Promise((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					"--experimental-sqlite",
					"--experimental-strip-types",
					worker,
					filePath,
					operationId,
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("close", (code) => {
				if (code !== 0) {
					reject(new Error(stderr || `worker exited ${code}`));
					return;
				}
				resolve(JSON.parse(stdout));
			});
		});
	const [left, right] = await Promise.all([run("op_proc_left"), run("op_proc_right")]);
	const outcomes = [left.outcome, right.outcome].sort();
	assert.deepEqual(outcomes, ["rejected", "reserved"]);
	const reader = createLocalSqliteTestStore({ filePath });
	assert.equal((await balances(reader)).hat.reserved.value, "3");
	assert.equal((await balances(reader)).shirt.reserved.value, "2");
});
