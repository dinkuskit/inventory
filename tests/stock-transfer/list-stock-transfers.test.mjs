import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
	InvalidStockTransferListQueryError,
	STOCK_TRANSFER_LIST_DEFAULT_LIMIT,
	STOCK_TRANSFER_LIST_MAX_LIMIT,
	STOCK_TRANSFER_LIST_RESULT_SCHEMA,
	createReadStockTransferList,
	normalizeReadStockTransferListInput,
} from "../../src/index.ts";
import { createLocalSqliteTestStore } from "../../src/storage/local-sqlite-test-store.ts";

const createdBy = Object.freeze({
	kind: "human",
	id: "emdash_transfer_list_fixture",
	displayName: "Transfer List Fixture",
	surface: "emdash",
});

async function databasePath(t, label) {
	const directory = await mkdtemp(join(tmpdir(), `inventory-transfer-list-${label}-`));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return join(directory, "inventory.sqlite");
}

function location(
	locationId,
	name,
	{ poolId = "pool_alpha", status = "active" } = {},
) {
	return {
		poolId,
		locationId,
		name,
		nameKey: name.toLocaleLowerCase("en-US"),
		status,
		version: "1",
		createdAt: "2026-08-01T08:00:00.000Z",
		updatedAt:
			status === "archived"
				? "2026-08-20T08:00:00.000Z"
				: "2026-08-01T08:00:00.000Z",
		archivedAt:
			status === "archived" ? "2026-08-20T08:00:00.000Z" : null,
	};
}

function transfer(overrides = {}) {
	const status = overrides.status ?? "created";
	const transferId = overrides.transferId ?? "transfer_created";
	return {
		schema: "dinkuskit.inventory.stock-transfer/v1",
		poolId: overrides.poolId ?? "pool_alpha",
		transferId,
		reference: overrides.reference ?? transferId.replace("transfer_", "ST-"),
		status,
		originLocationId: overrides.originLocationId ?? "location_north",
		destinationLocationId:
			overrides.destinationLocationId ?? "location_south",
		lines:
			overrides.lines ?? [
				{ skuId: "sku_hat", quantity: { value: "2", unit: "each" } },
				{ skuId: "sku_shirt", quantity: { value: "1", unit: "each" } },
			],
		note: overrides.note ?? "Detail-only fixture note",
		createdAt: overrides.createdAt ?? "2026-08-25T09:00:00.000Z",
		createdBy,
		updatedAt: overrides.updatedAt ?? "2026-08-25T09:00:00.000Z",
		version: overrides.version ?? "1",
		expectedDispatchDate:
			overrides.expectedDispatchDate ?? "2026-09-01",
		expectedArrivalDate: overrides.expectedArrivalDate ?? "2026-09-03",
		dispatchedDate:
			overrides.dispatchedDate ??
			(status === "in_transit" || status === "received"
				? "2026-09-01T12:00:00.000Z"
				: null),
		receivedDate:
			overrides.receivedDate ??
			(status === "received" ? "2026-09-03T12:00:00.000Z" : null),
		canceledAt:
			overrides.canceledAt ??
			(status === "canceled" ? "2026-09-02T12:00:00.000Z" : null),
	};
}

