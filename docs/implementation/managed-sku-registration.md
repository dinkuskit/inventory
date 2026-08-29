# Managed SKU register-or-return at logical zero

Status: confirmed repair contract for Inventory PR #12.

Commerce `main` at `7b09a25749ce2c650f294a0bd5ab7d99132d2ce5`
defines the provider-neutral registration handshake. This repair supersedes the
earlier direct-SKU registration shape in PR #12 and resolves the accepted
Cloudflare v2-to-v3 compatibility finding.

## Boundary and ownership

Commerce owns the catalog SKU, product title, `Manage stock?` choice, provider
binding, and explicit confirmation when Inventory returns an existing pooled
record. Inventory owns the permanent opaque `inventorySkuId`, the pool-unique
visible SKU, its independent operational display name, its unit, and all stock.

Registration is pool-scoped and location-free. It creates no balance or stock
receipt. A new record preserves the trusted execution principal and registration
time as immutable setup audit metadata. That metadata is not a stock receipt and
does not enter receipt history. The result returned to Commerce contains only the
provider-neutral identity needed by its accepted contract.

V1 supports the exact unit `each`. Case/box conversion, SKU or display-name
editing, UI, provider transport, authentication deployment, publication,
deployment, production mutation, and ordinary stock adjustment remain outside
this repair.

## Public contract

```ts
const REGISTER_MANAGED_SKU_TYPE = "sku.register" as const;
const MANAGED_SKU_UNIT = "each" as const;

type InventorySkuIdentity = Readonly<{
	inventorySkuId: string;
	sku: string;
	displayName: string;
}>;

type ManagedSkuRecord = Readonly<{
	poolId: string;
	inventorySkuId: string;
	sku: string;
	displayName: string;
	unit: typeof MANAGED_SKU_UNIT;
	version: "1";
	registeredAt: string;
	registeredBy: CommandPrincipal;
}>;

type RegisterManagedSkuCommandV1 = Readonly<{
	schema: "dinkuskit.inventory.command/v1";
	commandId: string;
	type: typeof REGISTER_MANAGED_SKU_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{
		sku: string;
		displayNameIfNew: string;
		unit: typeof MANAGED_SKU_UNIT;
	}>;
	references: readonly ExternalReference[];
}>;

type RegisterManagedSkuResult =
	| Readonly<{
			schema: "dinkuskit.inventory.command-result/v1";
			outcome: "registered" | "existing";
			commandId: string;
			inventorySku: InventorySkuIdentity;
	  }>
	| Readonly<{
			schema: "dinkuskit.inventory.command-result/v1";
			outcome: "rejected";
			commandId: string;
			code: "command_id_conflict";
			message: string;
	  }>;
```

`createRegisterManagedSku` additionally requires a synchronous
`createInventorySkuId(): string` dependency. The factory validates the generated
value before writing. The trusted principal comes from execution context, never
from command contents.

The visible SKU and `displayNameIfNew` are trimmed, non-empty, case-sensitive
strings. Inventory stores the first display name once. A later registration for
the same visible SKU ignores its proposed display name and returns the original
identity. Catalog fields other than the one-time display name remain rejected.

Stock commands and reads continue to call their opaque identity field `skuId`;
after this repair that value is always the permanent `inventorySkuId`, never the
Commerce-visible SKU. This keeps the existing stock protocol stable while making
its meaning explicit.

## State and concurrency invariants

- One row exists per `(pool_id, inventory_sku_id)` and visible SKU is also
  unique per pool.
- The serialized pool transaction checks command identity before SKU identity.
  An exact retry returns the original terminal result, including the minted ID.
- Reusing a command ID with different normalized contents returns
  `command_id_conflict` without replacing the original result.
- If the visible SKU is absent, one transaction mints and inserts the managed
  record and terminal `registered` result. No balance or receipt row is written.
- If the visible SKU exists, one transaction stores and returns an `existing`
  terminal result containing the original ID, visible SKU, and display name. It
  does not mint an ID, rename the record, or create a receipt.
- The record freezes `registeredBy` and `registeredAt`; later register-or-return
  calls cannot overwrite either field.
- A registered record reads as logical zero at every active location until a
  balance exists. Opening preview and commit use the permanent Inventory ID and
  fail closed when it is unknown or has the wrong unit.
- Stored balance units must match the registered record. Any mismatch is corrupt
  state and fails closed.

## Storage contract

Both SQLite adapters expose identity lookup and visible-SKU lookup inside the
same pool transaction:

