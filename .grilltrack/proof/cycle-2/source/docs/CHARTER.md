# Dinkuskit Inventory — Charter

Recorded from GrillTrack cycle 1 on 2026-07-24 (product identity and home),
then extended on 2026-08-25 with the canonical architecture, operating model,
and manual cutover locks. Durable decision ledger: `.grilltrack/ledger.json`.
Business-sensitive rationale (figures, forecasts, tenant specifics) lives in
the operator's private planning repo — cross-referenced here by issue or path —
and is deliberately never committed to this repository.

## identity-001 — one product, EmDash-native (locked)

The successor ledger that retires the Katana subscription IS Dinkuskit
Inventory v1. One product, one ledger:

- a platform-neutral inventory kernel: SKU/variant identity, explicit
  locations, on-hand/reserved/available/expected, immutable movement
  receipts, exact decimal/unit handling;
- an in-dashboard EmDash admin plugin as the product surface;
- no storefront-shaped base code, ever.

Rationale: durable investment must survive the first tenant's storefront
migration to EmDash. The kernel/adapter split (proven in AICommerce) makes
that structural rather than aspirational.

## exit-001 — thin disposable WooCommerce adapter (superseded)

The first cycle proposed one disposable WooCommerce adapter for Katana shadow
validation and a low-volume legacy tail. That decision is preserved for
history, but it no longer authorizes implementation.

`cutover-004` supersedes it with a physical count and manually reviewed opening
balances. Dinkuskit Inventory v1 contains no WooCommerce or Katana adapter,
importer, shadow sync, or tail synchronization. Shipping labels remain on the
legacy storefront's native path and outside this ledger.

## architecture-002 — canonical Inventory service (locked)

Dinkuskit Inventory owns the sole canonical ledger for each physical inventory
pool. Its platform-neutral kernel owns inventory schema, migrations, commands,
transactions, idempotency, and immutable receipts. Clients never read or write
its tables directly.

The Cloudflare production adapter uses one SQLite-backed Durable Object per
physical pool behind an Inventory-owned service. Every location and every
EmDash site mapped to that pool uses the same object, allowing a multi-item
reservation or movement to commit atomically under one writer. Site-local CMS
storage and reporting projections may hold settings or caches, but never
authoritative balances.

EmDash is the authenticated human administration surface. AICommerce consumes
a thin Inventory provider boundary for availability, reserve, commit, release,
expiry, packing, and balance reads. Those critical calls must be network-aware,
awaited, idempotent, and fail closed; the current in-process synchronous
contract must not be treated as production transport. A missing or unhealthy
provider never falls back to a local counter.

The Durable Object topology is a locked production direction, not a deployment
claim. It must still pass bounded concurrency, idempotency, export/restore, and
provider-conformance proof before any production migration or write is
considered.

## operating-model-003 — shared pool and exact locations (locked)

- One physical inventory pool may serve multiple EmDash sites and channels.
- Each physical location has exact on-hand, reserved, available, expected, and
  in-transit quantities inside that pool.
- Each ecommerce connection maps explicitly to one fulfillment source
  location; names, domains, or matching SKUs never imply a mapping.
- Goods are received where they physically arrive.
- Transfers advance `Created -> In transit -> Received`. Origin availability
  is removed before destination availability appears, and corrections use
  explicit reversal receipts instead of rewriting history.
- Reservations, releases, fulfillment decrements, adjustments, stock-in,
  reconciliation, and visible exceptions all use the same human-administered
  ledger.

## cutover-004 — manual EmDash opening balance (locked)

WooCommerce and Katana remain untouched and canonical for the legacy
merchandise catalog until a separately approved physical cutover. Before the
EmDash storefront begins selling the migrated products, the human operator:

1. marks those products out of stock on WooCommerce;
2. performs an in-house physical count;
3. reviews and records the resulting opening balance for each SKU and location
   in Dinkuskit Inventory; and
4. explicitly makes Dinkuskit Inventory the canonical ledger for the EmDash
   storefront.

There is no dual-writer interval. A production count, opening-balance entry,
WooCommerce change, canonical-writer switch, deploy, or rollback remains a
separate human gate; this charter authorizes none of them.

## home-001 — dinkuskit/inventory, born public (locked, amended)

This repository is the permanent home; npm namespace `@dinkuskit/*`. Born
public per the Dinkus org default ("dogfooding in the open"); publish gates
are releases, not repository visibility. Amendment note: an initial
private-until-release preference was revised on discovering the existing
public stub and the fact that git history survives any later visibility
flip — the public-safe content discipline is mandatory regardless, so
privacy added nothing.

## Banked (not locked) — exact v1 command and schema vocabulary

The operating semantics are locked: adjustments, transfers, stock-in with a
reason code, reservations, releases, fulfillment decrements, and manual
opening balances. A dedicated command/schema grill still decides exact names,
payloads, invariants, receipt shapes, and migration rules. Purchase orders
remain out of scope.

## v1 scope fence (inherited)

In: tenant/site-scoped SKU/variant identity; explicit locations;
on-hand/reserved/available/expected; immutable movement receipts; exact
decimal/unit handling; explicit site-to-pool and site-to-source-location
mappings; manual opening balances; operator-visible exceptions.

Out: manufacturing orders, recipes/BOM, materials/batches, purchasing,
production scheduling, costing, forecasting, general MRP; WooCommerce/Katana
adapters, imports, shadow synchronization, and tail synchronization.

## Next focused grill

Define the exact command and receipt boundary shared by the EmDash admin,
AICommerce, jobs, and the Durable Object adapter. The grill must separate the
small checkout provider surface from broader Inventory operations, evolve the
AICommerce provider transport to await remote results, and define the first
concurrency/idempotency proof without implementing the full product at once.

## Cross-references

- Control document: saari-co/x-api
  `plans/product/commerce-critical-path-20260713.md`
- Decision ledger issue: saari-co/x-api#399
- Business north star: saari-co/x-api `BUSINESS_NORTH_STAR.md`
