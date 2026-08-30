# Ordinary post-opening stock adjustment

Status: implemented and repository-verified for GrillTrack decision
`ordinary-stock-adjustment-038`.

Baseline: merged Inventory `main` at
`d31fbfda982ad669f638a222f0cb1caa7592c095`.

## Purpose and ownership

This slice adds the smallest ordinary human stock mutation after one
SKU-location has committed opening history. Inventory owns normalization,
preview, confirmation, serialized business evaluation, exact arithmetic,
atomic durable commit, command replay, immutable receipt, and read-back.

The slice does not own the Block Kit GUI, Commerce or SmokyClub wiring,
authentication transport, reservation creation, order detail, deployment,
publication, or a production database mutation.

The feature lives behind:

```text
src/features/stock-adjustment/index.ts
```

Files outside the feature import only that entry. The feature depends on the
shared command/quantity/principal types in `src/domain/opening-balance.ts` and
the platform-neutral storage port in `src/storage/inventory-store.ts`.

## Command contract

```ts
const STOCK_ADJUSTMENT_TYPE = "stock.adjust";

type AdjustStockCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: typeof STOCK_ADJUSTMENT_TYPE;
  context: Readonly<{
    siteId: string;
    poolId: string;
    locationId: string;
  }>;
  payload: Readonly<{
    skuId: string;
    delta: Readonly<{ value: string; unit: string }>;
  }>;
  reason: Readonly<{ note: string }>;
  references: readonly Readonly<{ kind: string; id: string }>[];
  expectedVersions: readonly Readonly<{
    skuId: string;
    locationId: string;
    version: string;
  }>[];
}>;
```

The delta is a canonical non-zero signed exact decimal. `+5`, `5.0`, and
`005.000` normalize to `5`; `-3.50` normalizes to `-3.5`; negative zero
normalizes to `0` and is rejected. Binary floating point is never used.

The final trimmed `reason.note` is mandatory. There is no reason category,
reason code, or adjustment prefill. The command type is the stable machine
classification.

`expectedVersions` contains exactly the previewed SKU-location version.
Corrections are new ordinary adjustment commands. A correction initiated from
an earlier receipt carries the typed reference
`{ kind: "corrects_receipt", id: <receiptId> }`; the new immutable receipt
preserves that link. This slice does not edit, delete, or reverse an old row in
place.

## Preview contract

```ts
type PreviewStockAdjustmentInputV1 = Omit<
  AdjustStockCommandV1,
  "commandId" | "expectedVersions" | "schema"
> & Readonly<{
  schema: "dinkuskit.inventory.stock-adjustment-preview-input/v1";
}>;

type StockAdjustmentPreviewV1 = Readonly<{
  schema: "dinkuskit.inventory.stock-adjustment-preview/v1";
  type: "stock.adjust";
  context: PreviewStockAdjustmentInputV1["context"];
  effect: Readonly<{
    skuId: string;
    locationId: string;
    onHandDelta: ExactQuantity;
    reservedDelta: ExactQuantity;
    balanceBefore: StockQuantities & Readonly<{ version: string }>;
    balanceAfter: StockQuantities & Readonly<{ version: string }>;
  }>;
  reason: Readonly<{ note: string }>;
  references: readonly ExternalReference[];
  warnings: readonly Readonly<{
    code: "negative_available";
    reserved: ExactQuantity;
    oversoldBy: ExactQuantity;
    message: string;
  }>[];
  confirmation: Readonly<{ value: string; expiresAt: string }>;
}>;
```

Preview validates an active location, registered SKU and unit, existing stock
history, exact balance units, and the proposed arithmetic. It performs no
balance, receipt, or command-result mutation. It stores only the opaque
confirmation digest, action digest including the observed balance version,
stable principal digest, issue/expiry times, and an initially null command ID.

The confirmation lasts exactly five minutes and may be used immediately. When
resulting available is negative, preview returns one machine-readable warning
with the exact reserved quantity and shortage. For example, on-hand `10`,
reserved `8`, and delta `-5` produces on-hand `5`, available `-3`, and
`oversoldBy=3`. The warning does not block confirmation. Negative on-hand and
negative available are allowed.

## Result and receipt contract

```ts
type StockAdjustmentRejectionCode =
  | "location_not_found"
  | "location_not_active"
  | "sku_not_registered"
  | "sku_unit_mismatch"
  | "opening_balance_required"
  | "stale_version"
  | "command_id_conflict";

type StockAdjustmentResult =
  | Readonly<{
      schema: "dinkuskit.inventory.command-result/v1";
      outcome: "committed";
      commandId: string;
      receipt: StockAdjustmentReceiptV2;
    }>
  | Readonly<{
      schema: "dinkuskit.inventory.command-result/v1";
      outcome: "rejected";
      commandId: string;
      code: StockAdjustmentRejectionCode;
      message: string;
    }>;
```

The receipt uses the existing receipt-v2 schema. It freezes command identity,
digest, trusted signed-in actor, time, explicit site/pool/location/SKU,
mandatory typed reason, signed on-hand delta, zero reserved delta, before and
after quantities, resulting version, and typed references.

Adjustment changes only on-hand. Reserved remains unchanged. Available is
always recomputed exactly as resulting on-hand minus reserved. The balance
version increments by one and `hasStockHistory` remains true.

