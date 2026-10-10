import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path) {
	return readFile(new URL(path, import.meta.url), "utf8");
}

async function json(path) {
	return JSON.parse(await text(path));
}

test("real checkout-inventory proof stays local and uses actual storage", async () => {
	const [packageJson, sqliteProof, concurrency, commerce, runner, map, wrangler] =
		await Promise.all([
			json("../../package.json"),
			text("../../tools/checkout-inventory-local-sqlite-proof.mjs"),
			text("../../tools/checkout-inventory-concurrency-proof.mjs"),
			text("../../tools/checkout-inventory-commerce-port-proof.mjs"),
			text("../../bin/prove-checkout-inventory-real"),
			text("../../FEATURE_MAP.md"),
			json("../../wrangler.checkout-inventory-proof.jsonc"),
		]);

	assert.equal(
		packageJson.scripts["verify:checkout-inventory"],
		"bin/verify-checkout-inventory",
	);
	assert.match(sqliteProof, /createLocalSqliteTestStore\(\{ filePath \}\)/u);
	assert.match(sqliteProof, /await store\.close\(\)/u);
	assert.match(sqliteProof, /createCheckoutInventoryPort/u);
	assert.match(concurrency, /createLocalSqliteTestStore\(\{ filePath \}\)/u);
	assert.match(concurrency, /operationId/u);
	assert.match(commerce, /CheckoutInventoryPort/u);
	assert.match(commerce, /31427206f834418ac4573f3fccca1771e27dbc42/u);
	assert.doesNotMatch(commerce, /from ["'].*commerce-checkout-experience.*["']/u);
	assert.match(runner, /checkout-inventory-local-sqlite-proof/u);
	assert.match(runner, /checkout-inventory-concurrency-proof/u);
	assert.match(runner, /checkout-inventory-commerce-port-proof/u);
	assert.match(runner, /wrangler\.checkout-inventory-proof\.jsonc/u);
	assert.match(runner, /--persist-to "\$proof_temp\/cloudflare-state"/u);
	assert.doesNotMatch(runner, /--remote/u);
	assert.equal(wrangler.name, "dinkuskit-inventory-checkout-inventory-proof");
	assert.equal(wrangler.main, "tools/checkout-inventory-local-proof.ts");
	assert.equal(wrangler.workers_dev, false);
	assert.match(map, /dinkus\.checkout-inventory/u);
});
