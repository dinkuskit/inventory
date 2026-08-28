# Aggregate stock read

Status: confirmed implementation contract for GrillTrack decisions
`aggregate-stock-view-026`, `aggregate-stock-quantities-027`, and
`zero-stock-location-029`.

## Boundary

This slice owns one platform-neutral, read-only query for a caller-supplied SKU
inside one explicit Inventory pool. It returns either one active location or an
all-active-locations aggregate. It does not discover, register, or synchronize
Commerce products, mutate stock, expose reservation order details, add a GUI,
deploy a Worker, or create production data.

Commerce continues to own products and canonical SKU strings. Inventory owns
the balance rows and location registry that this query reads.

## Public contract

```ts
type SkuStockScope =
	| Readonly<{ kind: "location"; locationId: string }>
	| Readonly<{ kind: "all_locations" }>;

type ReadSkuStockInput = Readonly<{
	poolId: string;
	skuId: string;
	scope: SkuStockScope;
}>;

type StockQuantities = Readonly<{
	onHand: ExactQuantity;
	reserved: ExactQuantity;
	available: ExactQuantity;
}>;

type SkuStockLocation = Readonly<{
	locationId: string;
	name: string;
	stock: StockQuantities;
}>;

type SkuStockReadResult =
	| Readonly<{
			schema: "dinkuskit.inventory.sku-stock-read-result/v1";
			outcome: "found";
			poolId: string;
			skuId: string;
			scope: SkuStockScope;
			stock: StockQuantities;
			locations: readonly SkuStockLocation[];
	  }>
	| Readonly<{
			schema: "dinkuskit.inventory.sku-stock-read-result/v1";
			outcome: "not_found";
			poolId: string;
			skuId: string;
			scope: SkuStockScope;
	  }>;

type ReadSkuActiveLocationSnapshotQuery = Readonly<{
	poolId: string;
	skuId: string;
}>;

type ActiveLocationBalanceSnapshot = Readonly<{
	location: LocationRecord;
	balance: BalanceRecord | null;
}>;

interface InventoryStore {
	readSkuActiveLocationSnapshot(
		query: ReadSkuActiveLocationSnapshotQuery,
	): Promise<readonly ActiveLocationBalanceSnapshot[]>;
}
```

`createReadSkuStock({ store })` normalizes the query and returns the versioned
result. The Cloudflare Durable Object and service entrypoint expose the same
query without adding an HTTP route.

## State and invariants

- The storage adapter reads the active location registry and SKU balances in
  one SQL statement, preventing a mixed location/balance snapshot.
- Archived locations never appear in either scope.
- All-locations output is ordered by the existing location selector order:
  normalized name, then permanent location ID.
- Every active location appears in all-locations output. A missing balance row
  becomes explicit zero only when another active balance establishes the SKU's
  unit.
- Location scope returns one row. An active location with no balance is zero
  when the SKU exists at another active location.
- No active balance for the SKU returns `not_found`; this slice does not invent
  a unit or create a registration record.
- On-hand and reserved are read from canonical balances. Available is always
  derived as exact `onHand - reserved`, never trusted as a separate authority.
- All-locations totals use exact signed-decimal arithmetic, not JavaScript
  floating point.
- Unit mismatch within a balance or across locations is corrupt state and fails
  closed with `InconsistentSkuStockUnitError`.
- The read performs no transaction, command, receipt, or balance mutation.

## Blast radius

Risk: medium. The change adds a public read contract and a method to the shared
storage interface, but does not change existing commands, result schemas,
database tables, or deployment configuration.

Affected production files:

- `src/domain/inventory-read.ts`: additive types, normalization, and errors.
- `src/application/read-inventory.ts`: additive aggregate read application.
- `src/storage/inventory-store.ts`: one additive snapshot method and types.
- `src/storage/local-sqlite-test-store.ts`: local SQLite snapshot query.
- `src/storage/cloudflare-sqlite-inventory-store.ts`: Durable Object SQLite
  snapshot query.
- `src/cloudflare/worker.ts`: additive Durable Object/service methods.
- `src/index.ts`: additive platform-neutral exports only.

Direct consumers of `InventoryStore` are the two repository-owned storage
adapters and the application factories. Existing one-location balance reads,
opening-balance commands, location lifecycle commands, receipts, schema
initialization, and Commerce/SmokyClub code are unchanged.

Required regression proof:

- domain validation and public export tests;
- application behavior for exact location, aggregate totals, zero rows,
  archived exclusion, not-found, signed decimals, and unit mismatch;
- local SQLite close/reopen behavior;
- Cloudflare Durable Object storage and service behavior;
- existing full Node and Cloudflare suites plus Cloudflare typecheck;
- `bin/verify-aggregate-stock-read` and its repository-local verification skill.

Review-grade real behavior proof additionally uses
`bin/prove-aggregate-stock-read-real`. It reads a populated SQLite database only
after closing and reopening its file, then calls the production Inventory
Worker through a separate local Wrangler Worker's private service binding. The
Durable Object state directory is also closed and reopened. This harness is
local-only, disposable, declares `remote: false`, and adds no public Inventory
route or production binding.
