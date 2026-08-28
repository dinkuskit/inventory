import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as inventoryPublicApi from "../../src/index.ts";
import { createSetOpeningBalance } from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";

const principal = Object.freeze({
	kind: "human",
	id: "principal_test_operator",
	surface: "test",
});

test("keeps the local SQLite test adapter out of the platform-neutral root API", () => {
	assert.equal("createLocalSqliteTestStore" in inventoryPublicApi, false);
	assert.equal("LocalSqliteTestInventoryStore" in inventoryPublicApi, false);
});

function openingBalanceCommand({
	commandId = "cmd_opening_001",
	siteId = "site_test",
	poolId = "pool_test",
	locationId = "location_north",
	skuId = "sku_keychain",
	value = "5",
	unit = "each",
	reasonCode = "physical_count",
	reasonNote = "Reviewed opening count",
} = {}) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: { siteId, poolId, locationId },
		payload: {
			skuId,
			quantity: { value, unit },
		},
		reason: { code: reasonCode, note: reasonNote },
		references: [],
		expectedVersions: [{ skuId, locationId, version: "0" }],
	};
}

async function databasePath(t, label) {
	const directory = await mkdtemp(
		join(tmpdir(), `dinkuskit-inventory-${label}-`),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function executor(
	store,
	{
		receiptIds = ["rcpt_opening_001"],
		committedAt = "2026-08-28T12:00:00.000Z",
	} = {},
) {
	let receiptIndex = 0;
	return createSetOpeningBalance({
		store,
		now: () => new Date(committedAt),
		createReceiptId: () => {
			const receiptId = receiptIds[receiptIndex];
			receiptIndex += 1;
			if (receiptId === undefined) {
				throw new Error("test receipt ID sequence exhausted");
			}
			return receiptId;
		},
	});
}

test("commits one opening balance with its immutable receipt and no other location", async (t) => {
	const filePath = await databasePath(t, "commit");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setOpeningBalance = executor(store);
	const command = openingBalanceCommand({ value: "005.000" });

	const result = await setOpeningBalance(command, { principal });

	assert.equal(result.outcome, "committed");
	assert.deepEqual(result, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "committed",
		commandId: "cmd_opening_001",
		receipt: {
			schema: "dinkuskit.inventory.receipt/v1",
			receiptId: "rcpt_opening_001",
			commandId: "cmd_opening_001",
			commandDigest: result.receipt.commandDigest,
			status: "committed",
			type: "stock.opening_balance",
			committedAt: "2026-08-28T12:00:00.000Z",
			principal,
			context: { siteId: "site_test", poolId: "pool_test" },
			reason: {
				code: "physical_count",
				note: "Reviewed opening count",
			},
			effects: [
				{
					skuId: "sku_keychain",
					locationId: "location_north",
					onHandDelta: { value: "5", unit: "each" },
					reservedDelta: { value: "0", unit: "each" },
					balanceAfter: {
						onHand: { value: "5", unit: "each" },
						reserved: { value: "0", unit: "each" },
						available: { value: "5", unit: "each" },
						version: "1",
					},
				},
			],
			references: [],
		},
	});
	assert.match(result.receipt.commandDigest, /^sha256:[a-f0-9]{64}$/u);

	assert.deepEqual(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
		}),
		{
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
			onHand: { value: "5", unit: "each" },
			reserved: { value: "0", unit: "each" },
			available: { value: "5", unit: "each" },
			version: "1",
			hasStockHistory: true,
		},
	);
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_south",
			skuId: "sku_keychain",
		}),
		null,
	);
	assert.deepEqual(
		await store.readReceipt("rcpt_opening_001"),
		result.receipt,
	);
});

test("returns the byte-stable original result for normalized replay after reopen", async (t) => {
	const filePath = await databasePath(t, "replay");
	let store = createLocalSqliteTestStore({ filePath });
	let setOpeningBalance = executor(store);
	const first = await setOpeningBalance(
		openingBalanceCommand({ value: "005.000" }),
		{ principal },
	);
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	setOpeningBalance = executor(store, { receiptIds: [] });
	const replay = await setOpeningBalance(
		openingBalanceCommand({ value: "5.0" }),
		{ principal },
	);

	assert.equal(JSON.stringify(replay), JSON.stringify(first));
});

test("rejects changed content under one command ID while preserving the original", async (t) => {
	const filePath = await databasePath(t, "conflict");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setOpeningBalance = executor(store);
	const original = await setOpeningBalance(openingBalanceCommand(), {
		principal,
	});

	const conflict = await setOpeningBalance(
		openingBalanceCommand({ value: "6" }),
		{ principal },
	);

	assert.deepEqual(conflict, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_opening_001",
		code: "command_id_conflict",
		message: "The command ID is already bound to different contents.",
	});
	assert.equal(
		JSON.stringify(
			await setOpeningBalance(openingBalanceCommand({ value: "5.0" }), {
				principal,
			}),
		),
		JSON.stringify(original),
	);
});

test("stores a second-opening rejection and replays it after reopen", async (t) => {
	const filePath = await databasePath(t, "rejection");
	let store = createLocalSqliteTestStore({ filePath });
	let setOpeningBalance = executor(store, {
		receiptIds: ["rcpt_first"],
	});
	await setOpeningBalance(
		openingBalanceCommand({ commandId: "cmd_first", value: "5" }),
		{ principal },
	);
	const secondCommand = openingBalanceCommand({
		commandId: "cmd_second",
		value: "7",
	});
	const rejected = await setOpeningBalance(secondCommand, { principal });
	assert.deepEqual(rejected, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_second",
		code: "opening_balance_already_set",
		message: "This SKU-location already has committed stock history.",
	});
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	setOpeningBalance = executor(store, { receiptIds: [] });
	assert.equal(
		JSON.stringify(await setOpeningBalance(secondCommand, { principal })),
		JSON.stringify(rejected),
	);
});

