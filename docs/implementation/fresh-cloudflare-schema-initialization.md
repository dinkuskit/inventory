# Cloudflare schema v4 initialization and v2/v3 upgrade

## Decision

A brand-new empty Durable Object initializes directly at complete schema v4 and
records history `[4]`. The committed v2 and v3 schemas are supported
predecessors. Exact v3 storage with history `[3]` upgrades atomically to
`[3, 4]`. Exact v2 storage with history `[2]` first backfills its legacy
balanced SKU identities into v3 and then advances to v4, producing
`[2, 3, 4]`. Both paths preserve every durable predecessor record.

Version 1, partial, conflicting-unit, extra-table, or otherwise incompatible
storage fails closed without a partial migration. No live database, deployment,
or production mutation is part of this source repair.

## State contract

```text
no inventory_* tables
  -> create complete v4 atomically
  -> history [4]

exact six-table v2 + history [2]
  -> validate every legacy balance unit
  -> create inventory_skus
  -> backfill stable legacy identities
  -> preserve all six predecessor tables and rows
  -> append version 3
  -> add transfer-planning balance columns and inventory_transfers
  -> append version 4
  -> validate complete v4 + history [2, 3, 4]

exact seven-table v3 + history [3] or [2, 3]
  -> add transfer-planning balance columns and inventory_transfers
  -> append version 4
  -> validate complete v4 + history [3, 4] or [2, 3, 4]

exact eight-table v4 + history [4], [3, 4], or [2, 3, 4]
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

The v3-to-v4 step adds zero-default outgoing-transfer, expected, and in-transit
columns plus `inventory_transfers`; it never fabricates transfer history or
rewrites stock. Migration accepts only one consistent `each` unit for each
legacy identity. A
conflicting or unsupported unit throws before the SKU table or migration row can
commit.

## Invariants

- Empty means zero tables whose names start with `inventory_`.
- Fresh initialization creates all eight expected tables in one
  `transactionSync` callback.
- Exact v2 means the six committed v2 tables and exactly history `[2]`.
- Exact v3 means the seven committed v3 tables with history `[3]` or `[2, 3]`.
- Migration preserves balances, locations, receipts, command results, opening
  confirmations, and schema history.
- Exact current v4 storage is idempotent and receives no writes.
- Any thrown initialization or migration rolls back the entire callback.
- A failed initializer prevents the Durable Object from serving reads or
  mutations.

## Blast radius and proof

| Surface | Risk | Required proof |
| --- | --- | --- |
| schema state classifier | High | fresh v4, exact v2, exact v3, exact v4, incompatible shape |
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
