import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

async function json(path) {
	return JSON.parse(await text(path));
}

test("real stock-adjustment proof stays local and reopens durable state", async () => {
	const [packageJson, tsconfig, config, probe, assertion, runner] =
		await Promise.all([
			json("../../package.json"),
			json("../../tsconfig.cloudflare.json"),
			json("../../wrangler.stock-adjustment-proof.jsonc"),
			text("../../tools/stock-adjustment-local-proof.ts"),
			text("../../tools/assert-stock-adjustment-real-proof.mjs"),
			text("../../bin/prove-stock-adjustment-real"),
		]);

	assert.equal(
		packageJson.scripts["proof:stock-adjustment:real"],
		"bin/prove-stock-adjustment-real",
	);
	assert.ok(
		tsconfig.include.includes("tools/stock-adjustment-local-proof.ts"),
	);
	assert.equal(config.name, "dinkuskit-inventory-stock-adjustment-proof");
	assert.equal(config.main, "tools/stock-adjustment-local-proof.ts");
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.equal("routes" in config, false);
	assert.deepEqual(config.durable_objects.bindings, [
		{
			name: "STOCK_ADJUSTMENT_PROOF_POOLS",
			class_name: "StockAdjustmentProofPool",
		},
	]);
	assert.deepEqual(config.exports.StockAdjustmentProofPool, {
		type: "durable-object",
		storage: "sqlite",
	});
	assert.match(probe, /createCloudflareSqliteInventoryStore/u);
	assert.match(probe, /initializeCloudflareInventorySchema/u);
	assert.match(probe, /createPreviewStockAdjustment/u);
	assert.match(probe, /createConfirmStockAdjustment/u);
	assert.match(probe, /confirmation:\s*"<redacted>"/u);
	assert.match(assertion, /deepEqual\(replay\.result, commit\.result\)/u);
	assert.match(assertion, /adjustmentReceiptCount, 1/u);
	assert.match(runner, /wrangler dev/u);
	assert.match(runner, /--local/u);
	assert.match(runner, /--persist-to "\$proof_temp\/cloudflare-state"/u);
	assert.match(runner, /wrangler\.stock-adjustment-proof\.jsonc/u);
	assert.match(runner, /stop_runtime/u);
	assert.doesNotMatch(runner, /--remote/u);
});
