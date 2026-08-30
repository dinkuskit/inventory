import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
	createAdjustStock,
	createExecuteStockTransferCommand,
	createReadReceiptHistory,
	createReadStockTransfer,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import {
	archiveFixtureLocation,
	createFixtureLocation,
} from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const dispatchPrincipal = Object.freeze({
	kind: "human",
	id: "emdash_user_dispatch",
	displayName: "Dispatch Operator",
	surface: "emdash",
});

const receivePrincipal = Object.freeze({
	kind: "human",
	id: "emdash_user_receive",
	displayName: "Receiving Operator",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(join(tmpdir(), `inventory-transfer-receive-${label}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function setOpening(store, { skuId, locationId, quantity, suffix }) {
	const result = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-30T08:00:00.000Z"),
		createReceiptId: () => `rcpt_receive_opening_${suffix}`,
	})({
		schema: "dinkuskit.inventory.command/v1",
		commandId: `cmd_receive_opening_${suffix}`,
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId,
		},
		payload: { skuId, quantity: { value: quantity, unit: "each" } },
		reason: { code: "opening_balance", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [{ skuId, locationId, version: "0" }],
	}, { principal: dispatchPrincipal });
	assert.equal(result.outcome, "committed");
}

async function seed(store, filePath) {
	for (const [locationId, name] of [
		["location_origin", "Origin"],
		["location_destination", "Destination"],
	]) {
		await createFixtureLocation(store, { locationId, name });
	}
	for (const [skuId, sku, displayName] of [
		["sku_hat", "HAT-BLACK", "Black Hat"],
		["sku_shirt", "SHIRT-GREEN", "Green Shirt"],
	]) {
		await createFixtureManagedSku(store, { skuId, sku, displayName });
	}
	await setOpening(store, {
		skuId: "sku_hat",
		locationId: "location_origin",
		quantity: "10",
		suffix: "origin_hat",
	});
	await setOpening(store, {
		skuId: "sku_shirt",
		locationId: "location_origin",
		quantity: "7",
		suffix: "origin_shirt",
	});
	await setOpening(store, {
		skuId: "sku_shirt",
		locationId: "location_destination",
		quantity: "2",
		suffix: "destination_shirt",
	});
	const database = new DatabaseSync(filePath);
	database.prepare(
		`UPDATE inventory_balances
		 SET reserved_value = '1', available_value = '1'
		 WHERE pool_id = 'pool_test'
		   AND location_id = 'location_destination'
		   AND sku_id = 'sku_shirt'`,
	).run();
	database.close();
}

function executeAt(
	store,
	committedAt,
	receiptId,
	transferId = "transfer_received_multi",
) {
	return createExecuteStockTransferCommand({
		store,
		now: () => new Date(committedAt),
		createTransferId: () => transferId,
		createTransferReference: () => "ST-301",
		createReceiptId: () => receiptId,
	});
}

function createCommand(commandId = "cmd_receive_create") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "transfer.create",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: {
			reference: null,
			originLocationId: "location_origin",
			destinationLocationId: "location_destination",
			lines: [
				{ skuId: "sku_shirt", quantity: { value: "3", unit: "each" } },
				{ skuId: "sku_hat", quantity: { value: "4", unit: "each" } },
			],
			note: "Whole shipment",
			expectedDispatchDate: "2026-09-01",
			expectedArrivalDate: "2026-09-03",
		},
		references: [],
		expectedVersions: [],
	};
}

function transitionCommand(type, transfer, commandId) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type,
		context: { siteId: "site_test", poolId: transfer.poolId },
		payload: { transferId: transfer.transferId },
		references: [],
		expectedVersions: [{ transferId: transfer.transferId, version: transfer.version }],
	};
}

function readBalance(store, locationId, skuId) {
	return store.readBalance({ poolId: "pool_test", locationId, skuId });
}

async function createAndDispatch(store) {
	const created = await executeAt(
		store,
		"2026-08-30T09:00:00.000Z",
		"rcpt_receive_create",
	)(createCommand(), { principal: dispatchPrincipal });
	assert.equal(created.outcome, "committed");
	const dispatched = await executeAt(
		store,
		"2026-08-30T10:15:00.000Z",
		"rcpt_receive_dispatch",
	)(
		transitionCommand(
			"transfer.dispatch",
			created.transfer,
			"cmd_receive_dispatch",
		),
		{ principal: dispatchPrincipal },
	);
	assert.equal(dispatched.outcome, "committed");
	return { created, dispatched };
}

test("receives every line atomically with automatic actor/time and durable destination history", async (t) => {
	const filePath = await databasePath(t, "lifecycle");
	let store = createLocalSqliteTestStore({ filePath });
	await seed(store, filePath);
	const { dispatched } = await createAndDispatch(store);
	const originBefore = await Promise.all([
		readBalance(store, "location_origin", "sku_hat"),
		readBalance(store, "location_origin", "sku_shirt"),
	]);
	assert.deepEqual(await readBalance(store, "location_destination", "sku_hat"), {
		poolId: "pool_test",
		locationId: "location_destination",
		skuId: "sku_hat",
		onHand: { value: "0", unit: "each" },
		reserved: { value: "0", unit: "each" },
		outgoingTransferCommitted: { value: "0", unit: "each" },
		available: { value: "0", unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "4", unit: "each" },
		version: "2",
		hasStockHistory: false,
	});

	const command = transitionCommand(
		"transfer.receive",
		dispatched.transfer,
		"cmd_transfer_receive",
	);
	const received = await executeAt(
		store,
		"2026-08-30T12:34:56.000Z",
		"rcpt_transfer_receive",
	)(command, { principal: receivePrincipal });

	assert.equal(received.outcome, "committed");
	assert.equal(received.transfer.status, "received");
	assert.equal(received.transfer.version, "3");
	assert.equal(received.transfer.createdAt, "2026-08-30T09:00:00.000Z");
	assert.equal(received.transfer.expectedDispatchDate, "2026-09-01");
	assert.equal(received.transfer.expectedArrivalDate, "2026-09-03");
	assert.equal(received.transfer.dispatchedDate, "2026-08-30T10:15:00.000Z");
	assert.equal(received.transfer.receivedDate, "2026-08-30T12:34:56.000Z");
	assert.equal(received.transfer.updatedAt, received.transfer.receivedDate);
	assert.equal(received.receipt.type, "transfer.receive");
	assert.equal(received.receipt.committedAt, received.transfer.receivedDate);
	assert.deepEqual(received.receipt.principal, receivePrincipal);
	assert.equal("reason" in received.receipt, false);
	assert.deepEqual(received.warnings, []);
	assert.deepEqual(
		received.receipt.effects.map((effect) => ({
			skuId: effect.skuId,
			locationId: effect.locationId,
			onHandDelta: effect.onHandDelta,
			reservedDelta: effect.reservedDelta,
			outgoingTransferCommittedDelta: effect.outgoingTransferCommittedDelta,
			expectedDelta: effect.expectedDelta,
			inTransitDelta: effect.inTransitDelta,
		})),
		[
			{
				skuId: "sku_hat",
				locationId: "location_destination",
				onHandDelta: { value: "4", unit: "each" },
				reservedDelta: { value: "0", unit: "each" },
				outgoingTransferCommittedDelta: { value: "0", unit: "each" },
				expectedDelta: { value: "0", unit: "each" },
				inTransitDelta: { value: "-4", unit: "each" },
			},
			{
				skuId: "sku_shirt",
				locationId: "location_destination",
				onHandDelta: { value: "3", unit: "each" },
				reservedDelta: { value: "0", unit: "each" },
				outgoingTransferCommittedDelta: { value: "0", unit: "each" },
				expectedDelta: { value: "0", unit: "each" },
				inTransitDelta: { value: "-3", unit: "each" },
			},
		],
	);
	assert.deepEqual(await Promise.all([
		readBalance(store, "location_origin", "sku_hat"),
		readBalance(store, "location_origin", "sku_shirt"),
	]), originBefore);
	assert.deepEqual(await readBalance(store, "location_destination", "sku_hat"), {
		poolId: "pool_test",
		locationId: "location_destination",
		skuId: "sku_hat",
		onHand: { value: "4", unit: "each" },
		reserved: { value: "0", unit: "each" },
		outgoingTransferCommitted: { value: "0", unit: "each" },
		available: { value: "4", unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "0", unit: "each" },
		version: "3",
		hasStockHistory: true,
	});
	assert.deepEqual(await readBalance(store, "location_destination", "sku_shirt"), {
		poolId: "pool_test",
		locationId: "location_destination",
		skuId: "sku_shirt",
		onHand: { value: "5", unit: "each" },
		reserved: { value: "1", unit: "each" },
		outgoingTransferCommitted: { value: "0", unit: "each" },
		available: { value: "4", unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "0", unit: "each" },
		version: "4",
		hasStockHistory: true,
	});
	assert.equal(
		JSON.stringify(await executeAt(
			store,
			"2026-08-31T00:00:00.000Z",
			"rcpt_should_not_replace_receive",
		)(command, { principal: dispatchPrincipal })),
		JSON.stringify(received),
	);
	const history = await createReadReceiptHistory({ store })({
		poolId: "pool_test",
		scope: { kind: "location", locationId: "location_destination" },
	});
	assert.deepEqual(history.receipts.slice(0, 3).map((receipt) => receipt.type), [
		"transfer.receive",
		"transfer.dispatch",
		"transfer.create",
	]);
	const originHistory = await createReadReceiptHistory({ store })({
		poolId: "pool_test",
		scope: { kind: "location", locationId: "location_origin" },
	});
	assert.equal(
		originHistory.receipts.some((receipt) => receipt.type === "transfer.receive"),
		false,
	);

	await store.close();
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const read = await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: received.transfer.transferId,
	});
	assert.equal(read.outcome, "found");
	assert.deepEqual(read.transfer, received.transfer);
	const destinationHat = await readBalance(
		store,
		"location_destination",
		"sku_hat",
	);
	const lateOpening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-30T12:40:00.000Z"),
		createReceiptId: () => "rcpt_should_not_replace_received_stock",
	})({
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_late_destination_opening",
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_destination",
		},
		payload: { skuId: "sku_hat", quantity: { value: "99", unit: "each" } },
		reason: { code: "opening_balance", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [{
			skuId: "sku_hat",
			locationId: "location_destination",
			version: destinationHat.version,
		}],
	}, { principal: receivePrincipal });
	assert.equal(lateOpening.outcome, "rejected");
	assert.equal(lateOpening.code, "opening_balance_already_set");
	const adjusted = await createAdjustStock({
		store,
		now: () => new Date("2026-08-30T12:45:00.000Z"),
		createReceiptId: () => "rcpt_receive_damage_adjustment",
	})({
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_receive_damage_adjustment",
		type: "stock.adjust",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_destination",
		},
		payload: { skuId: "sku_hat", delta: { value: "-1", unit: "each" } },
		reason: { note: "One hat damaged during transfer" },
		references: [{ kind: "corrects_receipt", id: received.receipt.receiptId }],
		expectedVersions: [{
			skuId: "sku_hat",
			locationId: "location_destination",
			version: destinationHat.version,
		}],
	}, { principal: receivePrincipal });
	assert.equal(adjusted.outcome, "committed");
	assert.equal(adjusted.receipt.reason.note, "One hat damaged during transfer");
	assert.equal(
		(await readBalance(store, "location_destination", "sku_hat")).onHand.value,
		"3",
	);
	assert.deepEqual(
		await store.readReceipt(received.receipt.receiptId),
		received.receipt,
	);
});

test("durably rejects missing, wrong-state, stale, repeated, and changed-content receipt", async (t) => {
	const filePath = await databasePath(t, "rejections");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store, filePath);
	const created = await executeAt(
		store,
		"2026-08-30T09:00:00.000Z",
		"rcpt_reject_create",
	)(createCommand(), { principal: dispatchPrincipal });
	const receiveCreated = transitionCommand(
		"transfer.receive",
		created.transfer,
		"cmd_receive_created",
	);
	const wrongState = await executeAt(
		store,
		"2026-08-30T09:05:00.000Z",
		"rcpt_should_not_exist_wrong_state",
	)(receiveCreated, { principal: receivePrincipal });
	assert.deepEqual(wrongState, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_receive_created",
		code: "transfer_not_in_transit",
		message: "Only an In-transit transfer can be received.",
	});
	assert.equal(
		JSON.stringify(await executeAt(
			store,
			"2026-08-31T09:05:00.000Z",
			"rcpt_still_should_not_exist",
		)(receiveCreated, { principal: dispatchPrincipal })),
		JSON.stringify(wrongState),
	);
	const missing = await executeAt(
		store,
		"2026-08-30T09:10:00.000Z",
		"rcpt_should_not_exist_missing",
	)({
		...receiveCreated,
		commandId: "cmd_receive_missing",
		payload: { transferId: "transfer_missing" },
		expectedVersions: [{ transferId: "transfer_missing", version: "1" }],
	}, { principal: receivePrincipal });
	assert.equal(missing.outcome, "rejected");
	assert.equal(missing.code, "transfer_not_found");
	const createCanceled = createCommand("cmd_receive_canceled_create");
	const createdToCancel = await executeAt(
		store,
		"2026-08-30T09:20:00.000Z",
		"rcpt_receive_canceled_create",
		"transfer_receive_canceled",
	)({
		...createCanceled,
		payload: { ...createCanceled.payload, reference: "ST-CANCELED" },
	}, { principal: dispatchPrincipal });
	const canceled = await executeAt(
		store,
		"2026-08-30T09:21:00.000Z",
		"rcpt_receive_canceled",
	)(
		transitionCommand(
			"transfer.cancel",
			createdToCancel.transfer,
			"cmd_receive_canceled",
		),
		{ principal: dispatchPrincipal },
	);
	const receiveCanceled = await executeAt(
		store,
		"2026-08-30T09:22:00.000Z",
		"rcpt_should_not_exist_canceled",
	)(
		transitionCommand(
			"transfer.receive",
			canceled.transfer,
			"cmd_receive_canceled_state",
		),
		{ principal: receivePrincipal },
	);
	assert.equal(receiveCanceled.outcome, "rejected");
	assert.equal(receiveCanceled.code, "transfer_not_in_transit");

	const dispatched = await executeAt(
		store,
		"2026-08-30T10:15:00.000Z",
		"rcpt_reject_dispatch",
	)(
		transitionCommand(
			"transfer.dispatch",
			created.transfer,
			"cmd_reject_dispatch",
		),
		{ principal: dispatchPrincipal },
	);
	const stale = await executeAt(
		store,
		"2026-08-30T12:00:00.000Z",
		"rcpt_should_not_exist_stale",
	)({
		...transitionCommand(
			"transfer.receive",
			dispatched.transfer,
			"cmd_receive_stale",
		),
		expectedVersions: [{
			transferId: dispatched.transfer.transferId,
			version: "99",
		}],
	}, { principal: receivePrincipal });
	assert.equal(stale.outcome, "rejected");
	assert.equal(stale.code, "stale_version");

	const command = transitionCommand(
		"transfer.receive",
		dispatched.transfer,
		"cmd_receive_committed",
	);
	const received = await executeAt(
		store,
		"2026-08-30T12:30:00.000Z",
		"rcpt_receive_committed",
	)(command, { principal: receivePrincipal });
	assert.equal(received.outcome, "committed");
	const repeated = await executeAt(
		store,
		"2026-08-30T12:31:00.000Z",
		"rcpt_should_not_exist_repeated",
	)(
		transitionCommand(
			"transfer.receive",
			received.transfer,
			"cmd_receive_repeated",
		),
		{ principal: receivePrincipal },
	);
	assert.equal(repeated.outcome, "rejected");
	assert.equal(repeated.code, "transfer_not_in_transit");
	const conflict = await executeAt(
		store,
		"2026-08-30T12:32:00.000Z",
		"rcpt_should_not_replace_committed",
	)({
		...command,
		references: [{ kind: "changed", id: "after-commit" }],
	}, { principal: receivePrincipal });
	assert.equal(conflict.outcome, "rejected");
	assert.equal(conflict.code, "command_id_conflict");
	assert.deepEqual((await store.readCommand(command.commandId)).result, received);
});

test("rolls back the transfer, every line, receipt, and terminal result on receive failure", async (t) => {
	const filePath = await databasePath(t, "rollback");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store, filePath);
	const { dispatched } = await createAndDispatch(store);
	const balancesBefore = await Promise.all([
		readBalance(store, "location_origin", "sku_hat"),
		readBalance(store, "location_origin", "sku_shirt"),
		readBalance(store, "location_destination", "sku_hat"),
		readBalance(store, "location_destination", "sku_shirt"),
	]);
	const failingStore = {
		...store,
		runTransaction: (poolId, operation) =>
			store.runTransaction(poolId, (transaction) =>
				operation(new Proxy(transaction, {
					get(target, property) {
						if (property === "commitStockTransfer") {
							return (input) => {
								target.commitStockTransfer(input);
								throw new Error("injected receive persistence failure");
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
			"2026-08-30T12:34:56.000Z",
			"rcpt_receive_rollback",
		)(
			transitionCommand(
				"transfer.receive",
				dispatched.transfer,
				"cmd_receive_rollback",
			),
			{ principal: receivePrincipal },
		),
		/injected receive persistence failure/u,
	);
	assert.deepEqual(await Promise.all([
		readBalance(store, "location_origin", "sku_hat"),
		readBalance(store, "location_origin", "sku_shirt"),
		readBalance(store, "location_destination", "sku_hat"),
		readBalance(store, "location_destination", "sku_shirt"),
	]), balancesBefore);
	assert.deepEqual((await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: dispatched.transfer.transferId,
	})).transfer, dispatched.transfer);
	assert.equal(await store.readCommand("cmd_receive_rollback"), null);
	assert.equal(await store.readReceipt("rcpt_receive_rollback"), null);
});

test("receives a frozen shipment after its now-empty origin is archived", async (t) => {
	const filePath = await databasePath(t, "archived-origin");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store, {
		locationId: "location_origin",
		name: "Origin",
	});
	await createFixtureLocation(store, {
		locationId: "location_destination",
		name: "Destination",
	});
	await createFixtureManagedSku(store, {
		skuId: "sku_hat",
		sku: "HAT-BLACK",
		displayName: "Black Hat",
	});
	await setOpening(store, {
		skuId: "sku_hat",
		locationId: "location_origin",
		quantity: "10",
		suffix: "archivable_origin_hat",
	});
	const create = createCommand("cmd_archivable_transfer_create");
	const created = await executeAt(
		store,
		"2026-08-30T09:00:00.000Z",
		"rcpt_archivable_transfer_create",
	)({
		...create,
		payload: {
			...create.payload,
			reference: "ST-ARCHIVE",
			lines: [{ skuId: "sku_hat", quantity: { value: "10", unit: "each" } }],
		},
	}, { principal: dispatchPrincipal });
	const dispatched = await executeAt(
		store,
		"2026-08-30T10:15:00.000Z",
		"rcpt_archivable_transfer_dispatch",
	)(
		transitionCommand(
			"transfer.dispatch",
			created.transfer,
			"cmd_archivable_transfer_dispatch",
		),
		{ principal: dispatchPrincipal },
	);
	assert.equal(dispatched.outcome, "committed");
	assert.equal(
		(await readBalance(store, "location_origin", "sku_hat")).onHand.value,
		"0",
	);
	await archiveFixtureLocation(store, { locationId: "location_origin" });
	const received = await executeAt(
		store,
		"2026-08-30T12:34:56.000Z",
		"rcpt_archivable_transfer_receive",
	)(
		transitionCommand(
			"transfer.receive",
			dispatched.transfer,
			"cmd_archivable_transfer_receive",
		),
		{ principal: receivePrincipal },
	);
	assert.equal(received.outcome, "committed");
	assert.equal(received.transfer.status, "received");
	assert.equal(
		(await readBalance(store, "location_destination", "sku_hat")).onHand.value,
		"10",
	);
});
