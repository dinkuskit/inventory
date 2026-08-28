# Managed SKU registration at logical zero

Status: confirmed implementation contract for the next Inventory GrillTrack
slice.

## Boundary

This slice owns one platform-neutral command that enrolls a Commerce-owned SKU
in an explicit Inventory pool before any stock history exists. Registration is
the durable fact that lets Inventory show the SKU at zero across every active
location and admit a later `Set Initial Stock` command.

Inventory owns the registered SKU identity, quantity unit, command result, and
immutable registration receipt. It does not store a product name, image,
description, price, category, or other Commerce/Blocks catalog data. It does
not implement the Commerce checkbox, Block Kit GUI, service authentication,
deployment, publication, or production data.

V1 registers individual items only. Case, box, and unit-conversion behavior is
deferred until Inventory, Commerce, and Blocks have passed a real-store
end-to-end proof. Turning `Manage stock` off is also deferred; this slice does
not delete, archive, or deactivate a registered SKU.

## Public contract

```ts
const REGISTER_MANAGED_SKU_TYPE = "sku.register" as const;
const MANAGED_SKU_UNIT = "each" as const;

type ManagedSkuRecord = Readonly<{
	poolId: string;
	skuId: string;
	unit: typeof MANAGED_SKU_UNIT;
	version: "1";
	registeredAt: string;
}>;

type RegisterManagedSkuCommandV1 = Readonly<{
	schema: "dinkuskit.inventory.command/v1";
	commandId: string;
	type: typeof REGISTER_MANAGED_SKU_TYPE;
	context: Readonly<{ siteId: string; poolId: string }>;
	payload: Readonly<{
		skuId: string;
		unit: typeof MANAGED_SKU_UNIT;
	}>;
	references: readonly ExternalReference[];
}>;

type ManagedSkuReceiptV2 = Readonly<{
	schema: "dinkuskit.inventory.receipt/v2";
	receiptId: string;
	commandId: string;
	commandDigest: string;
	status: "committed";
	type: typeof REGISTER_MANAGED_SKU_TYPE;
	committedAt: string;
	principal: CommandPrincipal;
	context: Readonly<{ siteId: string; poolId: string }>;
	effect: Readonly<{ before: null; after: ManagedSkuRecord }>;
	references: readonly ExternalReference[];
}>;

type RegisterManagedSkuResult =
	| Readonly<{
			schema: "dinkuskit.inventory.command-result/v1";
			outcome: "committed";
			commandId: string;
			receipt: ManagedSkuReceiptV2;
	  }>
	| Readonly<{
			schema: "dinkuskit.inventory.command-result/v1";
			outcome: "rejected";
			commandId: string;
			code: "command_id_conflict" | "sku_already_registered";
			message: string;
	  }>;

type RegisterManagedSku = (
	command: RegisterManagedSkuCommandV1,
	execution: Readonly<{ principal: CommandPrincipal }>,
) => Promise<RegisterManagedSkuResult>;
```

`skuId`, command/context IDs, principal facts, and references use the existing
trimmed non-empty normalization rules. SKU identity remains an opaque,
case-sensitive Commerce-owned string in this slice. The only accepted unit is
the exact literal `each`. There is no free-text reason because the registration
action is self-explanatory.

## State and invariants

- One `inventory_skus` row exists per `(pool_id, sku_id)` and contains no
  catalog data.
- A registration command always names an explicit pool and never invents or
  defaults a location.
- A first registration atomically inserts the SKU row, immutable receipt, and
  terminal command result in the canonical pool transaction.
- The receipt freezes the trusted signed-in principal supplied by the execution
  boundary. Command contents cannot claim the actor.
- An exact retry with the same command ID and normalized contents returns the
  original terminal result and receipt without minting another ID.
- Reusing a command ID with changed contents returns
  `command_id_conflict` without replacing the original result.
- A new command ID for an already registered SKU durably rejects as
  `sku_already_registered` with the safe message `This SKU is already set up.`
  It creates no second SKU or receipt. Retrying that rejection returns it
  exactly.
