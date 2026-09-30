import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
	createCheckoutInventoryPort,
	createReadSkuLocationBalance,
	createReserveCheckoutBasket,
} from "../src/index.ts";
import { createLocalSqliteTestStore } from "../src/storage/local-sqlite-test-store.ts";
import { createFixtureLocation } from "../tests/helpers/location-fixture.mjs";
import { createFixtureManagedSku } from "../tests/helpers/managed-sku-fixture.mjs";

const filePath = process.argv[2];
if (typeof filePath !== "string" || filePath.trim() === "") {
	throw new TypeError("Pass a temporary SQLite file path.");
}

mkdirSync(dirname(filePath), { recursive: true });

const principal = Object.freeze({
	kind: "human",
	id: "proof_operator",
	displayName: "Proof Operator",
	surface: "local-sqlite-proof",
});

async function seed(store) {
	await createFixtureLocation(store, {
		poolId: "pool_test",
		locationId: "location_north",
		name: "Proof Shelf",
	});
	await createFixtureManagedSku(store, { skuId: "sku_hat" });
	await createFixtureManagedSku(store, { skuId: "sku_shirt" });
	for (const [skuId, quantity, commandId, receiptId] of [
		["sku_hat", "10", "cmd_proof_opening_hat", "rcpt_proof_opening_hat"],
		["sku_shirt", "6", "cmd_proof_opening_shirt", "rcpt_proof_opening_shirt"],
	]) {
		const { createSetOpeningBalance } = await import("../src/index.ts");
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
			throw new Error(`Proof opening failed: ${opening.code}`);
		}
	}
}

const request = {
	operationId: "op_proof_checkout",
	binding: {
		providerRef: "dinkuskit.inventory",
		poolId: "pool_test",
		defaultFulfillmentLocationId: "location_north",
	},
	requirements: [
		{ skuId: "sku_hat", quantity: 3, allowBackorders: false },
		{ skuId: "sku_shirt", quantity: 2, allowBackorders: false },
	],
};

const store = createLocalSqliteTestStore({ filePath });
await seed(store);
let reservation = 0;
const reserve = createReserveCheckoutBasket({
	store,
	binding: request.binding,
	now: () => new Date("2026-09-30T12:00:00.000Z"),
	createReservationId: () => `rsv_proof_${++reservation}`,
	createReceiptId: () => "rcpt_proof_reserve",
});
const first = await reserve(request, { principal, siteId: "site_test" });
if (first.outcome !== "reserved") {
	throw new Error(`Proof reserve failed: ${first.code}`);
}
await store.close();

const reopened = createLocalSqliteTestStore({ filePath });
const replay = await createReserveCheckoutBasket({
	store: reopened,
	binding: request.binding,
	now: () => new Date("2026-09-30T12:00:00.000Z"),
	createReservationId: () => "rsv_should_not_mint",
	createReceiptId: () => "rcpt_should_not_mint",
})(request, { principal, siteId: "site_test" });
if (JSON.stringify(replay) !== JSON.stringify(first)) {
	throw new Error("Restart replay did not return the original reserved result.");
}
const read = createReadSkuLocationBalance({ store: reopened });
const hat = await read({
	poolId: "pool_test",
	locationId: "location_north",
	skuId: "sku_hat",
});
if (hat.balance.reserved.value !== "3") {
	throw new Error("Restart lost reserved stock.");
}

const port = createCheckoutInventoryPort({
	store: reopened,
	binding: request.binding,
	now: () => new Date("2026-09-30T12:05:00.000Z"),
	createReservationId: () => "rsv_unused",
	createReceiptId: () => "rcpt_proof_release",
	principal,
	siteId: "site_test",
});
if ((await port.release(request)) !== "released") {
	throw new Error("Proof release failed.");
}
if ((await port.reserve(request)) !== "rejected") {
	throw new Error("Released operation reacquired stock.");
}
await reopened.close();
process.stdout.write(
	JSON.stringify({
		reserve: first.outcome,
		replay: replay.outcome,
		storage: "local-sqlite-file",
	}) + "\n",
);
