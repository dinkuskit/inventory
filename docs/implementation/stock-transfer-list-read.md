# Stock-transfer list read

Status: confirmed implementation contract for GrillTrack decisions
`transfer-list-view-selection-001` through `transfer-list-pagination-006`.

## Boundary

This slice adds one platform-neutral `createReadStockTransferList` application
surface to `dinkus.stock-transfer`. It reads the existing transfer and location
records without changing a transfer, balance, receipt, command result, or
location.

The caller supplies one explicit pool, one `open` or `done` view, and either one
active location or `all_locations`. This slice adds no Worker route, CLI, Block
Kit GUI, authentication, Commerce/Blocks integration, schema migration,
deployment, or production mutation.

## Public query

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
```

Input is strict. Unknown fields, blank identities, unsupported views or scopes,
non-integer/out-of-range limits, malformed cursors, and cursors from another
pool, view, or scope throw `InvalidStockTransferListQueryError` before reading
storage. Omitted `limit` becomes 50; the maximum is 100.

`createReadStockTransferList({ store })` returns a successful `listed` result
with normalized pool, view, scope, compact `transfers`, and `next`, which is an
opaque cursor or `null`. A selected unknown location returns
`location_not_found`; a selected archived location returns
`location_not_active`. Neither failure silently falls back to All Locations.

## Compact rows

Every row exposes only:

- permanent transfer ID and editable display reference;
- current lifecycle status;
- current origin and destination location IDs, names, and active/archived
  status;
- distinct product-line count; and
- dates relevant to the selected lifecycle state.

Created and In-transit rows expose `createdAt`, `expectedDispatchDate`, and
`expectedArrivalDate`. Received rows expose `dispatchedDate` and
`receivedDate`. Canceled rows expose `createdAt` and `canceledAt`.

Line identities and quantities, note/reason, warnings, version, actors,
receipts, and audit bodies remain available only through detail or audit
surfaces. Endpoint names and archive status are current location-registry
facts; permanent IDs remain authoritative.

## Membership and archive behavior

- Open includes only `created` and `in_transit`.
- Done includes only `received` and `canceled`.
- One-location scope matches either endpoint, so it includes incoming and
  outgoing transfers once and excludes unrelated transfers.
- All Locations includes a transfer once when at least one endpoint is active.
- If one endpoint is archived, the transfer remains visible through the active
  endpoint and the archived endpoint is labeled.
- If both endpoints are archived, the transfer is excluded from the normal All
  Locations list and reserved for a later archive surface.

Missing endpoint records or impossible lifecycle/date combinations are corrupt
durable state and fail closed rather than producing a partial row.

## Ordering and pagination

Open rows sort by next operational date ascending: Created uses expected
dispatch and In-transit uses expected arrival. Done rows sort by terminal date
descending: Received uses received time and Canceled uses canceled time. Both
orders then use `updatedAt` descending and permanent `transferId` ascending.

Adapters fetch requested `limit + 1`. When another row exists, the application
returns an opaque, versioned base64url keyset cursor derived from the last
returned row. The cursor binds the pool, view, scope, effective sort date,
`updatedAt`, and transfer ID. Changing page size between requests is valid;
reusing the cursor for another query is not. There is no offset, exact total
count, search, or custom sort.

Keyset paging prevents ordinary offset drift and gives deterministic
continuation for unchanged records. It is not a snapshot transaction across
requests; a concurrent edit or lifecycle transition can move an Open row.

## Storage and schema

`InventoryStore.listStockTransfers` is an additive read port implemented by the
local SQLite test adapter and the Cloudflare SQLite adapter. Each implementation
filters by the materialized pool and status, reads lifecycle/order fields from
the stored transfer JSON, joins both location records, applies the location or
active-endpoint predicate, and performs the same keyset comparison.

No schema or index change is required. Schema v4 already stores the pool,
materialized status, full transfer record, and permanent location records.
Future endpoint/date materialization or indexing requires measured need and a
separate migration slice.

## Verification

`bin/verify-stock-transfer` proves strict normalization and exports, Open/Done
membership, incoming/outgoing location scope, unique All Locations results,
archive visibility/exclusion, compact row shape, lifecycle ordering, bounded
opaque pagination, query-bound cursor rejection, pool isolation, local
close/reopen behavior, Cloudflare adapter parity, unchanged singular detail
read and transfer mutations, and unchanged schema-v4 migration identity.

Before review or delivery, run `bin/verify-inventory full` as the canonical
repository gate.
