# Stock transfer creation, dispatch, and reversal

This contract covers the platform-neutral durable `Created -> In transit`
portion of the Inventory-owned stock-transfer workflow and the exact
`In transit -> Created` correction. It deliberately stops before receipt.
EmDash, Commerce, Block Kit, authentication deployment, package publication,
and production rollout remain outside this change.

## Ownership boundary

`dinkus.stock-transfer` owns:

- `transfer.create`, `transfer.update`, `transfer.cancel`,
  `transfer.dispatch`, and `transfer.reopen` commands;
- the permanent opaque transfer identity and editable pool-unique reference;
- Created, In-transit, and Canceled transfer records and contextual read-back;
- atomic outgoing-transfer commitments at the origin;
- atomic expected inbound quantities at the destination; and
- immutable actor receipts and exact idempotent command results.

It does not own orders, order reservations, checkout, shipping, carriers,
manufacturing, purchase orders, or a second stock ledger. `transfer.receive`,
partial receipt, and Received reversion are later slices.

## Public command contract

All commands use `dinkuskit.inventory.command/v1`, an explicit site and pool,
and a caller-created stable `commandId`.

```ts
type StockTransferLine = Readonly<{
  skuId: string;
  quantity: Readonly<{ value: string; unit: "each" }>;
}>;

type CreatedStockTransferFields = Readonly<{
  reference: string | null;
  originLocationId: string;
  destinationLocationId: string;
  lines: readonly StockTransferLine[];
  note: string | null;
  expectedDispatchDate: string;
  expectedArrivalDate: string;
}>;

type CreateStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.create";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: CreatedStockTransferFields;
  references: readonly ExternalReference[];
  expectedVersions: readonly [];
}>;

type UpdateStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.update";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: CreatedStockTransferFields & Readonly<{ transferId: string }>;
  references: readonly ExternalReference[];
  expectedVersions: readonly Readonly<{
    transferId: string;
    version: string;
  }>[];
}>;

type CancelStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.cancel";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: Readonly<{ transferId: string }>;
  references: readonly ExternalReference[];
  expectedVersions: readonly Readonly<{
    transferId: string;
    version: string;
  }>[];
}>;

type DispatchStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.dispatch";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: Readonly<{ transferId: string }>;
  references: readonly ExternalReference[];
  expectedVersions: readonly Readonly<{
    transferId: string;
    version: string;
  }>[];
}>;

type ReopenStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.reopen";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: Readonly<{ transferId: string; reason: string | null }>;
  references: readonly ExternalReference[];
  expectedVersions: readonly Readonly<{
    transferId: string;
    version: string;
  }>[];
}>;
```

Creation requires one or more unique permanent Inventory SKU identities. A
line quantity is an exact non-negative decimal in `each`; zero is valid only
for a Created draft. Origin and destination are explicit, distinct, active
locations. Expected dates use calendar `YYYY-MM-DD` values and expected arrival
cannot precede expected dispatch.

When `reference` is null, Inventory allocates an `ST-...` reference. A caller
may supply or later replace the complete reference. Its normalized key is
unique across every status in one pool, while `transferId` remains the
permanent authority. The optional note normalizes blank text to null.

Update is a full replacement of editable Created fields and requires the exact
current transfer version. Cancel and dispatch also require that version.
Dispatch additionally requires every saved line quantity to be positive.
Reopen requires the exact current In-transit version and accepts an optional
trimmed free-text reason. A stale version, wrong status, unknown transfer,
unknown or archived location, duplicate reference, unknown SKU, mismatched
unit, missing origin opening history for a positive line, or command-ID
conflict rejects durably without partial effects.

## Record and receipt shapes

The durable transfer record retains its opaque ID, editable reference, status,
locations, lines, optional note, Created timestamp and actor, expected dates,
version, update timestamp, and nullable dispatched, received, and canceled
facts. Dispatch automatically sets `dispatchedDate` to the trusted commit
timestamp. Reopen clears that current field so the Created shipment facts are
editable again; the earlier immutable dispatch receipt retains the original
actor and timestamp.

