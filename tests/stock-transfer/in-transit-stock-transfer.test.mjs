import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
	createExecuteStockTransferCommand,
	createReadReceiptHistory,
	createReadStockTransfer,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_dispatch",
	displayName: "Dispatch Operator",
	surface: "emdash",
});

const reversalPrincipal = Object.freeze({
	kind: "human",
	id: "emdash_user_reversal",
	displayName: "Reversal Operator",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(join(tmpdir(), `inventory-transfer-state-${label}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function seed(store, filePath, { quantity = "10", reserved = "0" } = {}) {
	for (const [locationId, name] of [
		["location_origin", "Origin"],
		["location_destination", "Destination"],
	]) {
		await createFixtureLocation(store, { locationId, name });
	}
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	const opening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-30T08:00:00.000Z"),
		createReceiptId: () => "rcpt_dispatch_opening",
	})({
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_dispatch_opening",
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_origin",
		},
		payload: { skuId: "sku_hat", quantity: { value: quantity, unit: "each" } },
		reason: { code: "opening_balance", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [{
			skuId: "sku_hat",
			locationId: "location_origin",
			version: "0",
		}],
	}, { principal });
	assert.equal(opening.outcome, "committed");
	if (reserved !== "0") {
		const database = new DatabaseSync(filePath);
		database.prepare(
			`UPDATE inventory_balances
			 SET reserved_value = ?, available_value = ?
			 WHERE pool_id = 'pool_test'
			   AND location_id = 'location_origin'
			   AND sku_id = 'sku_hat'`,
		).run(reserved, String(Number(quantity) - Number(reserved)));
		database.close();
	}
}

function executeAt(store, committedAt, receiptPrefix = "rcpt_transfer") {
	let receipts = 0;
	let transfers = 0;
	return createExecuteStockTransferCommand({
		store,
		now: () => new Date(committedAt),
		createTransferId: () => `transfer_dispatch_hat_${++transfers}`,
		createTransferReference: () => "ST-201",
		createReceiptId: () => `${receiptPrefix}_${++receipts}`,
	});
}

function createCommand(quantity = "5") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_transfer_create",
		type: "transfer.create",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: {
			reference: null,
			originLocationId: "location_origin",
			destinationLocationId: "location_destination",
			lines: [{ skuId: "sku_hat", quantity: { value: quantity, unit: "each" } }],
			note: "Store restock",
			expectedDispatchDate: "2026-09-01",
			expectedArrivalDate: "2026-09-03",
		},
		references: [],
		expectedVersions: [],
	};
}

function transitionCommand(type, transfer, commandId, reason = undefined) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type,
		context: { siteId: "site_test", poolId: transfer.poolId },
		payload: type === "transfer.reopen"
			? { transferId: transfer.transferId, reason }
			: { transferId: transfer.transferId },
		references: [],
		expectedVersions: [{ transferId: transfer.transferId, version: transfer.version }],
	};
}

async function balance(store, locationId) {
	return store.readBalance({
		poolId: "pool_test",
		locationId,
		skuId: "sku_hat",
	});
}

test("dispatches despite order-priority oversell and exactly reopens with immutable audit", async (t) => {
	const filePath = await databasePath(t, "lifecycle");
	let store = createLocalSqliteTestStore({ filePath });
	await seed(store, filePath, { reserved: "8" });

	const created = await executeAt(store, "2026-08-30T09:00:00.000Z")(
		createCommand(),
		{ principal },
	);
	assert.equal(created.outcome, "committed");
	const createdRead = await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: created.transfer.transferId,
	});
	assert.equal(createdRead.outcome, "found");
	assert.deepEqual(createdRead.lineStock, [{
		skuId: "sku_hat",
		originMovable: { value: "2", unit: "each" },
		quantityToMove: { value: "5", unit: "each" },
		destinationOnHand: { value: "0", unit: "each" },
		projectedOriginAvailable: { value: "-3", unit: "each" },
		reservedForOrders: { value: "8", unit: "each" },
		availability: "not_available",
	}]);

	const dispatchCommand = transitionCommand(
		"transfer.dispatch",
		created.transfer,
		"cmd_transfer_dispatch",
	);
	const dispatched = await executeAt(
		store,
		"2026-08-30T10:15:00.000Z",
		"rcpt_dispatch",
	)(dispatchCommand, { principal });
	assert.equal(dispatched.outcome, "committed");
	assert.equal(dispatched.transfer.status, "in_transit");
	assert.equal(dispatched.transfer.version, "2");
	assert.equal(dispatched.transfer.dispatchedDate, "2026-08-30T10:15:00.000Z");
	assert.equal(dispatched.receipt.committedAt, dispatched.transfer.dispatchedDate);
	assert.equal(dispatched.receipt.type, "transfer.dispatch");
	assert.equal("reason" in dispatched.receipt, false);
	assert.deepEqual(dispatched.receipt.principal, principal);
	assert.deepEqual(dispatched.warnings, [{
		code: "negative_available",
		skuId: "sku_hat",
		locationId: "location_origin",
		reservedForOrders: { value: "8", unit: "each" },
		outgoingTransferCommitted: { value: "5", unit: "each" },
		oversoldBy: { value: "3", unit: "each" },
		message: "This transfer will leave you with -3 stock. 8 are reserved for orders.",
	}]);
	assert.deepEqual(await balance(store, "location_origin"), {
		poolId: "pool_test",
		locationId: "location_origin",
		skuId: "sku_hat",
		onHand: { value: "5", unit: "each" },
		reserved: { value: "8", unit: "each" },
		outgoingTransferCommitted: { value: "0", unit: "each" },
		available: { value: "-3", unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "0", unit: "each" },
		version: "3",
		hasStockHistory: true,
	});
	assert.deepEqual(await balance(store, "location_destination"), {
		poolId: "pool_test",
		locationId: "location_destination",
		skuId: "sku_hat",
		onHand: { value: "0", unit: "each" },
		reserved: { value: "0", unit: "each" },
		outgoingTransferCommitted: { value: "0", unit: "each" },
		available: { value: "0", unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "5", unit: "each" },
		version: "2",
		hasStockHistory: false,
	});
	assert.equal(
		JSON.stringify(await executeAt(store, "2026-08-30T11:00:00.000Z")(dispatchCommand, { principal })),
		JSON.stringify(dispatched),
	);

	const reopenCommand = transitionCommand(
		"transfer.reopen",
		dispatched.transfer,
		"cmd_transfer_reopen",
		"  Carrier loaded the wrong pallet  ",
	);
	const reopened = await executeAt(
		store,
		"2026-08-30T10:30:00.000Z",
		"rcpt_reopen",
	)(reopenCommand, { principal: reversalPrincipal });
	assert.equal(reopened.outcome, "committed");
	assert.equal(reopened.transfer.status, "created");
	assert.equal(reopened.transfer.version, "3");
	assert.equal(reopened.transfer.dispatchedDate, null);
	assert.equal(reopened.receipt.type, "transfer.reopen");
	assert.equal(reopened.receipt.reason, "Carrier loaded the wrong pallet");
	assert.deepEqual(reopened.receipt.principal, reversalPrincipal);
	assert.equal((await balance(store, "location_origin")).onHand.value, "10");
	assert.equal((await balance(store, "location_origin")).outgoingTransferCommitted.value, "5");
	assert.equal((await balance(store, "location_destination")).expected.value, "5");
	assert.equal((await balance(store, "location_destination")).inTransit.value, "0");
	assert.equal((await balance(store, "location_destination")).onHand.value, "0");

	const originalReceipt = await store.readReceipt(dispatched.receipt.receiptId);
	assert.equal(originalReceipt.transfer.after.dispatchedDate, "2026-08-30T10:15:00.000Z");
	assert.deepEqual(originalReceipt.principal, principal);
	const history = await createReadReceiptHistory({ store })({
		poolId: "pool_test",
		scope: { kind: "location", locationId: "location_origin" },
	});
	assert.deepEqual(history.receipts.slice(0, 2).map((receipt) => receipt.type), [
		"transfer.reopen",
		"transfer.dispatch",
	]);

	await store.close();
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const reopenedRead = await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: reopened.transfer.transferId,
	});
	assert.equal(reopenedRead.outcome, "found");
	assert.equal(reopenedRead.transfer.status, "created");
	assert.equal(reopenedRead.transfer.dispatchedDate, null);
});

test("movable stock excludes this transfer while retaining other outgoing commitments", async (t) => {
	const filePath = await databasePath(t, "other-transfer");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store, filePath, { reserved: "3" });
	const execute = executeAt(store, "2026-08-30T09:00:00.000Z");
	const first = await execute({
		...createCommand("4"),
		commandId: "cmd_transfer_first",
		payload: { ...createCommand("4").payload, reference: "ST-FIRST" },
	}, { principal });
	const second = await execute({
		...createCommand("2"),
		commandId: "cmd_transfer_second",
		payload: { ...createCommand("2").payload, reference: "ST-SECOND" },
	}, { principal });
	assert.equal(first.outcome, "committed");
	assert.equal(second.outcome, "committed");
	const firstRead = await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: first.transfer.transferId,
	});
	const secondRead = await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: second.transfer.transferId,
	});
	assert.deepEqual(firstRead.lineStock[0], {
		skuId: "sku_hat",
		originMovable: { value: "5", unit: "each" },
		quantityToMove: { value: "4", unit: "each" },
		destinationOnHand: { value: "0", unit: "each" },
		projectedOriginAvailable: { value: "1", unit: "each" },
		reservedForOrders: { value: "3", unit: "each" },
		availability: "available",
	});
	assert.equal(secondRead.lineStock[0].originMovable.value, "3");
	assert.equal(secondRead.lineStock[0].projectedOriginAvailable.value, "1");
});

test("durably rejects zero, wrong-state, stale, and changed-content transitions", async (t) => {
	const filePath = await databasePath(t, "rejections");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store, filePath);
	const execute = executeAt(store, "2026-08-30T10:00:00.000Z");
	const zero = await execute(createCommand("0"), { principal });
	const zeroDispatch = transitionCommand(
		"transfer.dispatch",
		zero.transfer,
		"cmd_zero_dispatch",
	);
	assert.deepEqual(await execute(zeroDispatch, { principal }), {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_zero_dispatch",
		code: "positive_transfer_quantity_required",
		message: "Every transfer line must have a positive quantity before it can be marked In transit.",
	});
	assert.equal(JSON.stringify(await execute(zeroDispatch, { principal })), JSON.stringify(await execute(zeroDispatch, { principal })));

	const reopenCreated = transitionCommand(
		"transfer.reopen",
		zero.transfer,
		"cmd_reopen_created",
		null,
	);
	assert.match(JSON.stringify(await execute(reopenCreated, { principal })), /transfer_not_in_transit/u);

	const positive = await execute({
		...createCommand("2"),
		commandId: "cmd_positive_create",
		payload: { ...createCommand("2").payload, reference: "ST-202" },
	}, { principal });
	const stale = {
		...transitionCommand("transfer.dispatch", positive.transfer, "cmd_stale_dispatch"),
		expectedVersions: [{ transferId: positive.transfer.transferId, version: "99" }],
	};
	assert.match(JSON.stringify(await execute(stale, { principal })), /stale_version/u);

	const dispatched = await execute(
		transitionCommand("transfer.dispatch", positive.transfer, "cmd_positive_dispatch"),
		{ principal },
	);
	const wrongState = transitionCommand(
		"transfer.dispatch",
		dispatched.transfer,
		"cmd_repeat_state_dispatch",
	);
	assert.match(JSON.stringify(await execute(wrongState, { principal })), /transfer_not_created/u);
	const conflictCommand = transitionCommand(
		"transfer.reopen",
		dispatched.transfer,
		"cmd_reopen_conflict",
		null,
	);
	const reopened = await execute(conflictCommand, { principal });
	assert.equal(reopened.outcome, "committed");
	assert.match(
		JSON.stringify(await execute({
			...conflictCommand,
			payload: { ...conflictCommand.payload, reason: "Changed" },
		}, { principal })),
		/command_id_conflict/u,
	);
});

test("rolls back every dispatch effect when durable persistence fails", async (t) => {
	const filePath = await databasePath(t, "rollback");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store, filePath);
	const created = await executeAt(store, "2026-08-30T09:00:00.000Z")(
		createCommand("4"),
		{ principal },
	);
	const beforeOrigin = await balance(store, "location_origin");
	const beforeDestination = await balance(store, "location_destination");
	const failingStore = {
		...store,
		runTransaction: (poolId, operation) =>
			store.runTransaction(poolId, (transaction) =>
				operation(new Proxy(transaction, {
					get(target, property) {
						if (property === "commitStockTransfer") {
							return (input) => {
								target.commitStockTransfer(input);
								throw new Error("injected dispatch persistence failure");
							};
						}
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				})),
			),
	};
	await assert.rejects(
		executeAt(
			failingStore,
			"2026-08-30T10:00:00.000Z",
			"rcpt_rollback_dispatch",
		)(
			transitionCommand("transfer.dispatch", created.transfer, "cmd_rollback_dispatch"),
			{ principal },
		),
		/injected dispatch persistence failure/u,
	);
	assert.deepEqual(await balance(store, "location_origin"), beforeOrigin);
	assert.deepEqual(await balance(store, "location_destination"), beforeDestination);
	assert.deepEqual((await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: created.transfer.transferId,
	})).transfer, created.transfer);
	assert.equal(await store.readCommand("cmd_rollback_dispatch"), null);
});
