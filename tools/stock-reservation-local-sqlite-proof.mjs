import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
	createPackAllStock,
	createPackSomeStock,
	createReadSkuLocationBalance,
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

async function openSku(store, skuId, quantity, commandId, receiptId) {
	const opening = await createSetOpeningBalance({
		store,
		now: () => new Date("2026-09-25T16:00:00.000Z"),
		createReceiptId: () => receiptId,
	})(
		{
			schema: "dinkuskit.inventory.command/v1",
			commandId,
			type: "stock.opening_balance",
			context,
			payload: { skuId, quantity: { value: quantity, unit: "each" } },
			reason: { code: "opening_balance", note: "Set Initial Stock" },
			references: [],
			expectedVersions: [{ skuId, locationId: context.locationId, version: "0" }],
		},
		{ principal },
	);
	if (opening.outcome !== "committed") {
		throw new Error(`Proof opening failed: ${opening.code}`);
	}
}

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
	await createFixtureManagedSku(store, {
		poolId: context.poolId,
		skuId: "sku_shirt",
		sku: "PROOF-SHIRT",
		displayName: "Proof Shirt",
	});
	await openSku(store, "sku_hat", "10", "cmd_proof_opening_hat", "rcpt_proof_opening_hat");
	await openSku(
		store,
		"sku_shirt",
		"6",
		"cmd_proof_opening_shirt",
		"rcpt_proof_opening_shirt",
	);
}

function reserveCommand(commandId, skuId, quantity, lineId) {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId,
		type: "stock.reserve",
		context,
		payload: {
			skuId,
			quantity: { value: quantity, unit: "each" },
			orderLine: { kind: "commerce.order_line", id: lineId },
		},
		references: [],
	};
}

function packAllCommand() {
	return {
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_pack_all",
		type: "stock.pack_all",
		context: { siteId: context.siteId, poolId: context.poolId },
		payload: { reservationIds: ["rsv_proof_hat", "rsv_proof_shirt"] },
		references: [],
	};
}

async function balances(store) {
	const read = createReadSkuLocationBalance({ store });
	return {
		hat: (
			await read({
				poolId: context.poolId,
				locationId: context.locationId,
				skuId: "sku_hat",
			})
		).balance,
		shirt: (
			await read({
				poolId: context.poolId,
				locationId: context.locationId,
				skuId: "sku_shirt",
			})
		).balance,
	};
}

const store = createLocalSqliteTestStore({ filePath });
await seed(store);
const hat = await createReserveStock({
	store,
	now: () => new Date("2026-09-25T16:01:00.000Z"),
	createReservationId: () => "rsv_proof_hat",
	createReceiptId: () => "rcpt_proof_reserve_hat",
})(reserveCommand("cmd_proof_reserve_hat", "sku_hat", "3", "OL-PROOF-HAT"), {
	principal,
});
const shirt = await createReserveStock({
	store,
	now: () => new Date("2026-09-25T16:01:01.000Z"),
	createReservationId: () => "rsv_proof_shirt",
	createReceiptId: () => "rcpt_proof_reserve_shirt",
})(reserveCommand("cmd_proof_reserve_shirt", "sku_shirt", "2", "OL-PROOF-SHIRT"), {
	principal,
});
const packedSome = await createPackSomeStock({
	store,
	now: () => new Date("2026-09-25T16:04:00.000Z"),
	createReceiptId: () => "rcpt_proof_pack_some_hat",
})(
	{
		schema: "dinkuskit.inventory.command/v1",
		commandId: "cmd_proof_pack_some_hat",
		type: "stock.pack_some",
		context: { siteId: context.siteId, poolId: context.poolId },
		payload: {
			reservationId: "rsv_proof_hat",
			quantity: { value: "1", unit: "each" },
		},
		references: [],
	},
	{ principal },
);
const again = await createReserveStock({
	store,
	now: () => new Date("2026-09-25T16:04:30.000Z"),
	createReservationId: () => "must_not_mint",
	createReceiptId: () => "must_not_write",
})(reserveCommand("cmd_proof_reserve_hat_retry", "sku_hat", "3", "OL-PROOF-HAT"), {
	principal,
});
const packed = await createPackAllStock({
	store,
	now: () => new Date("2026-09-25T16:05:00.000Z"),
	createReceiptId: () => "rcpt_proof_pack_all",
})(packAllCommand(), { principal });
const afterPack = await balances(store);
await store.close();

const reopened = createLocalSqliteTestStore({ filePath });
const replayed = await createPackAllStock({
	store: reopened,
	now: () => new Date("2026-09-25T16:06:00.000Z"),
	createReceiptId: () => "must_not_write",
})(packAllCommand(), { principal });
const afterReopen = await balances(reopened);
await reopened.close();

console.log(
	JSON.stringify(
		{
			proof: "real-local-sqlite-file",
			created: true,
			closedAndReopened: true,
			reserve: { hat: hat.outcome, shirt: shirt.outcome },
			packSome: {
				outcome: packedSome.outcome,
				status: packedSome.reservation?.status,
				remaining: packedSome.reservation?.quantity?.value,
			},
			reReserve: {
				outcome: again.outcome,
				id: again.reservation?.reservationId,
				remaining: again.reservation?.quantity?.value,
			},
			packAll: {
				outcome: packed.outcome,
				ids: packed.reservations?.map((hold) => hold.reservationId),
			},
			replayedOriginalPackAll: {
				outcome: replayed.outcome,
				ids: replayed.reservations?.map((hold) => hold.reservationId),
			},
			balanceAfterPackAll: afterPack,
			balanceAfterReopen: afterReopen,
		},
		null,
		2,
	),
);
