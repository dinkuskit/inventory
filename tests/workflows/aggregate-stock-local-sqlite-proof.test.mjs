import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const proof = new URL("../../tools/aggregate-stock-read-local-sqlite-proof.mjs", import.meta.url);

function runProof(filePath) {
	return execute(process.execPath, [
		"--experimental-sqlite",
		"--experimental-strip-types",
		proof.pathname,
		filePath,
	], { timeout: 15000 });
}

async function databasePath(t) {
	const directory = await mkdtemp(join(tmpdir(), "inventory-aggregate-proof-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function stock(value) {
	return {
		onHand: { value, unit: "each" },
		reserved: { value: "0", unit: "each" },
		outgoingTransferCommitted: { value: "0", unit: "each" },
		available: { value, unit: "each" },
		expected: { value: "0", unit: "each" },
		inTransit: { value: "0", unit: "each" },
	};
}

test("real SQLite aggregate proof reopens a registered SKU with stock and a zero location", async (t) => {
	const filePath = await databasePath(t);
	const { stdout } = await runProof(filePath);
	const report = JSON.parse(stdout);
	assert.equal(report.proof, "real-local-sqlite-file");
	assert.equal(report.created, true);
	assert.equal(report.closedAndReopened, true);
	assert.ok(report.databaseBytes > 0);
	assert.deepEqual(report.result, {
		schema: "dinkuskit.inventory.sku-stock-read-result/v1",
		outcome: "found",
		poolId: "pool_local_proof",
		skuId: "sku_local_proof_hat",
		scope: { kind: "all_locations" },
		stock: stock("7.5"),
		locations: [
			{ locationId: "location_home", name: "Home", stock: stock("7.5") },
			{ locationId: "location_warehouse", name: "Warehouse", stock: stock("0") },
		],
	});
});

test("real SQLite aggregate proof refuses existing files without changing their bytes", async (t) => {
	const filePath = await databasePath(t);
	const original = Buffer.from("existing proof data\n");
	await writeFile(filePath, original);
	await assert.rejects(runProof(filePath), (error) => {
		assert.equal(error.code, 1);
		assert.match(error.stderr, /Refusing to overwrite an existing SQLite file/u);
		return true;
	});
	assert.deepEqual(await readFile(filePath), original);
});
