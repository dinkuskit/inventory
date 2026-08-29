# Cloudflare schema v3 initialization and v2 upgrade

## Decision

A brand-new empty Durable Object initializes directly at complete schema v3 and
records history `[3]`. The committed v2 schema is a supported predecessor:
exact v2 storage with history `[2]` upgrades atomically, preserves every durable
record, backfills its legacy balanced SKU identities, and records `[2, 3]`.

Version 1, partial, conflicting-unit, extra-table, or otherwise incompatible
storage fails closed without a partial migration. No live database, deployment,
or production mutation is part of this source repair.

## State contract

```text
no inventory_* tables
  -> create complete v3 atomically
  -> history [3]

exact six-table v2 + history [2]
  -> validate every legacy balance unit
  -> create inventory_skus
  -> backfill stable legacy identities
  -> preserve all six predecessor tables and rows
  -> append version 3
  -> validate complete v3 + history [2, 3]

exact seven-table v3 + history [3] or [2, 3]
  -> validate and return without writes

anything else
  -> throw and leave storage unchanged
```

## Legacy identity policy

Version 2 stored only the opaque stock key in `inventory_balances.sku_id`. For
every distinct `(pool_id, sku_id)`, migration creates one v3 managed record with
the same value as `inventory_sku_id`. That preserves existing callers, balances,
receipts, and history. Because v2 had no visible SKU or display name, both use
the legacy key as a temporary fallback. The registration actor is the immutable
system principal `inventory_schema_migration_v3`.

Migration accepts only one consistent `each` unit for each legacy identity. A
conflicting or unsupported unit throws before the SKU table or migration row can
commit.

## Invariants

- Empty means zero tables whose names start with `inventory_`.
- Fresh initialization creates all seven expected tables in one
  `transactionSync` callback.
- Exact v2 means the six committed v2 tables and exactly history `[2]`.
- Migration preserves balances, locations, receipts, command results, opening
  confirmations, and schema history.
- Exact current storage is idempotent and receives no writes.
- Any thrown initialization or migration rolls back the entire callback.
- A failed initializer prevents the Durable Object from serving reads or
  mutations.

## Blast radius and proof

| Surface | Risk | Required proof |
| --- | --- | --- |
| schema state classifier | High | fresh v3, exact v2, exact v3, incompatible shape |
| legacy SKU backfill | High | identity/unit/audit assertions and readable preserved balance |
| transaction rollback | High | unsupported-unit and partial-shape unchanged-state assertions |
| Durable Object constructor | High | real workerd runtime upgrade and repeat initialization |
| docs/proof | Medium | exact-source manifest and review |

The public initializer signature remains synchronous and unchanged:

```ts
function initializeCloudflareInventorySchema(
  storage: DurableObjectStorage,
): void;
```
