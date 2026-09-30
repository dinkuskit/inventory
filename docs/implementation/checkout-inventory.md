# Whole-basket Checkout inventory adapter

## Decision

Inventory exposes a first-party `CheckoutInventoryPort` adapter. Commerce
owns checkout orchestration; this adapter is the Inventory-owned stock
implementation of the current public reserve/release port. It does not invent
checkout or order models and does not add a Commerce package dependency.

Reserve happens only at Checkout, not at cart add. Kernel factories require
one explicit provider/pool/location binding from trusted configuration. The
request binding must match that frozen binding before any mutation. The entire
basket is held in one serialized transaction, or the operation is a durable
terminal rejection with no holds.

## State contract

- Factories freeze a configured binding. `providerRef` is the configured
  opaque handle. Requests are admitted against that binding; they do not
  select a writer.
- Identity is the caller `operationId`, binding, basket contents, and stable
  `siteId`. Principal is not part of the digest and may change for authorized
  recovery.
- Exact replay of the same operation, binding, contents, and site returns the
  original durable result. Changed binding, contents, or site reject. A
  different site sharing the pool cannot recover or mutate the original hold.
  Command IDs stay globally unique; this adapter does not namespace them by
  site.
- A stored release fences reserve only after its `commandDigest` matches the
  current site-bound digest. A mismatch returns a non-persisted
  `command_id_conflict` and leaves the original release, any original reserve,
  stock, and holds unchanged. The owning same-digest reserve after release
  remains durably `checkout_released`.
- One insufficient SKU rejects the whole basket and leaves no holds.
- `allowBackorders: true` is an unsupported policy and fails closed.
- Terminal release permanently fences the operation: release-before-reserve,
  concurrent or delayed reserve, and later reserve replay cannot reacquire.
- Release fails closed when listed reservation rows are missing or ambiguous
  instead of reporting released while a live hold could remain.
- Paid stock stays reserved until existing fulfillment machinery. There is no
  independent TTL release.
- Named-hold `stock.release` still allows a later named hold outside checkout
  operations.

## Storage

The adapter uses existing command-result, reservation, receipt, and
single-pool transaction machinery. Batch reservation commit now accepts new
holds (`previous: null`) so a whole basket can insert atomically. No schema
version bump: tables and Cloudflare v9 upgrade paths are unchanged.

## Out of this slice

GUI, CLI, Worker HTTP transport, live Commerce/Payments wiring, onboarding,
store-connect, Otta adapters, cross-pool fanout, backorder fulfillment,
independent expiry, and deploy.
