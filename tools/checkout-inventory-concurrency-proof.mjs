import {
	createReserveCheckoutBasket,
	createSetOpeningBalance,
} from "../src/index.ts";
import { createLocalSqliteTestStore } from "../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../tests/helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../tests/helpers/managed-sku-fixture.mjs";

const [filePath, operationId, seed] = process.argv.slice(2);
if (typeof filePath !== "string" || typeof operationId !== "string") {
	throw new TypeError("Pass a SQLite file path and operation ID.");
}

const principal = Object.freeze({
	kind: "human",
	id: "principal_checkout_operator",
	displayName: "Checkout Operator",
	surface: "concurrency-proof",
});

const store = createLocalSqliteTestStore({ filePath });
if (seed === "seed") {
	await createFixtureLocation(store);
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	await createFixtureManagedSku(store, { skuId: "sku_shirt" });
	for (const [skuId, quantity, commandId, receiptId] of [
		["sku_hat", "3", "cmd_opening_hat", "rcpt_opening_hat"],
		["sku_shirt", "2", "cmd_opening_shirt", "rcpt_opening_shirt"],
	]) {
		const opening = await createSetOpeningBalance({
			store,
			now: () => new Date("2026-09-30T10:00:00.000Z"),
			createReceiptId: () => receiptId,
		})(
			{
				schema: "dinkuskit.inventory.command/v1",
				commandId,
				type: "stock.opening_balance",
				context: {
					siteId: "site_test",
					poolId: "pool_test",
					locationId: "location_north",
				},
				payload: { skuId, quantity: { value: quantity, unit: "each" } },
				reason: { code: "opening_balance", note: "Set Initial Stock" },
				references: [],
				expectedVersions: [{ skuId, locationId: "location_north", version: "0" }],
			},
			{ principal },
		);
		if (opening.outcome !== "committed") {
			throw new Error(`Seed failed: ${opening.code}`);
		}
	}
	await store.close();
	process.stdout.write(JSON.stringify({ seeded: true }));
	process.exit(0);
}

let reservation = 0;
const result = await createReserveCheckoutBasket({
	store,
	binding: {
		providerRef: "dinkuskit.inventory",
		poolId: "pool_test",
		defaultFulfillmentLocationId: "location_north",
	},
	now: () => new Date("2026-09-30T12:00:00.000Z"),
	createReservationId: () => `rsv_${operationId}_${++reservation}`,
	createReceiptId: () => `rcpt_${operationId}`,
})(
	{
		operationId,
		binding: {
			providerRef: "dinkuskit.inventory",
			poolId: "pool_test",
			defaultFulfillmentLocationId: "location_north",
		},
		requirements: [
			{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
			{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
		],
	},
	{ principal, siteId: "site_test" },
);
await store.close();
process.stdout.write(JSON.stringify({ outcome: result.outcome, code: result.code ?? null }));