async function seedDatabase(filePath, { locations, transfers }) {
	const initial = createLocalSqliteTestStore({ filePath });
	await initial.close();
	const database = new DatabaseSync(filePath);
	const insertLocation = database.prepare(
		`INSERT INTO inventory_locations
		 (pool_id, location_id, name, name_key, status, version,
		  created_at, updated_at, archived_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const record of locations) {
		insertLocation.run(
			record.poolId,
			record.locationId,
			record.name,
			record.nameKey,
			record.status,
			record.version,
			record.createdAt,
			record.updatedAt,
			record.archivedAt,
		);
	}
	const insertTransfer = database.prepare(
		`INSERT INTO inventory_transfers
		 (pool_id, transfer_id, reference_key, status, version, transfer_json)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	for (const record of transfers) {
		insertTransfer.run(
			record.poolId,
			record.transferId,
			record.reference.toLocaleLowerCase("en-US"),
			record.status,
			record.version,
			JSON.stringify(record),
		);
	}
	database.close();
}

function activeLocations(poolId = "pool_alpha") {
	return [
		location("location_north", "North", { poolId }),
		location("location_south", "South", { poolId }),
		location("location_east", "East", { poolId }),
	];
}

test("normalizes one exact list query and enforces the bounded opaque contract", async () => {
	assert.equal(STOCK_TRANSFER_LIST_RESULT_SCHEMA, "dinkuskit.inventory.stock-transfer-list-result/v1");
	assert.equal(STOCK_TRANSFER_LIST_DEFAULT_LIMIT, 50);
	assert.equal(STOCK_TRANSFER_LIST_MAX_LIMIT, 100);
	assert.deepEqual(
		normalizeReadStockTransferListInput({
			poolId: "  pool_alpha  ",
			view: "open",
			scope: { kind: "location", locationId: " location_north " },
		}),
		{
			poolId: "pool_alpha",
			view: "open",
			scope: { kind: "location", locationId: "location_north" },
			limit: 50,
		},
	);

	const queries = [];
	const read = createReadStockTransferList({
		store: {
			async listStockTransfers(query) {
				queries.push(query);
				return { selectedLocation: null, rows: [] };
			},
		},
	});
	assert.deepEqual(
		await read({
			poolId: "pool_alpha",
			view: "done",
			scope: { kind: "all_locations" },
			limit: 100,
		}),
		{
			schema: STOCK_TRANSFER_LIST_RESULT_SCHEMA,
			outcome: "listed",
			poolId: "pool_alpha",
			view: "done",
			scope: { kind: "all_locations" },
			transfers: [],
			next: null,
		},
	);
	assert.deepEqual(queries, [{
		poolId: "pool_alpha",
		view: "done",
		limit: 101,
	}]);

	for (const input of [
		null,
		{},
		{ poolId: "pool_alpha", view: "open", scope: { kind: "all_locations" }, extra: true },
		{ poolId: "pool_alpha", view: "both", scope: { kind: "all_locations" } },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "location" } },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "location", locationId: "north", extra: true } },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "all_locations", locationId: "north" } },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "all_locations" }, limit: 0 },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "all_locations" }, limit: 101 },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "all_locations" }, limit: 1.5 },
		{ poolId: "pool_alpha", view: "open", scope: { kind: "all_locations" }, cursor: "not a cursor" },
	]) {
		await assert.rejects(
			() => read(input),
			(error) => error instanceof InvalidStockTransferListQueryError,
		);
	}
	assert.equal(queries.length, 1);
});

