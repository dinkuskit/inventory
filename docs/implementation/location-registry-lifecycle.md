# Inventory location registry lifecycle

Status: confirmed architecture contract; implementation follows TDD.

## Boundary

Inventory owns location identity and lifecycle inside one explicit inventory
pool. A future EmDash admin adapter may call this API, but EmDash does not own
location records and this slice adds no GUI, authentication route, deployment,
package publication, or storefront integration.

The slice owns:

- permanent opaque location IDs minted by Inventory;
- unique human-readable names across active and archived locations;
- atomic, awaited, idempotent create, rename, archive, and restore commands;
- immutable actor-bearing receipts stored with terminal command results;
- active and archived list reads; and
- the SQLite test adapter and Cloudflare Durable Object SQLite schema boundary.

The follow-up active-location admission slice now makes opening-balance
execution reject unknown or archived locations inside the stock transaction.
All-locations stock aggregation remains a separate read slice.

## Domain contracts

All four commands use `dinkuskit.inventory.command/v1`, carry a stable
`commandId`, an explicit `siteId` and `poolId`, and execute as an authenticated
`CommandPrincipal`. Rename, archive, and restore also require the permanent
`locationId`; create is the only lifecycle operation without one because
Inventory mints it.

```ts
type LocationStatus = "active" | "archived";

type LocationRecord = Readonly<{
  poolId: string;
  locationId: string;
  name: string;
  nameKey: string;
  status: LocationStatus;
  version: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}>;

type CreateLocationCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "location.create";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: Readonly<{ name: string }>;
  references: readonly ExternalReference[];
}>;

type RenameLocationCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "location.rename";
  context: Readonly<{ siteId: string; poolId: string; locationId: string }>;
  payload: Readonly<{ name: string }>;
  references: readonly ExternalReference[];
}>;

type ArchiveLocationCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "location.archive";
  context: Readonly<{ siteId: string; poolId: string; locationId: string }>;
  payload: Readonly<Record<string, never>>;
  references: readonly ExternalReference[];
}>;

type RestoreLocationCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "location.restore";
  context: Readonly<{ siteId: string; poolId: string; locationId: string }>;
  payload: Readonly<Record<string, never>>;
  references: readonly ExternalReference[];
}>;
```

The normalized display name is trimmed and Unicode NFKC-normalized. Its
uniqueness key is the normalized name lowercased, so `Warehouse`, `warehouse`,
and whitespace-padded variants cannot become separate locations. The database
enforces `UNIQUE (pool_id, name_key)` without excluding archived rows; archive
never releases a name.

Every committed receipt uses `dinkuskit.inventory.receipt/v2` and records the
command identity and digest, type, timestamp, principal snapshot, explicit
site/pool context, references, and immutable before/after location snapshots.
The terminal result uses `dinkuskit.inventory.command-result/v1`.

Stable business rejection codes are:

- `command_id_conflict`;
- `location_name_conflict`;
- `location_not_found`;
- `location_already_archived`;
- `location_not_archived`; and
- `location_not_empty`.

`location_not_empty` includes one blocker per affected SKU with its exact
on-hand and reserved quantities. Archive is admitted only when every balance
row for the location has canonical on-hand value `0` and reserved value `0`.
Positive on-hand, negative on-hand, or any reserved quantity blocks it.

## Application and storage interfaces

```ts
type ExecuteLocationCommand = (
  command: LocationCommandV1,
  execution: Readonly<{ principal: CommandPrincipal }>,
) => Promise<LocationCommandResult>;

type ListLocations = (
  input: Readonly<{ poolId: string; status: LocationStatus }>,
) => Promise<LocationListResult>;

interface InventoryTransaction {
  getCommand(commandId: string): StoredCommandResult | null;
  getLocation(locationId: string): LocationRecord | null;
  getLocationByNameKey(nameKey: string): LocationRecord | null;
  listLocationBalanceBlockers(locationId: string):
    readonly LocationBalanceBlocker[];
  storeRejection(record: StoredCommandResult): void;
  commitLocation(input: LocationCommit): void;
}

interface InventoryStore {
  runTransaction<T>(poolId: string, operation: ...): Promise<T>;
  listLocations(query: Readonly<{
    poolId: string;
    status: LocationStatus;
  }>): Promise<readonly LocationRecord[]>;
}
```

One transaction performs the state admission check, location insert/update,
receipt insert, and terminal-result insert. A matching retry returns the exact
stored terminal result without minting another ID or receipt. Reusing a
`commandId` for changed normalized contents returns `command_id_conflict` and
does not replace the original. Business rejections are themselves durable and
replayable.

Create produces an active version-1 location. Rename preserves identity,
history, and lifecycle status while incrementing the version. Archive requires
an active location and zero blockers, increments the version, and records
`archivedAt`. Restore requires an archived location, increments the version,
clears `archivedAt`, and returns the same permanent ID.

The active list is the source for normal selectors and later zero-stock
breakdowns. The archived list is the recoverable Archive view. Each list is
pool-scoped and deterministically ordered by name key and permanent ID.

## Durable schema

Cloudflare schema version 2 is the first complete real-database schema and
includes `inventory_locations` beside the stock tables. A fresh empty Durable
Object creates the complete schema directly and records only version 2. This
release has no legacy migration: existing older, partial, or unexpected
Inventory schemas fail closed without modification.

The local development/test schema moves to `opening-balance-local/v4` and adds
the same table. It remains explicit-path, non-production, and rejects unrelated
or incompatible SQLite files instead of claiming them.

Location receipts share `inventory_receipts`, and terminal results share
`inventory_command_results`, preserving command-ID uniqueness and atomicity
across stock and location mutations. The existing stock receipt-history query
will explicitly filter `stock.opening_balance`, so lifecycle receipts do not
silently change that already accepted read model. Direct mutation lookup may
return either stock or location command results.

## Blast radius

| Surface | Direct consumers | Risk | Required proof |
| --- | ---: | --- | --- |
| `InventoryStore` / `InventoryTransaction` | 3 application modules, 2 adapters, root type export | Medium | strict typecheck plus all Node and Cloudflare tests |
| shared command/result and receipt tables | opening-balance execution and mutation lookup | High | exact replay, cross-type command conflict, atomic rollback, stock-history regression |
| local SQLite exact schema | local test factory and all Node persistence tests | Medium | create/reopen, incompatible-file fence, dedicated location verifier |
| Cloudflare schema initialization | Durable Object constructor, schema inspection, runtime tests | High | direct fresh v2 initialization, exact idempotency, legacy-shape rejection without writes, pool isolation, Wrangler dry run |
| root platform-neutral exports | package consumers and contract tests | Medium | public API assertions and strict TypeScript check |
| Worker HTTP surface | no change | Low | existing 404 contract test |

No Commerce, Blocks, SmokyClub, EmDash, x-api, shared review-conductor, account,
security, production, or deployment surface is changed.

## TDD and verification plan

The first failing Node tests will prove normalization, globally unique names,
successful lifecycle transitions, durable exact retries, positive/negative/
reserved archive blockers, active/archive reads, and rollback on receipt
failure. Cloudflare tests first fail for the missing v2 schema/table and then
cover lifecycle parity, direct fresh initialization, and rejection of
legacy-shaped storage without modification.

`bin/verify-location-registry` and
`skills/location-registry-verification/SKILL.md` will own the fast deterministic
Node proof. The existing Cloudflare verifier, complete `npm test`, strict
typechecks, Wrangler dry run, ledger validation, and an exact-source review
remain cumulative proof.
