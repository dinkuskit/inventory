import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

async function json(path) {
	return JSON.parse(await text(path));
}

test("real aggregate-stock proof stays local and exercises both durable runtimes", async () => {
	const [packageJson, tsconfig, config, probe, sqliteProof, runner] = await Promise.all([
		json("../../package.json"),
		json("../../tsconfig.cloudflare.json"),
		json("../../wrangler.aggregate-stock-proof.jsonc"),
		text("../../tools/aggregate-stock-read-local-probe.ts"),
		text("../../tools/aggregate-stock-read-local-sqlite-proof.mjs"),
		text("../../bin/prove-aggregate-stock-read-real"),
	]);

	assert.equal(
		packageJson.scripts["proof:aggregate-stock-read:real"],
		"bin/prove-aggregate-stock-read-real",
	);
	assert.equal(config.name, "dinkuskit-inventory-aggregate-stock-read-proof");
	assert.deepEqual(config.services, [
		{
			binding: "INVENTORY_SERVICE",
			service: "dinkuskit-inventory",
			remote: false,
		},
	]);
	assert.equal("routes" in config, false);
	assert.ok(
		tsconfig.include.includes("tools/aggregate-stock-read-local-probe.ts"),
	);
	assert.match(probe, /INVENTORY_SERVICE\.readSkuStock\(query\)/u);
	assert.match(sqliteProof, /createLocalSqliteTestStore\(\{ filePath \}\)/u);
	assert.match(sqliteProof, /await store\.close\(\)/u);
	assert.match(runner, /--persist-to "\$proof_temp\/cloudflare-state"/u);
	assert.match(runner, /wrangler\.aggregate-stock-proof\.jsonc/u);
	assert.match(runner, /wrangler\.jsonc/u);
	assert.doesNotMatch(runner, /--remote/u);
});
