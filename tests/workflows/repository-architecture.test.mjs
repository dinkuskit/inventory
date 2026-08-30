import assert from "node:assert/strict";
import test from "node:test";

import {
	auditInventoryArchitecture,
	findImportViolations,
	validateFeatureMap,
} from "../../scripts/architecture-rules.mjs";

const root = new URL("../../", import.meta.url);

test("accepts public feature entries and declared feature dependencies", () => {
	assert.deepEqual(
		findImportViolations(
			"src/index.ts",
			'export * from "./features/managed-sku/index.ts";',
		),
		[],
	);
	assert.deepEqual(
		findImportViolations(
			"src/features/stock-adjustment/adjust.ts",
			'import type { InventoryStore } from "../../storage/inventory-store.ts";',
		),
		[],
	);
	assert.deepEqual(
		findImportViolations(
			"src/application/read-inventory.ts",
			'import type { StockAdjustmentResult } from "../features/stock-adjustment/index.ts";',
		),
		[],
	);
	assert.deepEqual(
		findImportViolations(
			"src/features/managed-sku/register.ts",
			'import type { InventoryStore } from "../../storage/inventory-store.ts";',
		),
		[],
	);
	assert.deepEqual(
		findImportViolations(
			"src/features/managed-sku/domain.ts",
			'import { digestCanonicalValue } from "../../domain/opening-balance.ts";',
		),
		[],
	);
});

test("rejects deep feature imports and undeclared feature dependencies", () => {
	assert.equal(
		findImportViolations(
			"src/index.ts",
			'export * from "./features/managed-sku/domain.ts";',
		).length,
		1,
	);
	assert.equal(
		findImportViolations(
			"tests/consumer.test.mjs",
			'import { createAdjustStock } from "../src/features/stock-adjustment/adjust.ts";',
		).length,
		1,
	);
	assert.equal(
		findImportViolations(
			"src/features/stock-adjustment/adjust.ts",
			'import { initializeCloudflareInventorySchema } from "../../cloudflare/schema.ts";',
		).length,
		1,
	);
	assert.equal(
		findImportViolations(
			"tests/consumer.test.mjs",
			'import { createRegisterManagedSku } from "../src/features/managed-sku/register.ts";',
		).length,
		1,
	);
	assert.equal(
		findImportViolations(
			"src/features/managed-sku/register.ts",
			'import { initializeCloudflareInventorySchema } from "../../cloudflare/schema.ts";',
		).length,
		1,
	);
});

test("the feature map and committed repository satisfy the architecture contract", async () => {
	assert.deepEqual(await validateFeatureMap(root), []);
	assert.deepEqual(await auditInventoryArchitecture(root), []);
});