- A later opening-balance command for an unregistered SKU durably rejects as
  `sku_not_registered`; it creates no balance or receipt. This prevents
  unmanaged or invisible stock from bypassing registration.
- Opening-balance preview fails before issuing durable confirmation state when
  the SKU is unregistered or its proposed unit differs from the registered
  unit. The command boundary durably rejects a unit mismatch as
  `sku_unit_mismatch` with no balance or receipt.
- `createReadSkuStock` uses the registered record as the existence and unit
  authority. A registered SKU with no balance rows returns `found`, with exact
  zero quantities for every active location and the pool total. An unknown SKU
  remains `not_found`.
- Stored balance units must match the registered SKU unit. Any mismatch fails
  closed as corrupt state.

## Durable storage boundary

Both SQLite adapters gain the same transaction and read capabilities:

```ts
interface InventoryTransaction {
	getManagedSku(skuId: string): ManagedSkuRecord | null;
	commitManagedSku(input: ManagedSkuCommit): void;
}

interface InventoryStore {
	readManagedSku(query: ReadManagedSkuQuery):
		Promise<ManagedSkuRecord | null>;
}
```

The fresh Cloudflare schema advances to version 3 and the local test schema to
its next exact version. Both add:

```sql
CREATE TABLE inventory_skus (
	pool_id TEXT NOT NULL,
	sku_id TEXT NOT NULL,
	unit TEXT NOT NULL CHECK (unit = 'each'),
	version INTEGER NOT NULL CHECK (version = 1),
	registered_at TEXT NOT NULL,
	PRIMARY KEY (pool_id, sku_id)
) STRICT;
```

There is no live Inventory database, so initialization remains fresh-only.
Older, partial, or unexpected shapes fail closed without modification; this
slice does not fabricate a migration for nonexistent production data.

## Blast radius

Risk: high inside Inventory because this adds a database table, extends shared
command/receipt unions, and tightens opening-balance admission. It adds no
cross-repository call, network route, deployment, or production mutation.

Affected production files:

- `src/domain/managed-sku.ts`: new command, record, receipt, normalization, and
  digest contract.
- `src/application/register-managed-sku.ts`: serialized registration behavior.
- `src/domain/location-registry.ts`: additive shared command/result/receipt
  unions.
- `src/domain/opening-balance.ts` and
  `src/application/set-opening-balance.ts`: additive
  `sku_not_registered` rejection and same-transaction admission check.
- `src/application/read-inventory.ts`: registered identity/unit authority for
  zero-stock reads.
- `src/storage/inventory-store.ts`: additive SKU transaction/read methods and
  commit types.
- Both SQLite adapters: SKU row reads and atomic commit.
- `src/cloudflare/schema.ts`: fresh exact schema v3 with `inventory_skus`.
- `src/index.ts`: additive platform-neutral exports.

Direct consumers of `InventoryStore` are the two repository-owned adapters,
application factories, and test doubles. All must be updated together.
Commerce, Blocks, SmokyClub, EmDash, and the review conductor are out of scope.

## Verification plan

Strict TDD must first prove failure for:

- valid first registration, actor-bearing receipt, durable read-back, and exact
  retry;
- changed-content command conflict and a durable `sku_already_registered`
  result for a new command ID;
- rejection of missing identity, catalog fields, reasons, and units other than
  `each`;
- local SQLite close/reopen persistence and atomic rollback on receipt conflict;
- a registered zero-stock SKU across zero, one, and multiple active locations;
- `sku_not_registered` opening-balance rejection and exact replay;
- unregistered preview rejection and durable opening-unit mismatch rejection;
- Cloudflare fresh schema v3, pool isolation, atomic registration, zero-stock
  read, and type safety;
- complete regression through all existing Node tests, Cloudflare tests,
  Cloudflare typecheck, and a repo-owned `verify:managed-sku` command.