test("serializes competing command IDs so only one opening balance commits", async (t) => {
	const filePath = await databasePath(t, "concurrency");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setOpeningBalance = executor(store, {
		receiptIds: ["rcpt_race_1", "rcpt_race_2"],
	});

	const results = await Promise.all([
		setOpeningBalance(
			openingBalanceCommand({ commandId: "cmd_race_1", value: "3" }),
			{ principal },
		),
		setOpeningBalance(
			openingBalanceCommand({ commandId: "cmd_race_2", value: "8" }),
			{ principal },
		),
	]);

	assert.equal(
		results.filter((result) => result.outcome === "committed").length,
		1,
	);
	assert.equal(
		results.filter(
			(result) =>
				result.outcome === "rejected" &&
				result.code === "opening_balance_already_set",
		).length,
		1,
	);
	const balance = await store.readBalance({
		poolId: "pool_test",
		locationId: "location_north",
		skuId: "sku_keychain",
	});
	assert.ok(["3", "8"].includes(balance.onHand.value));
	assert.equal(balance.version, "1");
});

test("rolls back balance and command state when receipt persistence fails", async (t) => {
	const filePath = await databasePath(t, "rollback");
	let store = createLocalSqliteTestStore({ filePath });
	let setOpeningBalance = executor(store, {
		receiptIds: ["rcpt_duplicate"],
	});
	await setOpeningBalance(
		openingBalanceCommand({ commandId: "cmd_north" }),
		{ principal },
	);

	setOpeningBalance = executor(store, {
		receiptIds: ["rcpt_duplicate"],
	});
	const southCommand = openingBalanceCommand({
		commandId: "cmd_south",
		locationId: "location_south",
		value: "9",
	});
	await assert.rejects(
		() => setOpeningBalance(southCommand, { principal }),
		/UNIQUE|constraint/iu,
	);
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_south",
			skuId: "sku_keychain",
		}),
		null,
	);
	await store.close();

	store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	setOpeningBalance = executor(store, {
		receiptIds: ["rcpt_south"],
	});
	const retry = await setOpeningBalance(southCommand, { principal });
	assert.equal(retry.outcome, "committed");
});

test("rejects malformed context and quantities before storage", async (t) => {
	const filePath = await databasePath(t, "validation");
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const setOpeningBalance = executor(store);
	const missingLocation = structuredClone(openingBalanceCommand());
	delete missingLocation.context.locationId;

	await assert.rejects(
		() => setOpeningBalance(missingLocation, { principal }),
		{ name: "InvalidOpeningBalanceCommandError" },
	);
	await assert.rejects(
		() =>
			setOpeningBalance(openingBalanceCommand({ value: "-1" }), {
				principal,
			}),
		{ name: "InvalidOpeningBalanceCommandError" },
	);
	assert.equal(
		await store.readBalance({
			poolId: "pool_test",
			locationId: "location_north",
			skuId: "sku_keychain",
		}),
		null,
	);
});

test("refuses in-memory and production-mode local storage", async (t) => {
	assert.throws(
		() => createLocalSqliteTestStore({ filePath: ":memory:" }),
		/Test SQLite storage requires an explicit absolute file path/u,
	);

	const filePath = await databasePath(t, "production-fence");
	const previousNodeEnv = process.env.NODE_ENV;
	process.env.NODE_ENV = "production";
	try {
		assert.throws(
			() => createLocalSqliteTestStore({ filePath }),
			/Local SQLite storage is development and test only/u,
		);
	} finally {
		if (previousNodeEnv === undefined) {
			delete process.env.NODE_ENV;
		} else {
			process.env.NODE_ENV = previousNodeEnv;
		}
	}
});

test("refuses unrelated and incompatible SQLite files without claiming them", async (t) => {
	const unrelatedPath = await databasePath(t, "unrelated-file");
	let database = new DatabaseSync(unrelatedPath);
	database.exec("CREATE TABLE unrelated_data (value TEXT)");
	database.close();
	let accidentallyOpened;
	t.after(() => accidentallyOpened?.close());

	assert.throws(
		() => {
			accidentallyOpened = createLocalSqliteTestStore({
				filePath: unrelatedPath,
			});
		},
		/SQLite file is not an Inventory local-test database/u,
	);
	database = new DatabaseSync(unrelatedPath);
	assert.deepEqual(
		database
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all()
			.map((row) => row.name),
		["unrelated_data"],
	);
	database.close();

	const incompatiblePath = await databasePath(t, "incompatible-file");
	database = new DatabaseSync(incompatiblePath);
	database.exec(`
		CREATE TABLE inventory_storage_metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		) STRICT;
		INSERT INTO inventory_storage_metadata (key, value)
		VALUES
			('storage_role', 'local-development-test-only'),
			('schema_version', 'opening-balance-local/obsolete');
	`);
	database.close();

	assert.throws(
		() => createLocalSqliteTestStore({ filePath: incompatiblePath }),
		/SQLite file uses an incompatible Inventory local-test schema/u,
	);
});