```ts
interface InventoryTransaction {
	getManagedSku(inventorySkuId: string): ManagedSkuRecord | null;
	getManagedSkuBySku(sku: string): ManagedSkuRecord | null;
	storeCommandResult(record: StoredCommandResult): void;
	commitManagedSku(input: ManagedSkuCommit): void;
}

type ManagedSkuCommit = Readonly<{
	commandId: string;
	commandDigest: string;
	sku: ManagedSkuRecord;
	result: RegisterManagedSkuResult;
}>;
```

The v3 table is:

```sql
CREATE TABLE inventory_skus (
	pool_id TEXT NOT NULL,
	inventory_sku_id TEXT NOT NULL,
	sku TEXT NOT NULL,
	display_name TEXT NOT NULL,
	unit TEXT NOT NULL CHECK (unit = 'each'),
	version INTEGER NOT NULL CHECK (version = 1),
	registered_at TEXT NOT NULL,
	registered_by_json TEXT NOT NULL,
	PRIMARY KEY (pool_id, inventory_sku_id),
	UNIQUE (pool_id, sku)
) STRICT;
```

## Cloudflare v2-to-v3 migration

This section records the managed-SKU slice's v3 step. The current schema is v4:
initialization still performs this exact v2-to-v3 backfill before applying the
separate v3-to-v4 stock-transfer migration. Fresh storage initializes directly
at v4.

Initialization recognizes exactly three states:

1. Empty storage: create the complete v3 schema and record migration history
   `[3]`.
2. Exact v2 storage: require the six v2 tables and migration history `[2]`, then
   atomically create `inventory_skus`, backfill legacy identities, append
   migration 3, and verify the complete v3 shape and history `[2, 3]`.
3. Exact v3 storage: accept either valid history `[3]` or `[2, 3]` and perform no
   writes.

Every distinct legacy `inventory_balances.sku_id` is backfilled with:

- `inventory_sku_id = legacy sku_id`, preserving all existing stock callers;
- `sku = legacy sku_id` and `display_name = legacy sku_id` as safe temporary
  fallbacks where v2 had no visible metadata;
- unit copied from the balance, which must be one consistent `each` value across
  all rows for that key; and
- an immutable system principal identifying the v2-to-v3 migration.

Conflicting units, a partial table set, unexpected migration history, or any
other incompatible shape throws inside `transactionSync`. The transaction
rolls back completely. v1 and fabricated partial states remain untouched and
fail closed.

## Blast radius

Risk is high: this changes a public command/result shape, the managed-SKU row,
both SQLite adapters, a durable Cloudflare migration, and the meaning of the
opaque stock `skuId` field. It does not add a network route or cross-repository
runtime call.

Direct Inventory consumers:

- `src/features/managed-sku/domain.ts`,
  `src/features/managed-sku/register.ts`, and its public `index.ts`;
- the shared command/result union in `src/domain/location-registry.ts`;
- `src/storage/inventory-store.ts` and both SQLite adapters;
- aggregate/read, opening-preview, and opening-commit code that resolve
  registered identity;
- `src/cloudflare/schema.ts`, Worker record counts, public exports, fixtures,
  and all registration/opening/read tests; and
- docs and `bin/verify-managed-sku`.

Cross-repository contract consumer:

- Commerce `ManagedSkuRegistrationRequest` sends `poolId`, `sku`, and
  `displayNameIfNew` and accepts `registered | existing` plus
  `{ inventorySkuId, sku, displayName }`. Commerce strips Inventory-only extras
  and requires explicit review before activating an existing identity.

Blocks, SmokyClub, EmDash, Commerce source, and shared review-conductor source
are not modified by this repair.

## TDD and verification plan

Red tests must first prove:

- new registration mints a hidden ID, seeds the display name, freezes actor/time,
  writes no balance or receipt, and exactly replays after reopen;
- a different command for the same visible SKU returns the original identity
  as `existing`, ignores `displayNameIfNew`, mints no ID, and replays durably;
- changed command contents conflict and malformed/catalog payloads fail closed;
- generated-ID or write conflicts roll back record and command result together;
- stock reads and opening admission use `inventorySkuId`, not visible SKU;
- fresh v3 initialization is exact;
- exact v2 workerd Durable Object storage migrates in one transaction, retains
  balances, locations, receipts, command results, and confirmations, backfills
  readable managed identities, and remains idempotent;
- incompatible v2-shaped data rolls back without partial v3 state; and
- all Node, Cloudflare runtime, typecheck, source-manifest, and repo-owned
  verification commands pass.
