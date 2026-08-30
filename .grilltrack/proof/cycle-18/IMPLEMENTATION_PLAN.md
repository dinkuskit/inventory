# Stock-transfer list read-model implementation plan

## Scope

Implement the confirmed platform-neutral stock-transfer list query only. A
caller selects exactly one `open` or `done` view and either one active location
or `all_locations`. The result is a compact, stably paginated list suitable for
the later Inventory GUI. It does not expose a CLI, Worker route, authentication,
or any mutation.

Baseline: `ff6dd9de3841dd95965849c1b0221b1551929656`.

## Module boundaries

- `src/features/stock-transfer/domain.ts` owns the public list schema, view,
  scope, compact row/result types, strict query normalization, bounds, and the
  opaque cursor contract.
- `src/features/stock-transfer/read.ts` owns the list application service,
  view/status mapping, row projection, `limit + 1` page construction, and next
  cursor generation. The existing singular transfer read remains unchanged.
- `src/storage/inventory-store.ts` owns the platform-neutral list query/page
  port and stable storage position.
- `src/storage/local-sqlite-test-store.ts` and
  `src/storage/cloudflare-sqlite-inventory-store.ts` implement identical
  filtering, endpoint enrichment, ordering, and keyset predicates.
- `src/features/stock-transfer/index.ts` is the feature export barrier and
  `src/index.ts` is the package composition root.
- No Worker route, CLI, GUI, auth, Commerce, Blocks, SmokyClub, EmDash, shared
  conductor, deployed database, or production surface is in scope.

## Public interface

```ts
const STOCK_TRANSFER_LIST_RESULT_SCHEMA =
  "dinkuskit.inventory.stock-transfer-list-result/v1";
const STOCK_TRANSFER_LIST_DEFAULT_LIMIT = 50;
const STOCK_TRANSFER_LIST_MAX_LIMIT = 100;

type StockTransferListView = "open" | "done";
type StockTransferListScope =
  | Readonly<{ kind: "location"; locationId: string }>
  | Readonly<{ kind: "all_locations" }>;

type ReadStockTransferListInput = Readonly<{
  poolId: string;
  view: StockTransferListView;
  scope: StockTransferListScope;
  limit?: number;
  cursor?: string;
}>;

type ReadStockTransferList = (
  input: ReadStockTransferListInput,
) => Promise<StockTransferListResult>;

createReadStockTransferList({ store }): ReadStockTransferList;
```

Successful results use `outcome: "listed"`, contain the normalized pool, view,
and scope, return compact `transfers`, and expose `next: string | null`.
Location-scoped queries return typed `location_not_found` or
`location_not_active` outcomes when the selected location cannot be used.
Invalid structure, limits, or cursors throw
`InvalidStockTransferListQueryError` before storage is queried.

Each compact row contains:

- permanent transfer ID and editable display reference;
- current status;
- current origin/destination IDs, names, and active/archived status;
- distinct product-line count;
- Created/In-transit planning dates or Received/Canceled terminal dates as
  locked by the grill.

Lines, quantities, note/reason, warnings, actors, receipts, and audit bodies
remain detail-only.

## Storage interface

```ts
type StockTransferListPosition = Readonly<{
  sortDate: string;
  updatedAt: string;
  transferId: string;
}>;

type ListStockTransfersQuery = Readonly<{
  poolId: string;
  view: StockTransferListView;
  locationId?: string;
  limit: number;
  after?: StockTransferListPosition;
}>;

type StoredStockTransferListRow = Readonly<{
  transfer: StockTransferRecord;
  origin: LocationRecord;
  destination: LocationRecord;
  position: StockTransferListPosition;
}>;

type StoredStockTransferListPage = Readonly<{
  selectedLocation: LocationRecord | null;
  rows: readonly StoredStockTransferListRow[];
}>;
```

`InventoryStore.listStockTransfers(query)` supplies this page. Endpoint names
and statuses are current location-registry facts; IDs remain permanent. Missing
endpoint records and impossible status/date combinations are corrupt durable
state and fail closed.

## Filtering and ordering

- Open contains only `created` and `in_transit`.
- Done contains only `received` and `canceled`.
- One-location scope matches either endpoint and returns incoming and outgoing
  transfers exactly once; unrelated transfers are excluded.
- All Locations includes a transfer once when at least one endpoint is active.
  Transfers whose two endpoints are archived are deferred to a later archive
  area.
- Open uses expected dispatch for Created and expected arrival for In-transit,
  ordered ascending with overdue/earliest work first, then `updatedAt`
  descending, then `transferId` ascending.
- Done uses received or canceled time, ordered descending, then `updatedAt`
  descending, then `transferId` ascending.

The store reads `requested limit + 1`. A versioned base64url JSON cursor binds
the normalized pool, view, scope, last effective sort date, `updatedAt`, and
transfer ID. A cursor from another query is rejected. Page size may change
between requests. Paging is deterministic absent a concurrent edit that moves
an existing Open transfer to a different ordering position; snapshot isolation
across requests is outside this slice.

## Durable data flow

1. Strictly normalize pool, selected view, scope, optional limit, and cursor.
2. Decode and validate the opaque cursor and bind it to that exact query.
3. For location scope, require the selected location to exist in the pool and
   remain active.
4. Query the materialized transfer status and JSON lifecycle facts, joining
   both endpoint records from the location registry.
5. Apply the view, location/activity, and keyset predicates in storage, with
   one row per transfer.
6. Validate stored transfer and endpoint facts through existing durable record
   readers, project compact rows, retain at most the requested limit, and emit
   `next` from the last returned position only when an extra row exists.

## Schema decision

No migration or index is introduced. Cloudflare schema v4 and the local test
schema already persist pool, materialized status, complete transfer JSON, and
location identities/status. Pool-keyed primary access bounds the query. A
future measured scale slice may materialize endpoint/date columns and add
indexes; that is not needed to prove V1 correctness.

## Implementation and TDD sequence

1. Add a focused Node test and public-entry assertions, then capture their
   failure on missing list exports before production edits.
2. Implement the domain/query/store port and local SQLite adapter minimally to
   make focused Node tests pass.
3. Add Cloudflare adapter parity tests, observe their failure, then implement
   the matching Durable Object storage query.
4. Update architecture ownership, feature-map, docs, and the existing
   stock-transfer verification skill without adding another verifier.
5. Run `bin/verify-stock-transfer`, adjacent location-registry proof,
   `bin/verify-inventory quick`, and `bin/verify-inventory full`.
6. Inspect exact source identity, diff, architecture boundaries, and proof
   artifacts before proposing any commit or remote action.

## Required verification

- strict input/default/max/cursor contract;
- Open and Done membership plus all tie-breaker ordering;
- incoming/outgoing location scope and no duplicate All Locations rows;
- current archived-endpoint metadata and both-archived exclusion;
- compact shape with no line/audit leakage;
- unknown/archived selected-location outcomes;
- keyset continuation without repeat or skip;
- pool isolation and local close/reopen durability;
- Cloudflare SQLite parity with unchanged schema version 4;
- existing singular read and every transfer mutation regression;
- public export, feature barrier, TypeScript, quick, and full repository gates.
