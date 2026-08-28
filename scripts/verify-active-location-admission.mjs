import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	createExecuteLocationCommand,
	createSetOpeningBalance,
} from "../src/index.ts";
import { createLocalSqliteTestStore } from "../src/storage/local-sqlite-test-store.ts";

const poolId = "pool_runtime_proof";
const principal = Object.freeze({
	kind: "human",
	id: "principal_runtime_proof",
	displayName: "Runtime Proof Operator",
	surface: "repo-verifier",
});

function locationCommand(type, locationId, name) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: `cmd_runtime_${type.replace("location.", "")}_${locationId}`,
		type,
		context:
			type === "location.create"
				? { siteId: "site_runtime_proof", poolId }
				: { siteId: "site_runtime_proof", poolId, locationId },
		payload: type === "location.create" ? { name } : {},
		references: [],
	};
}

async function executeLocation(store, type, locationId, name) {
	const suffix = type.replace("location.", "");
	const execute = createExecuteLocationCommand({
		store,
		now: () => new Date("2026-08-28T10:00:00.000Z"),
		createLocationId: () => locationId,
		createReceiptId: () => `rcpt_runtime_${suffix}_${locationId}`,
	});
	const result = await execute(locationCommand(type, locationId, name), {
		principal,
	});
	assert.equal(result.outcome, "committed");
	return result;
}

function openingCommand(commandId, locationId) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.opening_balance",
		context: {
			siteId: "site_runtime_proof",
			poolId,
			locationId,
		},
		payload: {
			skuId: "sku_runtime_hat",
			quantity: { value: "4", unit: "each" },
		},
		reason: { code: "physical_count", note: "Set Initial Stock" },
		references: [],
		expectedVersions: [
			{ skuId: "sku_runtime_hat", locationId, version: "0" },
		],
	};
}

const directory = await mkdtemp(
	join(tmpdir(), "dinkuskit-inventory-active-location-proof-"),
);
const filePath = join(directory, "inventory.sqlite");
let store;
let transcript;

try {
	store = createLocalSqliteTestStore({ filePath });
	await executeLocation(
		store,
		"location.create",
		"location_active",
		"Active Runtime Location",
	);
	await executeLocation(
		store,
		"location.create",
		"location_archived",
		"Archived Runtime Location",
	);
	await executeLocation(
		store,
		"location.archive",
		"location_archived",
		"Archived Runtime Location",
	);

	let openingReceiptIdsRequested = 0;
	const setOpeningBalance = createSetOpeningBalance({
		store,
		now: () => new Date("2026-08-28T12:00:00.000Z"),
		createReceiptId: () => {
			openingReceiptIdsRequested += 1;
			return `rcpt_runtime_opening_${openingReceiptIdsRequested}`;
		},
	});
	const active = await setOpeningBalance(
		openingCommand("cmd_runtime_opening_active", "location_active"),
		{ principal },
	);
	const archivedCommand = openingCommand(
		"cmd_runtime_opening_archived",
		"location_archived",
	);
	const archived = await setOpeningBalance(archivedCommand, { principal });
	const unknownCommand = openingCommand(
		"cmd_runtime_opening_unknown",
		"location_unknown",
	);
	const unknown = await setOpeningBalance(unknownCommand, { principal });

	assert.equal(active.outcome, "committed");
	assert.deepEqual(archived, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_runtime_opening_archived",
		code: "location_not_active",
		message: "The location is archived and cannot receive stock.",
	});
	assert.deepEqual(unknown, {
		schema: "dinkuskit.inventory.command-result/v1",
		outcome: "rejected",
		commandId: "cmd_runtime_opening_unknown",
		code: "location_not_found",
		message: "The location does not exist in this inventory pool.",
	});
	assert.equal(openingReceiptIdsRequested, 1);
	assert.equal(
		await store.readBalance({
			poolId,
			locationId: "location_archived",
			skuId: "sku_runtime_hat",
		}),
		null,
	);
	assert.equal(
		await store.readBalance({
			poolId,
			locationId: "location_unknown",
			skuId: "sku_runtime_hat",
		}),
		null,
	);
	assert.equal(await store.readReceipt("rcpt_runtime_opening_2"), null);

	await executeLocation(
		store,
		"location.restore",
		"location_archived",
		"Archived Runtime Location",
	);
	const archivedReplay = await setOpeningBalance(archivedCommand, { principal });
	await executeLocation(
		store,
		"location.create",
		"location_unknown",
		"Formerly Unknown Runtime Location",
	);
	const unknownReplay = await setOpeningBalance(unknownCommand, { principal });
	assert.equal(JSON.stringify(archivedReplay), JSON.stringify(archived));
	assert.equal(JSON.stringify(unknownReplay), JSON.stringify(unknown));
	assert.equal(openingReceiptIdsRequested, 1);

	transcript = {
		schema:
			"dinkuskit.inventory.verification.active-location-admission/v1",
		storage: "temporary local SQLite file",
		active: {
			outcome: active.outcome,
			onHand: active.receipt.effects[0].balanceAfter.onHand,
			receiptCreated: true,
		},
		archived: {
			outcome: archived.outcome,
			code: archived.code,
			balanceCreated: false,
			receiptCreated: false,
			replayAfterRestoreExact: true,
		},
		unknown: {
			outcome: unknown.outcome,
			code: unknown.code,
			balanceCreated: false,
			receiptCreated: false,
			replayAfterCreateExact: true,
		},
		openingReceiptIdsRequested,
	};
} finally {
	await store?.close();
	await rm(directory, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