test("lists compact Open and Done rows by selected location and active endpoint", async (t) => {
	const filePath = await databasePath(t, "scope-order");
	const locations = [
		...activeLocations(),
		location("location_archive", "Archived origin", { status: "archived" }),
		location("location_hidden", "Archived destination", { status: "archived" }),
	];
	const transfers = [
		transfer({
			transferId: "transfer_open_a",
			status: "created",
			updatedAt: "2026-08-26T10:00:00.000Z",
			expectedDispatchDate: "2026-09-01",
		}),
		transfer({
			transferId: "transfer_open_z",
			status: "in_transit",
			originLocationId: "location_east",
			destinationLocationId: "location_north",
			updatedAt: "2026-08-26T11:00:00.000Z",
			expectedArrivalDate: "2026-09-01",
		}),
		transfer({
			transferId: "transfer_unrelated",
			status: "created",
			originLocationId: "location_south",
			destinationLocationId: "location_east",
			expectedDispatchDate: "2026-09-02",
		}),
		transfer({
			transferId: "transfer_received_archived",
			status: "received",
			originLocationId: "location_archive",
			destinationLocationId: "location_north",
			updatedAt: "2026-09-05T12:00:00.000Z",
			dispatchedDate: "2026-09-03T12:00:00.000Z",
			receivedDate: "2026-09-05T12:00:00.000Z",
		}),
		transfer({
			transferId: "transfer_canceled",
			status: "canceled",
			originLocationId: "location_north",
			destinationLocationId: "location_south",
			updatedAt: "2026-09-04T12:00:00.000Z",
			canceledAt: "2026-09-04T12:00:00.000Z",
		}),
		transfer({
			transferId: "transfer_both_archived",
			status: "canceled",
			originLocationId: "location_archive",
			destinationLocationId: "location_hidden",
			updatedAt: "2026-09-06T12:00:00.000Z",
			canceledAt: "2026-09-06T12:00:00.000Z",
		}),
	];
	await seedDatabase(filePath, { locations, transfers });
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const read = createReadStockTransferList({ store });

	const open = await read({
		poolId: "pool_alpha",
		view: "open",
		scope: { kind: "location", locationId: "location_north" },
	});
	assert.equal(open.outcome, "listed");
	assert.deepEqual(open.transfers.map(({ transferId }) => transferId), [
		"transfer_open_z",
		"transfer_open_a",
	]);
	assert.deepEqual(open.transfers[0], {
		transferId: "transfer_open_z",
		reference: "ST-open_z",
		status: "in_transit",
		origin: { locationId: "location_east", name: "East", status: "active" },
		destination: { locationId: "location_north", name: "North", status: "active" },
		productLineCount: 2,
		createdAt: "2026-08-25T09:00:00.000Z",
		expectedDispatchDate: "2026-09-01",
		expectedArrivalDate: "2026-09-01",
	});
	for (const hidden of ["lines", "note", "createdBy", "version", "receipts", "warnings"]) {
		assert.equal(hidden in open.transfers[0], false);
	}
	const allOpen = await read({
		poolId: "pool_alpha",
		view: "open",
		scope: { kind: "all_locations" },
	});
	assert.deepEqual(allOpen.transfers.map(({ transferId }) => transferId), [
		"transfer_open_z",
		"transfer_open_a",
		"transfer_unrelated",
	]);
	assert.equal(
		new Set(allOpen.transfers.map(({ transferId }) => transferId)).size,
		allOpen.transfers.length,
	);

	const done = await read({
		poolId: "pool_alpha",
		view: "done",
		scope: { kind: "all_locations" },
	});
	assert.equal(done.outcome, "listed");
	assert.deepEqual(done.transfers.map(({ transferId }) => transferId), [
		"transfer_received_archived",
		"transfer_canceled",
	]);
	assert.deepEqual(done.transfers[0], {
		transferId: "transfer_received_archived",
		reference: "ST-received_archived",
		status: "received",
		origin: {
			locationId: "location_archive",
			name: "Archived origin",
			status: "archived",
		},
		destination: {
			locationId: "location_north",
			name: "North",
			status: "active",
		},
		productLineCount: 2,
		dispatchedDate: "2026-09-03T12:00:00.000Z",
		receivedDate: "2026-09-05T12:00:00.000Z",
	});
	assert.equal(done.next, null);
	const northDone = await read({
		poolId: "pool_alpha",
		view: "done",
		scope: { kind: "location", locationId: "location_north" },
	});
	assert.deepEqual(northDone.transfers.map(({ transferId }) => transferId), [
		"transfer_received_archived",
		"transfer_canceled",
	]);
	assert.equal(northDone.transfers[0].origin.status, "archived");

	assert.deepEqual(
		await read({
			poolId: "pool_alpha",
			view: "open",
			scope: { kind: "location", locationId: "location_missing" },
		}),
		{
			schema: STOCK_TRANSFER_LIST_RESULT_SCHEMA,
			outcome: "location_not_found",
			poolId: "pool_alpha",
			view: "open",
			scope: { kind: "location", locationId: "location_missing" },
		},
	);
	assert.deepEqual(
		await read({
			poolId: "pool_alpha",
			view: "done",
			scope: { kind: "location", locationId: "location_archive" },
		}),
		{
			schema: STOCK_TRANSFER_LIST_RESULT_SCHEMA,
			outcome: "location_not_active",
			poolId: "pool_alpha",
			view: "done",
			scope: { kind: "location", locationId: "location_archive" },
		},
	);
});

