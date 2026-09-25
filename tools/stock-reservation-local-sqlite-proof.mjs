import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
	createReadSkuLocationBalance,
	createReleaseStock,
	createReserveStock,
	createSetOpeningBalance,
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

const context = Object.freeze({
	siteId: "site_local_proof",
	poolId: "pool_reservation_proof",
	locationId: "location_proof_shelf",
});

async function seed(store) {
	await createFixtureLocation(store, {
		poolId: context.poolId,
		locationId: context.locationId,
		name: "Proof Shelf",
	});
	await createFixtureManagedSku(store, {
		poolId: context.poolId,
		skuId: "sku_hat",
		sku: "PROOF-HAT",
		displayName: "Proof Hat",
	});
	const opening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-09-25T16:00:00.000Z"),
		createReceiptId: () => "rcpt_proof_opening",
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId: "cmd_proof_opening",
			type: "stock.opening_balance",
			context,
			payload: { skuId: "sku_hat", quantity: { value: "10", unit: "each" } },
			reason: { code: "opening_balance", note: "Set Initial Stock" },
			references: [],
			expectedVersions: [
				{ skuId: "sku_hat", locationId: context.locationId, version: "0" },
			],
		},
		{ principal },
	);
	if (opening.outcome !== "committed") {
		throw new Error(`Proof opening failed: ${opening.code}`);
	}
}

function reserveCommand(commandId, quantity) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.reserve",
		context,
		payload: {
			skuId: "sku_hat",
			quantity: { value: quantity, unit: "each" },
			orderLine: { kind: "commerce.order_line", id: "OL-PROOF-1" },
		},
		references: [],
	};
}

const store = createLocalSqliteTestStore({ filePath });
await seed(store);
const reserve = createReserveStock({
	store,
	now: () => new Date("2026-09-25T16:01:00.000Z"),
	createReservationId: () => "rsv_proof_hat",
	createReceiptId: () => "rcpt_proof_reserve",
});
const reserved = await reserve(reserveCommand("cmd_proof_reserve", "3"), {
	principal,
});
const conflict = await reserve(reserveCommand("cmd_proof_conflict", "4"), {
	principal,
});
const released = await createReleaseStock({
	store,
	now: () => new Date("2026-09-25T16:02:00.000Z"),
	createReceiptId: () => "rcpt_proof_release",
})(
	{
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_release",
		type: "stock.release",
		context: { siteId: context.siteId, poolId: context.poolId },
		payload: { reservationId: "rsv_proof_hat" },
		references: [],
	},
	{ principal },
);
const read = createReadSkuLocationBalance({ store });
const afterRelease = await read({
	poolId: context.poolId,
	locationId: context.locationId,
	skuId: "sku_hat",
});
await store.close();

const reopened = createLocalSqliteTestStore({ filePath });
const replayed = await createReserveStock({
	store: reopened,
	now: () => new Date("2026-09-25T16:03:00.000Z"),
	createReservationId: () => "must_not_mint",
	createReceiptId: () => "must_not_write",
})(reserveCommand("cmd_proof_reserve", "3"), { principal });
const afterReopen = await createReadSkuLocationBalance({ store: reopened })({
	poolId: context.poolId,
	locationId: context.locationId,
	skuId: "sku_hat",
});
await reopened.close();

console.log(
	JSON.stringify(
		{
			proof: "real-local-sqlite-file",
			created: true,
			closedAndReopened: true,
			reserve: {
				outcome: reserved.outcome,
				reservationId: reserved.reservation?.reservationId,
				status: reserved.reservation?.status,
				quantity: reserved.reservation?.quantity,
			},
			conflict: { outcome: conflict.outcome, code: conflict.code },
			release: {
				outcome: released.outcome,
				status: released.reservation?.status,
			},
			replayedOriginalReserve: {
				outcome: replayed.outcome,
				reservationId: replayed.reservation?.reservationId,
			},
			balanceAfterRelease: afterRelease.balance,
			balanceAfterReopen: afterReopen.balance,
		},
		null,
		2,
	),
);
