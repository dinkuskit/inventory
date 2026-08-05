# Dinkuskit Inventory — Charter

Recorded 2026-07-24 from GrillTrack cycle 1 (domain: product identity &
home). Durable decision ledger: `.grilltrack/ledger.json`. Business-sensitive
rationale (figures, forecasts, tenant specifics) lives in the operator's
private planning repo — cross-referenced here by issue or path — and is
deliberately never committed to this repository.

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

## exit-001 — thin disposable WooCommerce adapter (locked)

The Katana exit executes through ONE thin WooCommerce adapter, born
disposable:

- while Katana still runs: shadow the ledger against real order flow to
  validate correctness;
- after the subscription boundary (2026-12-01): carry stock decrement for
  the remaining low-volume tail;
- at storefront migration to EmDash: delete the adapter. Its deletion is a
  success criterion, not a regression.

Shipping labels stay on the storefront's native path (WooCommerce →
Shiptheory); this ledger never enters the label loop. The adapter doubles as
the learning lab for product shapes, variable products, and sync semantics.

## home-001 — dinkuskit/inventory, born public (locked, amended)

This repository is the permanent home; npm namespace `@dinkuskit/*`. Born
public per the Dinkus org default ("dogfooding in the open"); publish gates
are releases, not repository visibility. Amendment note: an initial
private-until-release preference was revised on discovering the existing
public stub and the fact that git history survives any later visibility
flip — the public-safe content discipline is mandatory regardless, so
privacy added nothing.

## Banked (not locked) — v1 movement vocabulary

From real Katana usage by the first tenant: stock adjustments, stock
transfers, and stock-in with a reason code (covering
manufacturing-order-as-arrival WITHOUT recipes or BOM consumption). Purchase
orders are out of scope. A dedicated schema grill decides the exact
vocabulary.

## v1 scope fence (inherited)

In: tenant/site-scoped SKU/variant identity; explicit locations;
on-hand/reserved/available/expected; immutable movement receipts; exact
decimal/unit handling; idempotent order import via the exit adapter;
operator-visible exceptions.

Out: manufacturing orders, recipes/BOM, materials/batches, purchasing,
production scheduling, costing, forecasting, general MRP.

## Open architecture question (next grill)

Storage substrate and kernel architecture — where stock truth lives, and the
relationship between this ledger and AICommerce's inventory-provider
contract (thin client vs provider implementation). Superseded stub framing:
this repository previously described itself as an "advanced extension"
deepening an AICommerce-owned provider; identity-001 replaces that framing
while keeping its core invariant (one writer per pool, never a second
ledger).

## Cross-references

- Control document: saari-co/x-api
  `plans/product/commerce-critical-path-20260713.md`
- Decision ledger issue: saari-co/x-api#399
- Business north star: saari-co/x-api `BUSINESS_NORTH_STAR.md`
