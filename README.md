# Dinkuskit Inventory

`* * *`

The inventory ledger for EmDash sites: tenant/site-scoped SKU and variant
identity, explicit locations, immutable movement receipts, reservations, and
operator-visible exceptions. Planned package: `@dinkuskit/inventory`, with a
first-class `dinkus-inventory` CLI.

Dinkuskit Inventory is one product with one ledger. Its first production job
is retiring a commercial MRP subscription (Katana) for the first tenant
business by December 2026; the same artifact is the kit product. The charter
records how that works: [docs/CHARTER.md](docs/CHARTER.md).

## v1 boundary

- EmDash-native: a platform-neutral inventory kernel plus one generic
  standard-format sandboxed EmDash plugin with a real host-rendered Block Kit
  admin GUI. The same installable artifact is proven in SmokyClub; no
  storefront-shaped base code or site-specific plugin fork.
- Canonical production truth lives behind an Inventory-owned service. The
  Cloudflare adapter uses one SQLite-backed Durable Object per physical pool;
  every site and location mapped to that pool shares the same ledger.
- Movements are immutable receipts: adjustments, transfers, and stock-in with
  operation-typed reasons. Exactly one writer owns a pool; there is never a second stock
  ledger.
- Every stock mutation is an awaited, idempotent command. Success means the
  canonical writer committed the balance effects and immutable receipt
  together; a timeout remains unknown until the same command identity is
  resolved.
- EmDash, Commerce, the CLI, jobs, agents, and a future Discord adapter are
  permissioned clients of that same command engine. None reads the database or
  silently falls back to another stock counter.
- Commerce exposes `Manage stock?` per product. Managed products use exactly
  one site-configured provider: Dinkuskit Inventory by default, or one
  user-supplied conforming provider selected in advanced settings. Dinkuskit
  Inventory is the only first-party v1 integration. Unmanaged products send no
  stock commands, and Commerce owns no fallback production ledger.
- WooCommerce and Katana stay untouched until a separately approved manual
  cutover. The operator disables the migrated products there, performs a
  physical count, and records reviewed opening balances in Dinkuskit
  Inventory before the EmDash storefront begins selling them. No legacy
  adapter or shadow synchronization is in v1.
- Out of scope for v1: manufacturing orders, recipes/BOM, materials/batches,
  purchasing, production scheduling, costing, forecasting — this is not an
  MRP.

## Status

The public contracts remain the source of product truth: grilled decisions live in
[docs/CHARTER.md](docs/CHARTER.md), the command semantics live in
[docs/COMMAND-RECEIPT-CONTRACT.md](docs/COMMAND-RECEIPT-CONTRACT.md), and the
planned operator/agent surface lives in [docs/CLI-SPEC.md](docs/CLI-SPEC.md).
The durable decision ledger is under `.grilltrack/`.

The first executable kernel checkpoint implements one `Set opening balance`
command and its platform-neutral preview/confirmation boundary. Preview has no
stock effect, is usable immediately, expires after exactly five minutes, and
returns `expiresAt` for a future visible countdown. First confirmation binds
one command identity atomically; an exact retry can recover the original result
after expiry or a lost response. Tests prove atomic balance,
immutable-receipt, stable-result, replay, conflict, rejection, location,
restart, expiry, action/principal binding, and single-command confirmation
behavior. The kernel also exposes read-only, explicit-key balance lookup and
mutation-result lookup by receipt ID or command ID. Human receipt v2 records
the trusted EmDash user ID, display-name snapshot, and originating surface;
actor-like command fields cannot override it, and account renames do not alter
history or break exact retry. The kernel now also includes the Inventory-owned
location registry: permanent IDs, names reserved across active and archived
records, atomic create/rename/archive/restore receipts, active/archive reads,
and archive rejection for positive, negative, or reserved stock. A new opening
balance now resolves that registry inside its stock transaction: active
locations may commit, while unknown or archived locations receive stable
rejections without a balance or receipt. A read-only aggregate now accepts one
caller-supplied SKU and either one active location or all active locations. The
all-locations result returns exact on-hand, reserved, outgoing-transfer,
derived-available, expected, and in-transit totals plus a per-location
breakdown, including explicit zero rows; it does not
discover or synchronize Commerce catalog data. Inventory now also owns one
awaited `sku.register` command: a new visible Commerce SKU mints a permanent
opaque Inventory ID and one-time operational display name, while an existing
visible SKU returns its original record for Commerce confirmation. Registration
stores immutable setup actor/time audit but creates no balance or stock receipt.
The permanent Inventory ID reads at logical zero across active locations, and
opening previews and commands fail closed until that identity exists.
The kernel now also executes ordinary post-opening stock adjustments. Each
command names one explicit active location and permanent Inventory SKU, carries
one non-zero signed exact delta and a mandatory note-only reason, and is bound
to the previewed balance version. Five-minute preview shows before/after
on-hand, reserved, outgoing-transfer, available, expected, and in-transit
quantities plus an exact oversell warning;
negative stock remains allowed. Commit changes only on-hand, preserves
reserved, advances the version, and atomically creates one immutable receipt
with the trusted signed-in actor. Exact retries recover the original durable
result, changed contents conflict, stale previews reject, and corrections are
new linked receipts rather than edits.

