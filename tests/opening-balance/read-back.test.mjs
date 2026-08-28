import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	createConfirmOpeningBalance,
	createPreviewOpeningBalance,
	createReadInventoryMutation,
	createReadSkuLocationBalance,
	createSetOpeningBalance,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../helpers/location-fixture.mjs";

const emdashPrincipal = Object.freeze({
	kind: "human",
	id: "emdash_user_123",
	displayName: "Bobby",
	surface: "emdash",
});

function openingBalanceCommand({
	commandId = "cmd_opening_001",
	poolId = "pool_test",
	locationId = "location_north",
	skuId = "sku_keychain",
	value = "5",
} = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId,
			locationId,
		},
		payload: {
			skuId,
			quantity: { value, unit: "each" },
		},
		reason: {
			code: "physical_count",
			note: "Reviewed opening count",
		},
		references: [],
		expectedVersions: [{ skuId, locationId, version: "0" }],
	};
}

function previewInput({ value = "5" } = {}) {
	return {
		schema: "dinkuskit.inventory.opening-balance-preview-input/v1",
		type: "stock.opening_balance",
		context: {
			siteId: "site_test",
			poolId: "pool_test",
			locationId: "location_north",
		},
		payload: {
			skuId: "sku_keychain",
			quantity: { value, unit: "each" },
		},
		reason: {
			code: "physical_count",
			note: "Reviewed opening count",
		},
		references: [],
	};
}

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-read-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function setOpeningBalance(store, receiptId = "rcpt_opening_001") {
	return createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T12:00:00.000Z"),
		createReceiptId: () => receiptId,
	});
}

test("reads only one explicit SKU-location balance with explicit not-found", async (t) => {
	const filePath = await databasePath(t, "balance");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const readBalance = createReadSkuLocationBalance({ store });
	const key = {
		poolId: " pool_test ",
		locationId: " location_north ",
		skuId: " sku_keychain ",
	};

	assert.deepEqual(await readBalance(key), {
		schema: "dinkuskit.inventory.balance-read-result/v1",
		outcome: "not_found",
		key: {
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
		},
	});

	await setOpeningBalance(store)(openingBalanceCommand(), {
		principal: emdashPrincipal,
	});
	const found = await readBalance(key);
	assert.equal(found.outcome, "found");
	assert.deepEqual(found.balance, {
		poolId: "pool_test",
		locationId: "location_north",
		skuId: "sku_keychain",
		onHand: { value: "5", unit: "each" },
		reserved: { value: "0", unit: "each" },
		available: { value: "5", unit: "each" },
		version: "1",
		hasStockHistory: true,
	});
	assert.equal(
		(
			await readBalance({
				poolId: "pool_test",
				locationId: "location_south",
				skuId: "sku_keychain",
			})
		).outcome,
		"not_found",
	);
});

test("reads one committed mutation by receipt ID or command ID after reopen", async (t) => {
	const filePath = await databasePath(t, "committed");
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store);
	const command = openingBalanceCommand();
	command.actor = {
		id: "spoofed_user",
		displayName: "Not Bobby",
		surface: "payload",
	};
	command.payload.actor = command.actor;
	const committed = await setOpeningBalance(store)(command, {
		principal: emdashPrincipal,
	});
	assert.equal(committed.outcome, "committed");
	assert.equal(committed.receipt.schema, "dinkuskit.inventory.receipt/v2");
	assert.deepEqual(committed.receipt.principal, emdashPrincipal);
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const readMutation = createReadInventoryMutation({ store });
	const byReceipt = await readMutation({ receiptId: "rcpt_opening_001" });
	const byCommand = await readMutation({ commandId: "cmd_opening_001" });

	assert.deepEqual(byReceipt, {
		schema: "dinkuskit.inventory.mutation-read-result/v1",
		outcome: "found",
		lookup: { receiptId: "rcpt_opening_001" },
		result: committed,
	});
	assert.deepEqual(byCommand, {
		schema: "dinkuskit.inventory.mutation-read-result/v1",
		outcome: "found",
		lookup: { commandId: "cmd_opening_001" },
		result: committed,
	});
});