## Business evaluation order

Inside one pool transaction:

1. Return the original terminal result for an exact command replay, or return
   `command_id_conflict` for changed contents under the same command ID.
2. Require the explicit location to exist and be active.
3. Require the permanent Inventory SKU to exist and match the delta unit.
4. Require a materialized balance with committed stock history. Otherwise
   store `opening_balance_required` without creating a receipt or balance.
5. Require the current balance version to equal the previewed version.
6. Compute exact resulting on-hand and available while preserving reserved.
7. Atomically update the one balance, insert one receipt, and insert the
   terminal result.

Every structurally valid business rejection is durable. Later location,
registration, balance, or version changes cannot change an exact replay.

## Confirmation and durable storage

The existing schema-v3 confirmation table already stores a generic digest,
principal, expiry, and command binding without an operation discriminator.
The storage port gains adjustment-specific accessors over that same row shape:

```ts
getStockAdjustmentConfirmation(digest): StoredStockAdjustmentConfirmation | null;
storeStockAdjustmentConfirmation(record): void;
bindStockAdjustmentConfirmation(digest, commandId): void;
commitStockAdjustment(input: StockAdjustmentCommit): void;
```

The physical table remains `inventory_opening_balance_confirmations` for
schema compatibility. Opening-balance accessors remain unchanged. Opaque
confirmation values are globally unique; the shared primary key prevents a
token from being stored twice. No table, index, migration history, schema
version, or record-count contract changes.

The local and Cloudflare adapters implement the same update/receipt/result
transaction. The update checks the expected prior version and must affect
exactly one balance row. Any receipt collision, result collision, update miss,
or injected failure rolls back the balance, receipt, result, and confirmation
binding together.

## Read-back

`InventoryCommandResult` and `InventoryReceiptV2` gain the adjustment variants.
Direct command-ID and receipt-ID lookup therefore return the exact adjustment
result without a new read path.

Location/all-locations stock receipt history expands from opening receipts to
the stock-receipt union:

```ts
type InventoryStockReceiptV2 =
  | OpeningBalanceReceiptV2
  | StockAdjustmentReceiptV2;
```

The durable query accepts only `stock.opening_balance` and `stock.adjust`.
Location scoping, newest-first ordering, cursor behavior, and bounded limits
remain unchanged. Location lifecycle receipts remain direct-lookup-only.

## Feature and verification ownership

`FEATURE_MAP.md` gains `dinkus.stock-adjustment` as a migrated feature. The
architecture audit requires the feature entry, tests, focused verifier, and
verification skill and rejects deep imports or undeclared dependencies.

`bin/verify-stock-adjustment` is a focused non-interactive diagnostic. The only
canonical review/delivery gate remains `bin/verify-inventory quick|full`, whose
Node test list expands to the adjustment tests. Full verification continues to
include strict Cloudflare typechecking, workerd Durable Object tests, and
Wrangler dry-run.

## Blast-radius report

| Surface | Current files | Risk | Required proof |
| --- | ---: | --- | --- |
| shared `InventoryCommandResult` | 6 | high | direct command/receipt lookup, global command-ID conflict, full Node/workerd suites |
| shared `InventoryReceiptV2` | 5 | high | adjustment receipt round-trip and existing opening/location read-back |
| opening receipt/history typing | 9 | high | mixed opening/adjustment history, location scope, cursor regression |
| storage commit port | 6 files naming `commitOpeningBalance` | high | atomic update/receipt/result, rollback injection, local reopen, workerd parity |
| durable confirmation access | 4 files | high | preview non-mutation, close/reopen, expiry, principal/action/version binding, exact retry |
| schema-v3 confirmation table | 6 files | medium | exact table/version status unchanged and v2-to-v3 regression |
| package root and feature entry | public private package surface | medium | root/feature symbol parity and strict compile |
| canonical/focused verification docs | 12 files naming the canonical verifier | low | architecture audit, focused smoke, canonical full gate |

No Commerce, Blocks, SmokyClub, EmDash, or external package was changed by this
Inventory-owned slice. Cross-repository binding remains separately deferred.

## TDD and cumulative verification

Tests are written and observed failing before implementation. They cover:

- signed exact normalization, mandatory reason, and zero-delta rejection;
- preview arithmetic, exact oversell warning, no mutation, and five-minute
  confirmation semantics;
- immediate commit, negative on-hand/available, reserved preservation, version
  increment, actor/reason/reference receipt facts, and exact read-back;
- exact replay, changed-content conflict, stale version, location/SKU/unit/
  opening-history rejection, and correction link preservation;
- close/reopen confirmation and result recovery;
- atomic rollback on receipt persistence failure;
- mixed stock receipt history and location scope;
- local SQLite and Cloudflare workerd parity with no schema change;
- every prior opening, location, managed-SKU, read, migration, and architecture
  test through the canonical full gate.

## Exact-source implementation review

The contract preserves one Inventory writer, explicit location, permanent
Inventory SKU identity, awaited idempotent commands, durable business
rejections, immutable actor receipts, exact decimals, derived available stock,
schema-v3 compatibility, and fail-closed external boundaries. It does not
write reserved stock, infer a location, bypass opening history, edit a prior
receipt, expose a network mutation, or depend on another repository.
