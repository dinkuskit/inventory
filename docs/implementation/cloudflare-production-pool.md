# Production Cloudflare inventory pool

Status: confirmed implementation contract for GrillTrack decision
`cloudflare-pool-023`.

## Outcome

Dinkuskit Inventory deploys one generic Cloudflare Worker that owns a
SQLite-backed Durable Object namespace. One Durable Object instance is selected
from one explicit physical-pool ID, so every pool receives one private,
strongly consistent SQLite database and one serialization boundary.

This slice provisions the production-intended Worker and namespace and
initializes the future live pool through a read-only same-account probe. It does
not bind storefront traffic or set stock. The probe uses a current live
SmokyClub hat SKU supplied only at runtime and must return explicit
`not_found`; a human physical count remains required before an opening-balance
command may exist.

Tenant SKU, site, pool, location, Cloudflare account, and deployment identifiers
are runtime/proof data. They are not committed to this public repository.

## Boundaries

| Module | Owns | Does not own |
| --- | --- | --- |
| `src/storage/cloudflare-sqlite-inventory-store.ts` | Production `InventoryStore` implementation over one Durable Object's SQLite storage | Object routing, HTTP, tenant defaults, authentication |
| `src/cloudflare/schema.ts` | Monotonic per-object SQL schema migrations and schema status | Cloudflare namespace lifecycle or application commands |
| `src/cloudflare/worker.ts` | Pool-to-object routing and read-only same-account RPC | Public inventory API, storefront binding, auth sessions, opening-balance exposure |
| `wrangler.jsonc` | Generic Worker, Durable Object binding, SQLite class export, no-public-route posture | Account ID, tenant route, secrets, SKU/pool/location values |
| `tools/cloudflare-remote-probe.ts` | Local-only adapter from a loopback request to the deployed same-account service binding | Deployment, credentials, persisted defaults, stock writes |
| `wrangler.probe.jsonc` | Local development configuration for a remote service binding | A deployable production surface |

The platform-neutral root API remains free of Cloudflare runtime imports. The
Cloudflare adapter is a deployment entrypoint, not a replacement command
engine. Existing application functions continue to own validation,
idempotency, receipts, and business outcomes.

## Runtime contracts

```ts
type CloudflareInventorySchemaStatus = Readonly<{
  schema: "dinkuskit.inventory.cloudflare-schema-status/v1";
  version: 1;
  tables: readonly string[];
}>;

type CloudflareInventoryRecordCounts = Readonly<{
  balances: number;
  commandResults: number;
  confirmations: number;
  receipts: number;
}>;

class InventoryPool extends DurableObject<InventoryWorkerEnv> {
  schemaStatus(): Promise<CloudflareInventorySchemaStatus>;
  recordCounts(): Promise<CloudflareInventoryRecordCounts>;
  readSkuLocationBalance(
    input: ReadSkuLocationBalanceInput,
  ): Promise<SkuLocationBalanceReadResult>;
}

class InventoryService extends WorkerEntrypoint<InventoryWorkerEnv> {
  inspectSkuLocation(
    input: ReadSkuLocationBalanceInput,
  ): Promise<Readonly<{
    schema: CloudflareInventorySchemaStatus;
    balance: SkuLocationBalanceReadResult;
    recordCounts: CloudflareInventoryRecordCounts;
  }>>;
}
```

`InventoryService.inspectSkuLocation` normalizes the complete explicit key,
selects the Durable Object by normalized `poolId`, then obtains schema and
balance status and read-only business-table counts from that object. The counts
prove that the initialization probe did not create a balance, command,
confirmation, or receipt. It is callable through a same-account service binding.
The Worker has `workers_dev: false`, preview URLs disabled, and no route, so the
method is not an unauthenticated public API.

The default `fetch` handler returns `404` as defense in depth if a route is
added accidentally in a later change.

## Database schema and transactions

