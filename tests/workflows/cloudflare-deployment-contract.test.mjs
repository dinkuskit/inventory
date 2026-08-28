import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function json(path) {
	return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("declares one private SQLite Durable Object deployment without tenant configuration", async () => {
	const config = await json("../../wrangler.jsonc");

	assert.equal(config.name, "dinkuskit-inventory");
	assert.equal(config.main, "src/cloudflare/worker.ts");
	assert.equal(config.workers_dev, false);
	assert.equal(config.preview_urls, false);
	assert.equal("routes" in config, false);
	assert.equal("route" in config, false);
	assert.equal("account_id" in config, false);
	assert.equal("vars" in config, false);
	assert.deepEqual(config.durable_objects, {
		bindings: [
			{
				name: "INVENTORY_POOLS",
				class_name: "InventoryPool",
			},
		],
	});
	assert.deepEqual(config.exports, {
		InventoryPool: {
			type: "durable-object",
			storage: "sqlite",
		},
	});
});

test("keeps the remote probe local-only and free of tenant defaults", async () => {
	const config = await json("../../wrangler.probe.jsonc");
	const serialized = JSON.stringify(config);

	assert.equal(config.main, "tools/cloudflare-remote-probe.ts");
	assert.deepEqual(config.services, [
		{
			binding: "INVENTORY_SERVICE",
			service: "dinkuskit-inventory",
			remote: true,
		},
	]);
	assert.equal("routes" in config, false);
	assert.equal("account_id" in config, false);
	assert.doesNotMatch(serialized, /smokyclub|SC-FLEXFIT-BLK/iu);
});

test("keeps Cloudflare runtime code out of the platform-neutral root API", async () => {
	const rootApi = await readFile(
		new URL("../../src/index.ts", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(rootApi, /cloudflare/iu);
});