test("paginates equal dates without repeats, binds cursors, isolates pools, and reopens durably", async (t) => {
	const filePath = await databasePath(t, "pagination");
	const locations = [
		...activeLocations("pool_alpha"),
		...activeLocations("pool_beta"),
	];
	const transfers = [
		...[
			"transfer_equal_a",
			"transfer_equal_b",
			"transfer_equal_c",
		].map((transferId) => transfer({
			transferId,
			status: "created",
			updatedAt: "2026-08-28T10:00:00.000Z",
			expectedDispatchDate: "2026-09-01",
		})),
		transfer({
			poolId: "pool_beta",
			transferId: "transfer_other_pool",
			status: "created",
			expectedDispatchDate: "2026-08-31",
		}),
		transfer({
			transferId: "transfer_done_z",
			status: "received",
			receivedDate: "2026-09-05T12:00:00.000Z",
			updatedAt: "2026-09-05T11:00:00.000Z",
		}),
		transfer({
			transferId: "transfer_done_a",
			status: "received",
			receivedDate: "2026-09-05T12:00:00.000Z",
			updatedAt: "2026-09-05T10:00:00.000Z",
		}),
		transfer({
			transferId: "transfer_done_tie_a",
			status: "canceled",
			canceledAt: "2026-09-04T12:00:00.000Z",
			updatedAt: "2026-09-04T10:00:00.000Z",
		}),
		transfer({
			transferId: "transfer_done_tie_b",
			status: "canceled",
			canceledAt: "2026-09-04T12:00:00.000Z",
			updatedAt: "2026-09-04T10:00:00.000Z",
		}),
	];
	await seedDatabase(filePath, { locations, transfers });
	let store = createLocalSqliteTestStore({ filePath });
	let read = createReadStockTransferList({ store });
	const query = {
		poolId: "pool_alpha",
		view: "open",
		scope: { kind: "all_locations" },
		limit: 2,
	};
	const first = await read(query);
	assert.equal(first.outcome, "listed");
	assert.deepEqual(first.transfers.map(({ transferId }) => transferId), [
		"transfer_equal_a",
		"transfer_equal_b",
	]);
	assert.equal(typeof first.next, "string");
	assert.equal(first.next.includes("transfer_equal_b"), false);

	const second = await read({ ...query, cursor: first.next });
	assert.equal(second.outcome, "listed");
	assert.deepEqual(second.transfers.map(({ transferId }) => transferId), [
		"transfer_equal_c",
	]);
	assert.equal(second.next, null);

	let doneCursor;
	const doneIds = [];
	for (let page = 0; page < 4; page += 1) {
		const result = await read({
			poolId: "pool_alpha",
			view: "done",
			scope: { kind: "all_locations" },
			limit: 1,
			...(doneCursor === undefined ? {} : { cursor: doneCursor }),
		});
		assert.equal(result.outcome, "listed");
		doneIds.push(result.transfers[0].transferId);
		doneCursor = result.next ?? undefined;
	}
	assert.deepEqual(doneIds, [
		"transfer_done_z",
		"transfer_done_a",
		"transfer_done_tie_a",
		"transfer_done_tie_b",
	]);
	assert.equal(doneCursor, undefined);

	for (const changed of [
		{ ...query, poolId: "pool_beta", cursor: first.next },
		{ ...query, view: "done", cursor: first.next },
		{
			...query,
			scope: { kind: "location", locationId: "location_north" },
			cursor: first.next,
		},
	]) {
		await assert.rejects(
			() => read(changed),
			(error) => error instanceof InvalidStockTransferListQueryError,
		);
	}

	await store.close();
	store = createLocalSqliteTestStore({ filePath });
	read = createReadStockTransferList({ store });
	const afterReopen = await read({ ...query, cursor: first.next, limit: 1 });
	assert.deepEqual(afterReopen.transfers.map(({ transferId }) => transferId), [
		"transfer_equal_c",
	]);
	assert.equal(afterReopen.next, null);
	await store.close();
});