The stock-transfer kernel implements durable Created drafts, dispatch,
In-transit reopen, and whole-transfer receipt. A draft
has one permanent opaque transfer ID, an editable pool-unique `ST-...`
reference, explicit active origin and destination, one or more managed SKU
lines, an optional note, and expected dispatch and arrival dates. Zero
quantities are valid while Created. Positive quantities atomically commit
outgoing stock at the origin, reduce available stock, and add expected stock at
the destination without changing physical on-hand. Full Created edits rebalance
those effects; cancel records a durable Done/Canceled transfer and releases
them. Per-line read context shows customer-order-priority movable stock,
destination on-hand, and an explicit availability warning without counting the
current transfer twice. Dispatch requires positive quantities and atomically
decrements origin on-hand, removes its outgoing commitment, and moves
destination expected into in-transit; Inventory records the actual timestamp
automatically. Reopen applies the exact inverse, accepts an optional reason,
and preserves immutable dispatch and reversal actor history. Receive atomically
moves every full line from destination in-transit to destination on-hand,
establishes physical stock history there, and records the automatic receiver
and timestamp with no reason field. A shortage or damaged unit is a separate
reasoned destination adjustment after full receipt. Every command is versioned,
idempotent, actor-bearing, and committed with its immutable receipt. Partial
receipt, Received reversion, GUI, and runtime service exposure remain later
slices.

The real local SQLite test adapter remains explicitly development/test-only and
refuses production mode or in-memory use. It is not the final storage layer.
The first production-storage checkpoint is a private `dinkuskit-inventory`
Cloudflare Worker with a SQLite-backed Durable Object namespace and one object
database per explicit pool. Workers.dev and preview URLs are disabled, no route
is deployed, and its remote surface remains private and read-only: same-account
SKU-location inspection and aggregate SKU stock reads.
The source schema defines version 4 as the complete current real-database
schema, including the location, managed-SKU, and stock-transfer records plus
the six stock dimensions. Fresh empty storage initializes directly at version
4. Exact committed version-3 storage upgrades atomically; exact version-2
storage moves through v3 and then v4. Both paths preserve prior durable records,
and the v2 path backfills legacy balanced SKU keys as stable managed identities.
Incompatible shapes fail closed without a partial upgrade. Workerd runtime
tests prove those transitions, but this is not a deployment or live-database
claim. Inventory mutations are not remotely exposed, no
storefront traffic is bound, and no physical stock cutover has happened. There
is still no installable plugin, executable CLI, or published npm package. The
package manifest remains private at `0.0.0` to prevent accidental publication.

Scaffold development is pinned to exact `emdash@0.35.0` with a lockfile. This
is the implementation target for the first standard-format plugin fixture, not
a claim that the unimplemented plugin already has a proven runtime or minimum
compatible version.

The locked development toolchain requires Node `>=22.12.0`. Its dependency tree
declares third-party lifecycle scripts, including install scripts for
`esbuild`, `better-sqlite3`, and `workerd`. On the proof host, npm 11.19 reports
those scripts as not covered by `allowScripts` and does not approve them;
another npm version or operator policy may execute them during `npm ci`. The
repository adds no lifecycle approval or bypass. Accepting this
development-only supply-chain boundary remains an explicit maintainer decision
at merge.

```bash
npm ci
npm test
npm ls emdash --depth=0
bin/verify-inventory quick
bin/verify-inventory full
```

The canonical verifier enforces [FEATURE_MAP.md](FEATURE_MAP.md), feature
entries, import boundaries, platform-neutral behavior, the Cloudflare workerd
runtime, and deployment dry-run. Focused diagnostics remain available:

```bash
bin/verify-opening-balance
bin/verify-location-registry
bin/verify-aggregate-stock-read
bin/verify-managed-sku
bin/verify-stock-adjustment
bin/verify-stock-transfer
bin/verify-cloudflare-storage
```

Part of [Dinkus](https://github.com/dinkuskit): blocks, Commerce, extensions,
and templates for [EmDash](https://github.com/emdash-cms/emdash) sites.

Under construction, dogfooding in the open. MIT.