test("reads a stable rejection by command ID and never invents a receipt", async (t) => {
	const filePath = await databasePath(t, "rejection");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const setBalance = setOpeningBalance(store, "rcpt_first");
	await setBalance(openingBalanceCommand({ commandId: "cmd_first" }), {
		principal: emdashPrincipal,
	});
	const rejected = await setBalance(
		openingBalanceCommand({ commandId: "cmd_rejected", value: "8" }),
		{ principal: emdashPrincipal },
	);
	assert.equal(rejected.outcome, "rejected");
	const readMutation = createReadInventoryMutation({ store });

	assert.deepEqual(await readMutation({ commandId: "cmd_rejected" }), {
		schema: "dinkuskit.inventory.mutation-read-result/v1",
		outcome: "found",
		lookup: { commandId: "cmd_rejected" },
		result: rejected,
	});
	assert.deepEqual(await readMutation({ receiptId: "rcpt_rejected" }), {
		schema: "dinkuskit.inventory.mutation-read-result/v1",
		outcome: "not_found",
		lookup: { receiptId: "rcpt_rejected" },
	});
	assert.equal("receipt" in rejected, false);
});

test("returns explicit not-found and rejects ambiguous or blank lookups", async (t) => {
	const filePath = await databasePath(t, "lookup-validation");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const readMutation = createReadInventoryMutation({ store });
	const readBalance = createReadSkuLocationBalance({ store });

	assert.deepEqual(await readMutation({ commandId: " missing_command " }), {
		schema: "dinkuskit.inventory.mutation-read-result/v1",
		outcome: "not_found",
		lookup: { commandId: "missing_command" },
	});
	await assert.rejects(
		() => readMutation({}),
		{ name: "InvalidInventoryReadQueryError" },
	);
	await assert.rejects(
		() =>
			readMutation({
				commandId: "cmd_opening_001",
				receiptId: "rcpt_opening_001",
			}),
		{ name: "InvalidInventoryReadQueryError" },
	);
	await assert.rejects(
		() => readMutation({ receiptId: "  " }),
		{ name: "InvalidInventoryReadQueryError" },
	);
	await assert.rejects(
		() =>
			readBalance({
				poolId: "pool_test",
				locationId: "",
				skuId: "sku_keychain",
			}),
		{ name: "InvalidInventoryReadQueryError" },
	);
});

test("binds confirmation to stable user identity and freezes the commit-time name", async (t) => {
	const filePath = await databasePath(t, "historical-name");
	let store = createLocalSqliteTestStore({ filePath });
	await createFixtureLocation(store);
	const now = () => new Date("2026-08-28T12:00:00.000Z");
	const preview = createPreviewOpeningBalance({
		store,
		now,
		createConfirmation: () => "confirm_historical_name",
	});
	const confirm = createConfirmOpeningBalance({
		store,
		now,
		createReceiptId: () => "rcpt_historical_name",
	});
	const input = previewInput();
	const beforeRename = { ...emdashPrincipal, displayName: "Bobby Before" };
	const atCommit = { ...emdashPrincipal, displayName: "Bobby At Commit" };
	const afterRename = { ...emdashPrincipal, displayName: "Bobby Later" };
	const proposed = await preview(input, { principal: beforeRename });
	const command = openingBalanceCommand();

	const first = await confirm(proposed.confirmation.value, command, {
		principal: atCommit,
	});
	assert.equal(first.outcome, "committed");
	assert.deepEqual(first.receipt.principal, atCommit);
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const replayConfirm = createConfirmOpeningBalance({
		store,
		now,
		createReceiptId: () => {
			throw new Error("exact replay must not create another receipt");
		},
	});
	const replay = await replayConfirm(proposed.confirmation.value, command, {
		principal: afterRename,
	});
	assert.equal(JSON.stringify(replay), JSON.stringify(first));

	const readMutation = createReadInventoryMutation({ store });
	const read = await readMutation({ commandId: "cmd_opening_001" });
	assert.equal(read.outcome, "found");
	assert.deepEqual(read.result.receipt.principal, atCommit);
});

test("requires a human display name without inventing one for system receipts", async (t) => {
	const filePath = await databasePath(t, "principal-kinds");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	await createFixtureLocation(store);
	const setBalance = setOpeningBalance(store, "rcpt_system");

	await assert.rejects(
		() =>
			setBalance(openingBalanceCommand(), {
				principal: {
					kind: "human",
					id: "emdash_user_missing_name",
					surface: "emdash",
				},
			}),
		{ name: "InvalidOpeningBalanceCommandError" },
	);
	const systemPrincipal = {
		kind: "system",
		id: "inventory_reconciler",
		surface: "job",
	};
	const committed = await setBalance(openingBalanceCommand(), {
		principal: systemPrincipal,
	});
	assert.equal(committed.outcome, "committed");
	assert.deepEqual(committed.receipt.principal, systemPrincipal);
	assert.equal("displayName" in committed.receipt.principal, false);
});
