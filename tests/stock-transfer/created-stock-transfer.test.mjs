import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
	createAdjustStock,
	createConfirmOpeningBalance,
	createExecuteStockTransferCommand,
	createPreviewOpeningBalance,
	createReadInventoryMutation,
	createReadReceiptHistory,
	createReadStockTransfer,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import {
	archiveFixtureLocation,
	createFixtureLocation,
	restoreFixtureLocation,
} from "../helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../helpers/managed-sku-fixture.mjs";

const principal = Object.freeze({
	kind: "human",
	id: "emdash_user_transfer",
	displayName: "Transfer Operator",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(join(tmpdir(), `inventory-transfer-${label}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

async function seed(store, { poolId = "pool_test", withOpening = true } = {}) {
	await createFixtureLocation(store, {
		poolId,
		locationId: "location_origin",
		name: "Origin",
	});
	await createFixtureLocation(store, {
		poolId,
		locationId: "location_destination",
		name: "Destination",
	});
	await createFixtureManagedSku(store, { poolId, skuId: "sku_hat" });
	if (!withOpening) return;
	await setOpening(store, { poolId, skuId: "sku_hat", quantity: "10" });
}

async function setOpening(
	store,
	{
		poolId = "pool_test",
		locationId = "location_origin",
		skuId,
		quantity,
		expectedVersion = "0",
	},
) {
	const result = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-29T09:00:00.000Z"),
		createReceiptId: () => `rcpt_opening_${poolId}_${locationId}_${skuId}`,
	})(
		openingCommand({
			commandId: `cmd_opening_${poolId}_${locationId}_${skuId}`,
			poolId,
			locationId,
			skuId,
			quantity,
			expectedVersion,
		}),
		{ principal },
	);
	assert.equal(result.outcome, "committed");
	return result;
}

function openingCommand({
	commandId,
	poolId = "pool_test",
	locationId,
	skuId,
	quantity,
	expectedVersion,
}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: { siteId: "site_test", poolId, locationId },
		payload: { skuId, quantity: { value: quantity, unit: "each" } },
		reason: { code: "opening_balance", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [{ skuId, locationId, version: expectedVersion }],
	};
}

function createdFields(overrides = {}) {
	return {
		reference: null,
		originLocationId: "location_origin",
		destinationLocationId: "location_destination",
		lines: [{ skuId: "sku_hat", quantity: { value: "0", unit: "each" } }],
		note: null,
		expectedDispatchDate: "2026-09-01",
		expectedArrivalDate: "2026-09-03",
		...overrides,
	};
}

function createCommand(commandId = "cmd_transfer_create", overrides = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "transfer.create",
		context: { siteId: "site_test", poolId: "pool_test" },
		payload: createdFields(overrides),
		references: [],
		expectedVersions: [],
	};
}

function updateCommand(transfer, overrides = {}, commandId = "cmd_transfer_update") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "transfer.update",
		context: { siteId: "site_test", poolId: transfer.poolId },
		payload: {
			transferId: transfer.transferId,
			...createdFields({
				reference: transfer.reference,
				originLocationId: transfer.originLocationId,
				destinationLocationId: transfer.destinationLocationId,
				lines: transfer.lines,
				note: transfer.note,
				expectedDispatchDate: transfer.expectedDispatchDate,
				expectedArrivalDate: transfer.expectedArrivalDate,
				...overrides,
			}),
		},
		references: [],
		expectedVersions: [{ transferId: transfer.transferId, version: transfer.version }],
	};
}

function cancelCommand(transfer, commandId = "cmd_transfer_cancel") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "transfer.cancel",
		context: { siteId: "site_test", poolId: transfer.poolId },
		payload: { transferId: transfer.transferId },
		references: [],
		expectedVersions: [{ transferId: transfer.transferId, version: transfer.version }],
	};
}

function dispatchCommand(transfer, commandId = "cmd_transfer_dispatch") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "transfer.dispatch",
		context: { siteId: "site_test", poolId: transfer.poolId },
		payload: { transferId: transfer.transferId },
		references: [],
		expectedVersions: [{ transferId: transfer.transferId, version: transfer.version }],
	};
}

function reopenCommand(transfer, commandId = "cmd_transfer_reopen") {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "transfer.reopen",
		context: { siteId: "site_test", poolId: transfer.poolId },
		payload: { transferId: transfer.transferId, reason: null },
		references: [],
		expectedVersions: [{ transferId: transfer.transferId, version: transfer.version }],
	};
}

function boundary(store, overrides = {}) {
	let transferIds = 0;
	let references = 0;
	let receipts = 0;
	return createExecuteStockTransferCommand({
		store,
		now: () => new Date("2026-08-29T12:00:00.000Z"),
		createTransferId: () => {
			transferIds += 1;
			return overrides.transferId ?? "transfer_opaque_1";
		},
		createTransferReference: () => {
			references += 1;
			return overrides.reference ?? "ST-147";
		},
		createReceiptId: () => {
			receipts += 1;
			return `${overrides.receiptPrefix ?? "rcpt_transfer"}_${receipts}`;
		},
	});
}

function stock(value, expected = "0", outgoing = "0") {
	return {
		onHand: { value, unit: "each" },
		reserved: { value: "0", unit: "each" },
		outgoingTransferCommitted: { value: outgoing, unit: "each" },
		available: { value: String(Number(value) - Number(outgoing)), unit: "each" },
		expected: { value: expected, unit: "each" },
		inTransit: { value: "0", unit: "each" },
	};
}

test("persists a zero Created draft, edits planning stock, replays, and cancels atomically", async (t) => {
	const filePath = await databasePath(t, "lifecycle");
	let store = createLocalSqliteTestStore({ filePath });
	await seed(store);
	const execute = boundary(store);

	const created = await execute(createCommand(), { principal });
	assert.equal(created.outcome, "committed");
	assert.deepEqual(created.transfer, {
		schema: "dinkuskit.inventory.stock-transfer/v1",
		poolId: "pool_test",
		transferId: "transfer_opaque_1",
		reference: "ST-147",
		status: "created",
		originLocationId: "location_origin",
		destinationLocationId: "location_destination",
		lines: [{ skuId: "sku_hat", quantity: { value: "0", unit: "each" } }],
		note: null,
		createdAt: "2026-08-29T12:00:00.000Z",
		createdBy: principal,
		updatedAt: "2026-08-29T12:00:00.000Z",
		version: "1",
		expectedDispatchDate: "2026-09-01",
		expectedArrivalDate: "2026-09-03",
		dispatchedDate: null,
		receivedDate: null,
		canceledAt: null,
	});
	assert.deepEqual(created.warnings, []);
	assert.deepEqual(
		(await store.readBalance({
			poolId: "pool_test",
			locationId: "location_origin",
			skuId: "sku_hat",
		})),
		{
			poolId: "pool_test",
			locationId: "location_origin",
			skuId: "sku_hat",
			...stock("10"),
			version: "1",
			hasStockHistory: true,
		},
	);

	const update = updateCommand(created.transfer, {
		reference: "Weekend ST-147",
		lines: [{ skuId: "sku_hat", quantity: { value: "5", unit: "each" } }],
		note: "Restock front store",
	});
	const updated = await execute(update, { principal });
	assert.equal(updated.outcome, "committed");
	assert.equal(updated.transfer.version, "2");
	assert.equal(updated.transfer.reference, "Weekend ST-147");
	assert.deepEqual(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_origin",
			skuId: "sku_hat",
		}),
		{
			poolId: "pool_test",
			locationId: "location_origin",
			skuId: "sku_hat",
			...stock("10", "0", "5"),
			version: "2",
			hasStockHistory: true,
		},
	);
	assert.deepEqual(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_destination",
			skuId: "sku_hat",
		}),
		{
			poolId: "pool_test",
			locationId: "location_destination",
			skuId: "sku_hat",
			...stock("0", "5"),
			version: "1",
			hasStockHistory: false,
		},
	);

	const replay = await execute(update, { principal });
	assert.equal(JSON.stringify(replay), JSON.stringify(updated));
	assert.deepEqual(await execute({ ...update, payload: { ...update.payload, note: "changed" } }, { principal }), {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_transfer_update",
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	});
	const stale = {
		...updateCommand(updated.transfer, { note: "stale change" }, "cmd_transfer_stale"),
		expectedVersions: [{ transferId: updated.transfer.transferId, version: "1" }],
	};
	const staleResult = await execute(stale, { principal });
	assert.deepEqual(staleResult, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_transfer_stale",
		code: "stale_version",
		message: "The transfer changed after it was read. Refresh and try again.",
	});
	assert.deepEqual(await execute(stale, { principal }), staleResult);

	await store.close();
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const read = await createReadStockTransfer({ store })({
		poolId: "pool_test",
		transferId: updated.transfer.transferId,
	});
	assert.deepEqual(read, {
		schema: "dinkuskit.inventory.stock-transfer-read-result/v1",
		outcome: "found",
		transfer: updated.transfer,
		lineStock: [{
			skuId: "sku_hat",
			originMovable: { value: "10", unit: "each" },
			quantityToMove: { value: "5", unit: "each" },
			destinationOnHand: { value: "0", unit: "each" },
			projectedOriginAvailable: { value: "5", unit: "each" },
			reservedForOrders: { value: "0", unit: "each" },
			availability: "available",
		}],
	});

	const cancel = await boundary(store, { receiptPrefix: "rcpt_cancel" })(
		cancelCommand(updated.transfer),
		{ principal },
	);
	assert.equal(cancel.outcome, "committed");
	assert.equal(cancel.transfer.status, "canceled");
	assert.equal(cancel.transfer.version, "3");
	assert.deepEqual(
		(await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId: "sku_hat" })).outgoingTransferCommitted,
		{ value: "0", unit: "each" },
	);
	assert.deepEqual(
		(await store.readBalance({ poolId: "pool_test", locationId: "location_destination", skuId: "sku_hat" })).expected,
		{ value: "0", unit: "each" },
	);

	const duplicate = await boundary(store, {
		transferId: "transfer_opaque_2",
		receiptPrefix: "rcpt_duplicate",
	})(createCommand("cmd_duplicate_reference", {
		reference: "Weekend ST-147",
	}), { principal });
	assert.deepEqual(duplicate, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_duplicate_reference",
		code: "transfer_reference_conflict",
		message: "Another transfer already uses this reference.",
	});
});

test("allows negative availability with an exact transfer warning and canonical history", async (t) => {
	const filePath = await databasePath(t, "warning");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store);
	const database = new DatabaseSync(filePath);
	database.prepare(
		`UPDATE inventory_balances
		 SET reserved_value = '8', available_value = '2'
		 WHERE pool_id = 'pool_test' AND location_id = 'location_origin' AND sku_id = 'sku_hat'`,
	).run();
	database.close();

	const result = await boundary(store)(createCommand("cmd_transfer_warning", {
		reference: "ST-WARNING",
		lines: [{ skuId: "sku_hat", quantity: { value: "5", unit: "each" } }],
	}), { principal });
	assert.equal(result.outcome, "committed");
	assert.deepEqual(result.warnings, [{
		code: "negative_available",
		skuId: "sku_hat",
		locationId: "location_origin",
		reservedForOrders: { value: "8", unit: "each" },
		outgoingTransferCommitted: { value: "5", unit: "each" },
		oversoldBy: { value: "3", unit: "each" },
		message: "This transfer will leave you with -3 stock. 8 are reserved for orders.",
	}]);
	const noteOnlyEdit = await boundary(store, { receiptPrefix: "rcpt_warning_edit" })(
		updateCommand(result.transfer, { note: "Carrier confirmed" }, "cmd_transfer_warning_edit"),
		{ principal },
	);
	assert.equal(noteOnlyEdit.outcome, "committed");
	assert.deepEqual(noteOnlyEdit.warnings, result.warnings);
	assert.deepEqual(result.receipt.principal, principal);
	assert.equal(result.receipt.effects.length, 2);
	assert.equal(
		(await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId: "sku_hat" })).available.value,
		"-3",
	);
	const mutation = await createReadInventoryMutation({ store })({
		receiptId: result.receipt.receiptId,
	});
	assert.equal(mutation.outcome, "found");
	assert.equal(mutation.result.receipt.type, "transfer.create");
	const history = await createReadReceiptHistory({ store })({
		poolId: "pool_test",
		scope: { kind: "location", locationId: "location_destination" },
	});
	assert.deepEqual(history.receipts.map((receipt) => receipt.type), [
		"transfer.create",
	]);
});

test("atomically replaces a multi-SKU destination and preserves commitments through an adjustment", async (t) => {
	const filePath = await databasePath(t, "multi-location");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await seed(store);
	await createFixtureLocation(store, {
		locationId: "location_destination_two",
		name: "Destination Two",
	});
	await createFixtureManagedSku(store, { skuId: "sku_beanie" });
	await setOpening(store, { skuId: "sku_beanie", quantity: "7" });

	const execute = boundary(store, { transferId: "transfer_multi" });
	const created = await execute(createCommand("cmd_transfer_multi", {
		reference: "ST-MULTI",
		lines: [
			{ skuId: "sku_hat", quantity: { value: "2", unit: "each" } },
			{ skuId: "sku_beanie", quantity: { value: "3", unit: "each" } },
		],
	}), { principal });
	assert.equal(created.outcome, "committed");

	const updated = await execute(updateCommand(created.transfer, {
		destinationLocationId: "location_destination_two",
		lines: [
			{ skuId: "sku_hat", quantity: { value: "4", unit: "each" } },
			{ skuId: "sku_beanie", quantity: { value: "1", unit: "each" } },
		],
	}, "cmd_transfer_multi_update"), { principal });
	assert.equal(updated.outcome, "committed");
	for (const [skuId, outgoing, expected] of [
		["sku_hat", "4", "4"],
		["sku_beanie", "1", "1"],
	]) {
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId })).outgoingTransferCommitted.value, outgoing);
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination", skuId })).expected.value, "0");
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination_two", skuId })).expected.value, expected);
	}
	const staleOpening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-29T12:29:00.000Z"),
		createReceiptId: () => "rcpt_stale_destination_opening",
	})(openingCommand({
		commandId: "cmd_stale_destination_opening",
		locationId: "location_destination_two",
		skuId: "sku_hat",
		quantity: "3",
		expectedVersion: "0",
	}), { principal });
	assert.deepEqual(staleOpening, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_stale_destination_opening",
		code: "stale_version",
		message: "Stock changed after preview. Preview the opening balance again.",
	});
	assert.equal(await store.readReceipt("rcpt_stale_destination_opening"), null);
	const openingPreview = await createPreviewOpeningBalance({
		store,
		now: () => new Date("2026-08-29T12:30:00.000Z"),
		createConfirmation: () => "confirm_destination_opening",
	})({
		schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_destination_two",
		},
		payload: { skuId: "sku_hat", quantity: { value: "3", unit: "each" } },
		reason: { code: "opening_balance", note: "Set Initial Stock" },
		references: [],
	}, { principal });
	assert.equal(openingPreview.effect.balanceBefore.version, "1");
	assert.deepEqual(openingPreview.effect.balanceBefore.expected, {
		value: "4",
		unit: "each",
	});
	const destinationOpening = await createConfirmOpeningBalance({
		store,
		now: () => new Date("2026-08-29T12:31:00.000Z"),
		createReceiptId: () => "rcpt_destination_opening",
	})(openingPreview.confirmation.value, {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_destination_opening",
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_destination_two",
		},
		payload: { skuId: "sku_hat", quantity: { value: "3", unit: "each" } },
		reason: { code: "opening_balance", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [{
			skuId: "sku_hat",
			locationId: "location_destination_two",
			version: openingPreview.effect.balanceBefore.version,
		}],
	}, { principal });
	assert.equal(destinationOpening.outcome, "committed");
	assert.deepEqual(await store.readBalance({
		poolId: "pool_test",
		locationId: "location_destination_two",
		skuId: "sku_hat",
	}), {
		poolId: "pool_test",
		locationId: "location_destination_two",
		skuId: "sku_hat",
		...stock("3", "4"),
		version: "2",
		hasStockHistory: true,
	});

	const originBeforeAdjustment = await store.readBalance({
		poolId: "pool_test",
		locationId: "location_origin",
		skuId: "sku_hat",
	});
	const adjusted = await createAdjustStock({
		store,
		now: () => new Date("2026-08-29T13:00:00.000Z"),
		createReceiptId: () => "rcpt_adjust_during_transfer",
	})({
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_adjust_during_transfer",
		type: "stock.adjust",
		context: { siteId: "site_test", poolId: "pool_test", locationId: "location_origin" },
		payload: { skuId: "sku_hat", delta: { value: "-2", unit: "each" } },
		reason: { note: "Count correction" },
		references: [],
		expectedVersions: [{
			skuId: "sku_hat",
			locationId: "location_origin",
			version: originBeforeAdjustment.version,
		}],
	}, { principal });
	assert.equal(adjusted.outcome, "committed");
	assert.deepEqual(await store.readBalance({
		poolId: "pool_test",
		locationId: "location_origin",
		skuId: "sku_hat",
	}), {
		poolId: "pool_test",
		locationId: "location_origin",
		skuId: "sku_hat",
		...stock("8", "0", "4"),
		version: (BigInt(originBeforeAdjustment.version) + 1n).toString(),
		hasStockHistory: true,
	});

	const dispatched = await execute(
		dispatchCommand(updated.transfer, "cmd_transfer_multi_dispatch"),
		{ principal },
	);
	assert.equal(dispatched.outcome, "committed");
	for (const [skuId, originOnHand, inTransit] of [
		["sku_hat", "4", "4"],
		["sku_beanie", "6", "1"],
	]) {
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId })).onHand.value, originOnHand);
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId })).outgoingTransferCommitted.value, "0");
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination_two", skuId })).expected.value, "0");
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination_two", skuId })).inTransit.value, inTransit);
	}
	const reopened = await execute(
		reopenCommand(dispatched.transfer, "cmd_transfer_multi_reopen"),
		{ principal },
	);
	assert.equal(reopened.outcome, "committed");
	for (const [skuId, originOnHand, outgoing, expected] of [
		["sku_hat", "8", "4", "4"],
		["sku_beanie", "7", "1", "1"],
	]) {
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId })).onHand.value, originOnHand);
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId })).outgoingTransferCommitted.value, outgoing);
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination_two", skuId })).expected.value, expected);
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination_two", skuId })).inTransit.value, "0");
	}

	const canceled = await execute(
		cancelCommand(reopened.transfer, "cmd_transfer_multi_cancel"),
		{ principal },
	);
	assert.equal(canceled.outcome, "committed");
	for (const skuId of ["sku_hat", "sku_beanie"]) {
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_origin", skuId })).outgoingTransferCommitted.value, "0");
		assert.equal((await store.readBalance({ poolId: "pool_test", locationId: "location_destination_two", skuId })).expected.value, "0");
	}
	assert.equal((await store.readBalance({
		poolId: "pool_test",
		locationId: "location_destination_two",
		skuId: "sku_hat",
	})).onHand.value, "3");
});

test("durably rejects unsafe transfer inputs and rolls back injected persistence failure", async (t) => {
	const filePath = await databasePath(t, "rejection");
	const durableStore = createLocalSqliteTestStore({ filePath });
	t.after(() => durableStore.close());
	await seed(durableStore, { withOpening: false });
	const execute = boundary(durableStore);
	const noOpening = createCommand("cmd_no_opening", {
		reference: "ST-NO-OPENING",
		lines: [{ skuId: "sku_hat", quantity: { value: "1", unit: "each" } }],
	});
	assert.match(JSON.stringify(await execute(noOpening, { principal })), /opening_balance_required/u);
	assert.equal(JSON.stringify(await execute(noOpening, { principal })), JSON.stringify(await execute(noOpening, { principal })));

	await archiveFixtureLocation(durableStore, {
		locationId: "location_destination",
		name: "Destination",
	});
	assert.match(
		JSON.stringify(await execute(createCommand("cmd_archived", { reference: "ST-ARCHIVED" }), { principal })),
		/location_not_active/u,
	);
	await restoreFixtureLocation(durableStore, {
		locationId: "location_destination",
		name: "Destination",
	});

	const failingStore = {
		...durableStore,
		runTransaction: (poolId, operation) =>
			durableStore.runTransaction(poolId, (transaction) =>
				operation(new Proxy(transaction, {
					get(target, property) {
						if (property === "commitStockTransfer") {
							return (input) => {
								target.commitStockTransfer(input);
								throw new Error("injected transfer persistence failure");
							};
						}
						const value = Reflect.get(target, property, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				})),
			),
	};
	await assert.rejects(
		boundary(failingStore, { transferId: "transfer_rollback" })(
			createCommand("cmd_rollback", { reference: "ST-ROLLBACK" }),
			{ principal },
		),
		/injected transfer persistence failure/u,
	);
	assert.deepEqual(await createReadStockTransfer({ store: durableStore })({
		poolId: "pool_test",
		transferId: "transfer_rollback",
	}), {
		schema: "dinkuskit.inventory.stock-transfer-read-result/v1",
		outcome: "not_found",
		poolId: "pool_test",
		transferId: "transfer_rollback",
	});
});
