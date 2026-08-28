import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
	createExecuteLocationCommand,
	createReadSkuStock,
	createSetOpeningBalance,
} from "../src/index.ts";
import { createLocalSqliteTestStore } from "../src/storage/local-sqlite-test-store.ts";

const filePath = process.argv[2];
if (typeof filePath !== "string" || !isAbsolute(filePath)) {
	throw new TypeError("Pass one new absolute SQLite file path.");
}
try {
	await stat(filePath);
	throw new Error("Refusing to overwrite an existing SQLite file.");
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
		throw error;
	}
}

const principal = Object.freeze({
	kind: "human",
	id: "proof_operator",
	displayName: "Proof Operator",
	surface: "local-proof",
});

function createLocationCommand(commandId, name) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "location.create",
		context: { siteId: "site_local_proof", poolId: "pool_local_proof" },
		payload: { name },
		references: [],
	};
}

let locationNumber = 0;
let locationReceiptNumber = 0;
let store = createLocalSqliteTestStore({ filePath });
try {
	const createLocation = createExecuteLocationCommand({
		store,
		now: () => new Date("2026-08-28T20:20:00.000Z"),
		createLocationId: () => {
			locationNumber += 1;
			return locationNumber === 1 ? "location_home" : "location_warehouse";
		},
		createReceiptId: () => {
			locationReceiptNumber += 1;
			return `rcpt_location_${locationReceiptNumber}`;
		},
	});
	for (const [commandId, name] of [
		["cmd_location_home", "Home"],
		["cmd_location_warehouse", "Warehouse"],
	]) {
		const result = await createLocation(
			createLocationCommand(commandId, name),
			{ principal },
		);
		assert.equal(result.outcome, "committed");
	}

	const opening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T20:21:00.000Z"),
		createReceiptId: () => "rcpt_opening_home",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_opening_home",
			type: "stock.opening_balance",
			context: {
				siteId: "site_local_proof",
				poolId: "pool_local_proof",
				locationId: "location_home",
			},
			payload: {
				skuId: "sku_local_proof_hat",
				quantity: { value: "7.5", unit: "each" },
			},
			reason: { code: "physical_count", note: "Set Initial Stock" },
			references: [],
			expectedVersions: [
				{
					skuId: "sku_local_proof_hat",
					locationId: "location_home",
					version: "0",
				},
			],
		},
		{ principal },
	);
	assert.equal(opening.outcome, "committed");
	await store.close();

	const database = await stat(filePath);
	assert.ok(database.isFile());
	assert.ok(database.size > 0);

	store = createLocalSqliteTestStore({ filePath });
	const result = await createReadSkuStock({ store })({
		poolId: "pool_local_proof",
		skuId: "sku_local_proof_hat",
		scope: { kind: "all_locations" },
	});
	assert.equal(result.outcome, "found");
	assert.equal(result.locations.length, 2);
	assert.deepEqual(result.stock, {
		onHand: { value: "7.5", unit: "each" },
		reserved: { value: "0", unit: "each" },
		available: { value: "7.5", unit: "each" },
	});

	console.log(
		JSON.stringify(
			{
				proof: "real-local-sqlite-file",
				created: true,
				closedAndReopened: true,
				databaseBytes: database.size,
				result,
			},
			null,
			2,
		),
	);
} finally {
	await store.close();
}
