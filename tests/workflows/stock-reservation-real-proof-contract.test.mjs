import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

async function json(path) {
	return JSON.parse(await text(path));
}

test("real stock-reservation proof stays local and reopens durable state", async () => {
	const [packageJson, tsconfig, config, probe, sqliteProof, assertion, runner] =
		await Promise.all([
			json("../../package.json"),
			json("../../tsconfig.cloudflare.json"),
			json("../../wrangler.stock-reservation-proof.jsonc"),
			text("../../tools/stock-reservation-local-proof.ts"),
			text("../../tools/stock-reservation-local-sqlite-proof.mjs"),
			text("../../tools/assert-stock-reservation-real-proof.mjs"),
			text("../../bin/prove-stock-reservation-real"),
		]);

	assert.equal(
		packageJson.scripts["proof:stock-reservation:real"],
		"bin/prove-stock-reservation-real",
	);
	assert.ok(
		tsconfig.include.includes("tools/stock-reservation-local-proof.ts"),
	);
	assert.equal(config.name, "dinkuskit-inventory-stock-reservation-proof");
	assert.equal(config.main, "tools/stock-reservation-local-proof.ts");
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.equal("routes" in config, false);
	assert.deepEqual(config.durable_objects.bindings, [
		{
			name: "STOCK_RESERVATION_PROOF_POOLS",
			class_name: "StockReservationProofPool",
		},
	]);
	assert.match(probe, /createCloudflareSqliteInventoryStore/u);
	assert.match(probe, /initializeCloudflareInventorySchema/u);
	assert.match(probe, /createReserveStock/u);
	assert.match(probe, /createReleaseStock/u);
	assert.match(probe, /DROP TABLE inventory_reservations/u);
	assert.match(sqliteProof, /createLocalSqliteTestStore\(\{ filePath \}\)/u);
	assert.match(sqliteProof, /await store\.close\(\)/u);
	assert.match(assertion, /deepEqual\(replay\.result, commit\.reserve\)/u);
	assert.match(assertion, /order_line_conflict/u);
	assert.match(assertion, /\[4, 5\]/u);
	assert.match(runner, /wrangler dev/u);
	assert.match(runner, /--local/u);
	assert.match(runner, /--persist-to "\$proof_temp\/cloudflare-state"/u);
	assert.match(runner, /wrangler\.stock-reservation-proof\.jsonc/u);
	assert.match(runner, /stop_runtime/u);
	assert.doesNotMatch(runner, /--remote/u);
});