test("enforces the default and maximum page sizes against durable rows", async (t) => {
	const filePath = await databasePath(t, "page-boundaries");
	const transfers = Array.from({ length: 101 }, (_, index) => transfer({
		transferId: `transfer_boundary_${String(index).padStart(3, "0")}`,
		status: "created",
		updatedAt: "2026-08-28T10:00:00.000Z",
		expectedDispatchDate: "2026-09-01",
	}));
	await seedDatabase(filePath, {
		locations: activeLocations(),
		transfers,
	});
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const read = createReadStockTransferList({ store });
	const base = {
		poolId: "pool_alpha",
		view: "open",
		scope: { kind: "all_locations" },
	};
	const defaultPage = await read(base);
	assert.equal(defaultPage.transfers.length, 50);
	assert.equal(typeof defaultPage.next, "string");
	const maximumPage = await read({ ...base, limit: 100 });
	assert.equal(maximumPage.transfers.length, 100);
	assert.equal(typeof maximumPage.next, "string");
	const finalPage = await read({
		...base,
		limit: 100,
		cursor: maximumPage.next,
	});
	assert.deepEqual(finalPage.transfers.map(({ transferId }) => transferId), [
		"transfer_boundary_100",
	]);
	assert.equal(finalPage.next, null);
});

test("fails closed on status drift, impossible lifecycle dates, and paged terminal corruption", async (t) => {
	const filePath = await databasePath(t, "corruption");
	const nullPoolTransfers = [
		transfer({
			poolId: "pool_null",
			transferId: "transfer_valid_3",
			status: "received",
			receivedDate: "2026-09-03T12:00:00.000Z",
			updatedAt: "2026-09-03T12:00:00.000Z",
		}),
		transfer({
			poolId: "pool_null",
			transferId: "transfer_valid_2",
			status: "received",
			receivedDate: "2026-09-02T12:00:00.000Z",
			updatedAt: "2026-09-02T12:00:00.000Z",
		}),
		transfer({
			poolId: "pool_null",
			transferId: "transfer_valid_1",
			status: "received",
			receivedDate: "2026-09-01T12:00:00.000Z",
			updatedAt: "2026-09-01T12:00:00.000Z",
		}),
	];
	const corruptTerminal = {
		...transfer({
			poolId: "pool_null",
			transferId: "transfer_corrupt_terminal",
			status: "received",
		}),
		receivedDate: null,
	};
	const statusDrift = transfer({
		poolId: "pool_status",
		transferId: "transfer_status_drift",
		status: "in_transit",
	});
	const impossibleCreated = {
		...transfer({
			poolId: "pool_lifecycle",
			transferId: "transfer_impossible_created",
			status: "created",
		}),
		dispatchedDate: "2026-09-01T12:00:00.000Z",
	};
	await seedDatabase(filePath, {
		locations: [
			...activeLocations("pool_null"),
			...activeLocations("pool_status"),
			...activeLocations("pool_lifecycle"),
		],
		transfers: [
			...nullPoolTransfers,
			corruptTerminal,
			statusDrift,
			impossibleCreated,
		],
	});
	const database = new DatabaseSync(filePath);
	database.prepare(
		`UPDATE inventory_transfers
		 SET status = 'created'
		 WHERE pool_id = 'pool_status' AND transfer_id = 'transfer_status_drift'`,
	).run();
	database.close();
	const store = createLocalSqliteTestStore({ filePath });
	t.after(() => store.close());
	const read = createReadStockTransferList({ store });

	await assert.rejects(
		() => read({
			poolId: "pool_status",
			view: "open",
			scope: { kind: "all_locations" },
		}),
		/transfer status is inconsistent/u,
	);
	await assert.rejects(
		() => read({
			poolId: "pool_lifecycle",
			view: "open",
			scope: { kind: "all_locations" },
		}),
		/Created transfer has impossible lifecycle dates/u,
	);

	const query = {
		poolId: "pool_null",
		view: "done",
		scope: { kind: "all_locations" },
		limit: 1,
	};
	const first = await read(query);
	const second = await read({ ...query, cursor: first.next });
	await assert.rejects(
		() => read({ ...query, cursor: second.next }),
		/position is invalid/u,
	);
});