Every committed transfer command creates one immutable
receipt. The receipt freezes the actor, command identity and digest, commit
time, site and pool, transfer before/after facts, exact balance effects,
optional reopen reason, and external references. Editing or reopening a
transfer never edits a prior receipt.

## Quantity invariants

Each balance retains six exact quantities:

```text
onHand
reservedForOrders
outgoingTransferCommitment
available = onHand - reservedForOrders - outgoingTransferCommitment
expectedInbound
inTransitInbound
```

A zero-quantity Created draft has no balance effect. A positive Created line:

- leaves physical on-hand and order reservation unchanged;
- adds its quantity to the origin outgoing transfer commitment;
- reduces origin available by the same quantity; and
- adds the same quantity to destination expected inbound.

Created edits atomically release the old effects and apply the complete new
effects. Cancel atomically releases every remaining outgoing commitment and
expected inbound quantity while leaving on-hand unchanged. Quantities may make
origin available negative; the committed result carries an exact
`negative_available` warning with the order-reserved, transfer-committed, and
oversold quantities. Per-line read context adds the current Created quantity
back to stored available so `originMovable` subtracts reservations and other
transfers without counting the current transfer twice. It also exposes
destination on-hand, projected origin available, and explicit availability.

Dispatch removes the current outgoing commitment, decrements origin on-hand,
removes destination expected, and increments destination in-transit. Customer
orders retain priority. Insufficient movable stock is a visible warning, not a
block; for 10 physical, 8 reserved, and 5 to move it reports:
`This transfer will leave you with -3 stock. 8 are reserved for orders.`

Reopen applies the exact inverse: it restores origin on-hand and outgoing
commitment, removes destination in-transit, and restores destination expected.
Destination on-hand does not change. Available is re-derived after every
transition as `onHand - reserved - outgoingTransferCommitted`.

Opening balance initializes the new planning quantities to zero. Ordinary
adjustment preserves them and derives available using the full formula. Stock
reads expose and aggregate all six quantities. Location archival treats any
non-zero on-hand, order reservation, outgoing commitment, expected inbound, or
in-transit inbound quantity as a blocker.

A Created transfer may materialize destination expected stock before that
SKU-location has physical stock history. `Set Initial Stock` remains available
there: preview binds to the planning row's exact version, and confirmation
atomically sets on-hand while preserving expected/in-transit facts. A planning
change after preview is stale and cannot be smuggled through the same
confirmation.

## Atomic durable storage boundary

One pool transaction performs replay/conflict detection, business validation,
transfer-reference uniqueness, transfer persistence, every affected balance
insert/update, immutable receipt insertion, and terminal-result insertion.
There is no interval where the transfer and its balance effects disagree.

The current v4 schema already stores every required balance dimension, permits
the `in_transit` status, and stores the transfer and receipt bodies as immutable
JSON. This transition adds no schema or migration. Fresh Durable Objects still
initialize directly at v4; exact v2 storage still moves through v3 and then v4.

## Verification and blast radius

Risk is high: the change extends the public package API, shared balance type,
SQLite schemas, both adapters, location blockers, stock reads, receipts, and
Cloudflare migration proof. Required tests cover:

- command normalization, reference/date/line invariants, and public entry;
- zero drafts, positive commitments/expected quantities, current-transfer-aware
  movable stock, exact order-priority warnings, replay, changed-command
  conflict, reference uniqueness, and stale transitions;
- atomic edit and cancel effects across multiple lines and locations;
- exact dispatch and reopen physical/planning effects, automatic timestamps,
  optional reversal reason, immutable actor history, and wrong-state rejection;
- archived/unknown locations, unknown SKUs, opening-history and unit failures;
- rollback when balance, receipt, transfer, or result persistence fails;
- local close/reopen read-back;
- Cloudflare v3-to-v4 and v2-to-v4 preservation plus runtime parity; and
- full architecture, typecheck, Node, workerd, and Wrangler dry-run gates.