The object constructor runs schema initialization under
`blockConcurrencyWhile`. A dedicated `inventory_schema_migrations` table
records applied monotonic integer versions because Durable Object SQLite does
not support `PRAGMA user_version`.

Schema version 2 is the first complete real-database schema and owns exactly:

- `inventory_schema_migrations`;
- `inventory_command_results`;
- `inventory_balances`;
- `inventory_locations`;
- `inventory_receipts`; and
- `inventory_opening_balance_confirmations`.

The business tables preserve the verified local-test shape, but there is no
test-role marker and no compatibility with disposable local database files.
Fresh schema creation executes inside `DurableObjectStorage.transactionSync`
and records only version 2. No live predecessor exists, so this release does
not implement a version-1 upgrade. Any older, partial, or unexpected Inventory
schema is rejected without modification. Future migrations remain a separate
design once a real predecessor exists.

`CloudflareSqliteInventoryStore.runTransaction` also uses
`transactionSync`. The callback must remain synchronous, matching the existing
storage port. A thrown exception rolls back the command result, balance,
receipt, and confirmation binding together. SQL cursors are fully consumed
before any `await`.

The adapter implements every current `InventoryStore` method even though this
slice exposes only read-only RPC. That lets repository tests execute the same
opening-balance and exact-retry application code against the production
storage boundary without making mutation remotely callable.

## Deployment contract

The committed Wrangler configuration is generic and contains no account ID,
route, secret, tenant, pool, location, or SKU. It declares:

- Worker name `dinkuskit-inventory`;
- compatibility date `2026-08-28`;
- the `INVENTORY_POOLS` binding;
- `InventoryPool` as a Durable Object export with `storage: "sqlite"`;
- `workers_dev: false`; and
- `preview_urls: false`.

Cloudflare creates the namespace when the Worker is deployed. It creates a
specific object's private database lazily when the same-account probe first
calls that explicit pool.

The probe Worker is never deployed. Local Wrangler connects its service binding
to the deployed `dinkuskit-inventory` Worker, forwards one explicit read-only
inspection, and then exits. The live SKU and pool/location identities appear
only in the operator-owned remote proof.

## Blast radius

Baseline: `git:08a4fef09dfdb33091d444fe03bb53f1aeba754d`.

- Runtime consumers outside Inventory: none.
- Production Inventory deployment surfaces before this slice: none.
- Store port consumers: opening-balance application code, read application
  code, local test adapter, and tests.
- New external state: one generic Cloudflare Worker and one SQLite Durable
  Object namespace; one explicitly selected pool object is initialized by the
  approved read-only probe.
- Unchanged systems: SmokyClub source and traffic, EmDash, Commerce, Blocks,
  SmokyClub, x-api, and shared review-conductor code.

Risk is high at the deployment/config boundary and medium in the SQL adapter.
Mitigations are no public route, no mutation RPC, no committed tenant/account
configuration, exact schema tracking, exact transaction conformance tests,
an explicit remote `not_found` expectation, and no stock value before a
physical count.

## Verification

Strict TDD must prove:

1. Wrangler declares a SQLite Durable Object export and contains no route,
   account ID, tenant value, or public development URL.
2. A fresh object initializes the complete schema version 2 exactly once and
   records no fictional predecessor version.
3. An explicit SKU-location read returns `not_found` without creating a
   balance, command, receipt, or confirmation.
4. Separate pool object names do not share database state.
5. Existing opening-balance application code commits and replays through the
   Cloudflare store adapter.
6. Receipt failure rolls back balance and command state through
   `transactionSync`.
7. The full existing Node suite remains green.
8. `wrangler deploy --dry-run` validates the exact source/config before live
   deployment.
9. Any later approved deployment proof must use a new empty pool and show
   schema version 2 plus `not_found`; the earlier version-1 probe object is not
   a live database or migration input.

The remote proof must also show that no balance, command, or receipt was
created and that no route or SmokyClub binding was deployed.
