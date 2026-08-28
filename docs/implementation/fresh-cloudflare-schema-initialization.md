# Fresh Cloudflare schema initialization

## Decision

Dinkuskit Inventory is scaffolding its first real Cloudflare database. It has
no live legacy database to upgrade. A brand-new empty Durable Object therefore
initializes directly at the complete current schema, version 2, including the
location registry.

This release provides no version-1-to-version-2 data migration. Any existing,
partial, older, or unexpected Inventory schema fails closed without being
modified.

## Boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| Cloudflare schema initializer | Detecting empty storage, creating the complete current schema atomically, validating exact existing current schema | Guessing legacy location names, backfilling old data, destructive cleanup |
| Durable Object constructor | Blocking object use until initialization or validation succeeds | Migration policy or operator mapping |
| Schema status read | Reporting the exact accepted current schema | Repairing incompatible storage |

No Worker route, authentication, stock command, account configuration,
deployment, or live database mutation is part of this repair.

## State contract

The accepted states are intentionally narrow:

```text
no inventory_* tables
  -> atomically create all current tables
  -> record schema version [2]
  -> validate exact tables and exact version history

exact current tables + version history [2]
  -> validate and return without writes

anything else
  -> throw incompatible-schema error without writes
```

`inventory_schema_migrations` remains the version-history table so later
migrations can be designed when a real predecessor exists. For this first
schema, the only row is version 2; recording a fictional version 1 application
would falsely claim an upgrade that never occurred.

## Interface

The public TypeScript surface does not change:

```ts
function initializeCloudflareInventorySchema(
  storage: DurableObjectStorage,
): void;
```

The function keeps its synchronous, transaction-owned behavior. The change is
its accepted state machine, not a new caller contract.

## Invariants

- Empty means zero tables whose names start with `inventory_`.
- Fresh initialization creates all six expected tables in one
  `transactionSync` callback.
- The exact accepted version history is `[2]`.
- Existing exact version-2 storage is idempotent and receives no writes.
- Existing version-1-shaped storage is rejected and remains version 1-shaped.
- Partial or extra Inventory table sets are rejected and remain unchanged.
- A failed initialization prevents the Durable Object from serving reads or
  mutations.

## Blast radius

| Surface | Callers/consumers | Risk | Required proof |
| --- | --- | --- | --- |
| `initializeCloudflareInventorySchema` | `InventoryPool` constructor and Cloudflare runtime tests | High | fresh init, exact idempotency, legacy-shape rejection, unchanged-state assertion |
| migration history assertion | schema status and runtime inspection | Medium | exact `[2]` history assertion |
| deployment and architecture claims | README, implementation docs, verification skill, GrillTrack proof | Medium | exact-source review and manifest validation |

The SQLite storage adapter, platform-neutral commands, location lifecycle,
receipt shapes, and Worker HTTP surface do not change.

## Zero-implementation review

Checking for existing tables must happen before creating
`inventory_schema_migrations`; otherwise an incompatible database would be
modified before it is rejected. Fresh initialization should use ordinary
`CREATE TABLE` statements, not `IF NOT EXISTS`, because emptiness was already
proven and a collision must roll back the transaction. Exact current storage
is validated without issuing DDL.
