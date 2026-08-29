import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
	COMMAND_SCHEMA,
	createExecuteLocationCommand,
	createListLocations,
	createReadInventoryMutation,
	createReadReceiptHistory,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";

const principal = Object.freeze({
	kind: "human",
	id: "principal_test_operator",
	displayName: "Test Operator",
	surface: "test",
});

async function databasePath(t, name) {
	const directory = await mkdtemp(join(tmpdir(), `inventory-location-${name}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite3");
}

function command(
	type,
	{
		commandId = `cmd_${type.replace(".", "_")}`,
		poolId = "pool_test",
		locationId = "location_warehouse",
		name = "Warehouse",
	} = {},
) {
	return {
		schema: COMMAND_SCHEMA,
		commandId,
		type,
		context:
			type === "location.create"
				? { siteId: "site_test", poolId }
				: { siteId: "site_test", poolId, locationId },
		payload:
			type === "location.create" || type === "location.rename"
				? { name }
				: {},
		references: [],
	};
}

function executor(
	store,
	{
		locationIds = ["location_warehouse"],
		receiptIds = ["rcpt_location"],
		now = "2026-08-28T16:00:00.000Z",
	} = {},
) {
	const remainingLocationIds = [...locationIds];
	const remainingReceiptIds = [...receiptIds];
	const calls = { locationIds: 0, receiptIds: 0 };
	return {
		calls,
		execute: createExecuteLocationCommand({
			store,
			now: () => new Date(now),
			createLocationId: () => {
				calls.locationIds += 1;
				return remainingLocationIds.shift();
			},
			createReceiptId: () => {
				calls.receiptIds += 1;
				return remainingReceiptIds.shift();
			},
		}),
	};
}

function openingBalanceCommand(commandId = "cmd_opening") {
	return {
		schema: COMMAND_SCHEMA,
		commandId,
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "unregistered_location",
		},
		payload: {
			skuId: "sku_test_hat",
			quantity: { value: "1", unit: "each" },
		},
		reason: { code: "physical_count", note: "Test count" },
		references: [],
		expectedVersions: [
			{
				skuId: "sku_test_hat",
				locationId: "unregistered_location",
				version: "0",
			},
		],
	};
}

test("creates one durable location and exactly replays the terminal result", async (t) => {
	const filePath = await databasePath(t, "create-replay");
	let store = createLocalSqliteTestStore({ filePath });
	let setup = executor(store, {
		locationIds: ["location_warehouse", "location_unexpected"],
		receiptIds: ["rcpt_create", "rcpt_unexpected"],
	});
	const input = command("location.create", {
		commandId: "cmd_create",
		name: "  Warehouse  ",
	});
	const first = await setup.execute(input, { principal });
	const immediateReplay = await setup.execute(input, { principal });

	assert.equal(first.outcome, "committed");
	assert.equal(first.receipt.type, "location.create");
	assert.equal(first.receipt.principal.displayName, "Test Operator");
	assert.equal(first.receipt.effect.before, null);
	assert.deepEqual(first.receipt.effect.after, {
		poolId: "pool_test",
		locationId: "location_warehouse",
		name: "Warehouse",
		nameKey: "warehouse",
		status: "active",
		version: "1",
		createdAt: "2026-08-28T16:00:00.000Z",
		updatedAt: "2026-08-28T16:00:00.000Z",
		archivedAt: null,
	});
	assert.equal(JSON.stringify(immediateReplay), JSON.stringify(first));
	assert.deepEqual(setup.calls, { locationIds: 1, receiptIds: 1 });

	await store.close();
	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	setup = executor(store, { locationIds: [], receiptIds: [] });
	const afterReopen = await setup.execute(input, { principal });
	assert.equal(JSON.stringify(afterReopen), JSON.stringify(first));
	assert.deepEqual(setup.calls, { locationIds: 0, receiptIds: 0 });

	const listLocations = createListLocations({ store });
	assert.deepEqual(await listLocations({ poolId: "pool_test", status: "active" }), {
		schema: "dinkuskit.inventory.location-list-result/v1",
		poolId: "pool_test",
		status: "active",
		locations: [first.receipt.effect.after],
	});
});

test("reserves each location name across active and archived records", async (t) => {
	const filePath = await databasePath(t, "unique-name");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	let setup = executor(store, {
		locationIds: ["location_first", "location_second"],
		receiptIds: ["rcpt_first", "rcpt_archive", "rcpt_second"],
	});
	const created = await setup.execute(
		command("location.create", {
			commandId: "cmd_first",
			name: "Warehouse",
		}),
		{ principal },
	);
	assert.equal(created.outcome, "committed");
	const archived = await setup.execute(
		command("location.archive", {
			commandId: "cmd_archive",
			locationId: "location_first",
		}),
		{ principal },
	);
	assert.equal(archived.outcome, "committed");

	const duplicateInput = command("location.create", {
		commandId: "cmd_duplicate",
		name: " warehouse ",
	});
	const duplicate = await setup.execute(duplicateInput, { principal });
	assert.deepEqual(duplicate, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_duplicate",
		code: "location_name_conflict",
		message: "Another location already uses this name.",
	});
	assert.equal(
		JSON.stringify(await setup.execute(duplicateInput, { principal })),
		JSON.stringify(duplicate),
	);
	assert.equal(setup.calls.locationIds, 1);
	assert.deepEqual(
		(await createListLocations({ store })({
			poolId: "pool_test",
			status: "archived",
		})).locations.map((location) => location.locationId),
		["location_first"],
	);
});

test("renames, archives, and restores one permanent location with immutable receipts", async (t) => {
	const filePath = await databasePath(t, "lifecycle");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setup = executor(store, {
		locationIds: ["location_permanent"],
		receiptIds: [
			"rcpt_create",
			"rcpt_rename",
			"rcpt_archive",
			"rcpt_restore",
		],
	});
	const created = await setup.execute(
		command("location.create", { commandId: "cmd_create", name: "Warehouse" }),
		{ principal },
	);
	const renamed = await setup.execute(
		command("location.rename", {
			commandId: "cmd_rename",
			locationId: "location_permanent",
			name: "Primary Warehouse",
		}),
		{ principal },
	);
	const archived = await setup.execute(
		command("location.archive", {
			commandId: "cmd_archive",
			locationId: "location_permanent",
		}),
		{ principal },
	);
	const restored = await setup.execute(
		command("location.restore", {
			commandId: "cmd_restore",
			locationId: "location_permanent",
		}),
		{ principal },
	);

	assert.equal(created.receipt.effect.after.version, "1");
	assert.equal(renamed.receipt.effect.before.name, "Warehouse");
	assert.equal(renamed.receipt.effect.after.name, "Primary Warehouse");
	assert.equal(renamed.receipt.effect.after.locationId, "location_permanent");
	assert.equal(renamed.receipt.effect.after.version, "2");
	assert.equal(archived.receipt.effect.after.status, "archived");
	assert.equal(archived.receipt.effect.after.version, "3");
	assert.equal(restored.receipt.effect.after.status, "active");
	assert.equal(restored.receipt.effect.after.archivedAt, null);
	assert.equal(restored.receipt.effect.after.version, "4");

	const listLocations = createListLocations({ store });
	assert.deepEqual(
		(await listLocations({ poolId: "pool_test", status: "active" })).locations,
		[restored.receipt.effect.after],
	);
	assert.deepEqual(
		(await listLocations({ poolId: "pool_test", status: "archived" })).locations,
		[],
	);
	const byReceipt = await createReadInventoryMutation({ store })({
		receiptId: "rcpt_archive",
	});
	assert.equal(byReceipt.outcome, "found");
	assert.equal(byReceipt.result.receipt.type, "location.archive");
	assert.equal(byReceipt.result.receipt.principal.id, principal.id);
	assert.deepEqual(
		(await createReadReceiptHistory({ store })({
			poolId: "pool_test",
			scope: { kind: "all_locations" },
		})).receipts,
		[],
	);
});

test("blocks archive for every physical, order, and transfer quantity and durably replays the blockers", async (t) => {
	const filePath = await databasePath(t, "archive-blockers");
	let store = createLocalSqliteTestStore({ filePath });
	let setup = executor(store, {
		locationIds: ["location_blocked"],
		receiptIds: ["rcpt_create", "rcpt_unexpected"],
	});
	await setup.execute(
		command("location.create", { commandId: "cmd_create", name: "Warehouse" }),
		{ principal },
	);
	await store.close();

	let database = new DatabaseSync(filePath);
	const insert = database.prepare(
		`INSERT INTO inventory_balances
		   (pool_id, location_id, sku_id, on_hand_value, reserved_value,
		    available_value, unit, version, has_stock_history)
		 VALUES (?, ?, ?, ?, ?, ?, 'each', 1, 1)`,
	);
	insert.run("pool_test", "location_blocked", "sku_negative", "-2", "0", "-2");
	insert.run("pool_test", "location_blocked", "sku_positive", "5", "0", "5");
	insert.run("pool_test", "location_blocked", "sku_reserved", "0", "3", "-3");
	insert.run("pool_test", "location_blocked", "sku_outgoing", "0", "0", "0");
	insert.run("pool_test", "location_blocked", "sku_expected", "0", "0", "0");
	insert.run("pool_test", "location_blocked", "sku_in_transit", "0", "0", "0");
	database.exec(
		`UPDATE inventory_balances
		 SET outgoing_transfer_committed_value = '2', available_value = '-2'
		 WHERE sku_id = 'sku_outgoing';
		 UPDATE inventory_balances SET expected_value = '4'
		 WHERE sku_id = 'sku_expected';
		 UPDATE inventory_balances SET in_transit_value = '6'
		 WHERE sku_id = 'sku_in_transit'`,
	);
	database.close();

	store = createLocalSqliteTestStore({ filePath });
	setup = executor(store, { receiptIds: [] });
	const archiveInput = command("location.archive", {
		commandId: "cmd_blocked_archive",
		locationId: "location_blocked",
	});
	const blocked = await setup.execute(archiveInput, { principal });
	assert.deepEqual(blocked, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_blocked_archive",
		code: "location_not_empty",
		message: "The location must have zero physical, reserved, committed, expected, and in-transit stock before archiving.",
		blockers: [
			{
				skuId: "sku_expected",
				onHand: { value: "0", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				expected: { value: "4", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			},
			{
				skuId: "sku_in_transit",
				onHand: { value: "0", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "6", unit: "each" },
			},
			{
				skuId: "sku_negative",
				onHand: { value: "-2", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			},
			{
				skuId: "sku_outgoing",
				onHand: { value: "0", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "2", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			},
			{
				skuId: "sku_positive",
				onHand: { value: "5", unit: "each" },
				reserved: { value: "0", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			},
			{
				skuId: "sku_reserved",
				onHand: { value: "0", unit: "each" },
				reserved: { value: "3", unit: "each" },
				outgoingTransferCommitted: { value: "0", unit: "each" },
				expected: { value: "0", unit: "each" },
				inTransit: { value: "0", unit: "each" },
			},
		],
	});
	await store.close();

	database = new DatabaseSync(filePath);
	database.exec(
		`UPDATE inventory_balances
		 SET on_hand_value = '0', reserved_value = '0',
		     outgoing_transfer_committed_value = '0', available_value = '0',
		     expected_value = '0', in_transit_value = '0'`,
	);
	database.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	setup = executor(store, { receiptIds: ["rcpt_archive"] });
	assert.equal(
		JSON.stringify(await setup.execute(archiveInput, { principal })),
		JSON.stringify(blocked),
	);
	const archived = await setup.execute(
		command("location.archive", {
			commandId: "cmd_archive_after_clear",
			locationId: "location_blocked",
		}),
		{ principal },
	);
	assert.equal(archived.outcome, "committed");
	assert.equal(archived.receipt.effect.after.status, "archived");
});

test("rolls back location and command state when receipt persistence fails", async (t) => {
	const filePath = await databasePath(t, "rollback");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	let setup = executor(store, {
		locationIds: ["location_first", "location_rolled_back"],
		receiptIds: ["rcpt_duplicate", "rcpt_duplicate"],
	});
	await setup.execute(
		command("location.create", { commandId: "cmd_first", name: "First" }),
		{ principal },
	);
	const secondInput = command("location.create", {
		commandId: "cmd_second",
		name: "Second",
	});
	await assert.rejects(
		() => setup.execute(secondInput, { principal }),
		/UNIQUE|constraint/iu,
	);
	assert.equal(await store.readCommand("cmd_second"), null);
	assert.deepEqual(
		(await store.listLocations({ poolId: "pool_test", status: "active" })).map(
			(location) => location.locationId,
		),
		["location_first"],
	);

	setup = executor(store, {
		locationIds: ["location_retry"],
		receiptIds: ["rcpt_retry"],
	});
	const retry = await setup.execute(secondInput, { principal });
	assert.equal(retry.outcome, "committed");
	assert.equal(retry.receipt.effect.after.locationId, "location_retry");
});

test("keeps command IDs unique across stock and location commands", async (t) => {
	const filePath = await databasePath(t, "cross-command-conflict");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setOpeningBalance = createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T16:00:00.000Z"),
		createReceiptId: () => "rcpt_opening",
	});
	await setOpeningBalance(openingBalanceCommand("cmd_shared"), { principal });

	const setup = executor(store, {
		locationIds: ["location_unexpected"],
		receiptIds: ["rcpt_unexpected"],
	});
	assert.deepEqual(
		await setup.execute(
			command("location.create", {
				commandId: "cmd_shared",
				name: "Warehouse",
			}),
			{ principal },
		),
		{
			schema: "dinkuskit.inventory.command-result/v1",
			outcome: "rejected",
			commandId: "cmd_shared",
			code: "command_id_conflict",
			message: "The command ID is already bound to different contents.",
		},
	);
	assert.deepEqual(setup.calls, { locationIds: 0, receiptIds: 0 });
	assert.deepEqual(
		await store.listLocations({ poolId: "pool_test", status: "active" }),
		[],
	);
});

test("rejects malformed names and missing target locations before storage", async (t) => {
	const filePath = await databasePath(t, "validation");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setup = executor(store);

	await assert.rejects(
		() =>
			setup.execute(
				command("location.create", { commandId: "cmd_blank", name: "   " }),
				{ principal },
			),
		{ name: "InvalidLocationCommandError" },
	);
	const missing = command("location.archive", {
		commandId: "cmd_missing_location",
	});
	delete missing.context.locationId;
	await assert.rejects(() => setup.execute(missing, { principal }), {
		name: "InvalidLocationCommandError",
	});
	assert.equal(await store.readCommand("cmd_blank"), null);
	assert.equal(await store.readCommand("cmd_missing_location"), null);
});
