# Dinkuskit Inventory

`* * *`

The inventory ledger for EmDash sites: tenant/site-scoped SKU and variant
identity, explicit locations, immutable movement receipts, reservations, and
operator-visible exceptions. Planned package: `@dinkuskit/inventory`.

Dinkuskit Inventory is one product with one ledger. Its first production job
is retiring a commercial MRP subscription (Katana) for the first tenant
business by December 2026; the same artifact is the kit product. The charter
records how that works: [docs/CHARTER.md](docs/CHARTER.md).

## v1 boundary

- EmDash-native: a platform-neutral inventory kernel plus an in-dashboard
  EmDash admin plugin. No storefront-shaped base code.
- Movements are immutable receipts: adjustments, transfers, and stock-in with
  reason codes. Exactly one writer owns a pool; there is never a second stock
  ledger.
- One thin, explicitly disposable WooCommerce adapter exists only for the
  Katana exit (shadow validation, then a low-volume tail); its deletion at
  storefront migration is a success criterion, not a regression.
- Out of scope for v1: manufacturing orders, recipes/BOM, materials/batches,
  purchasing, production scheduling, costing, forecasting — this is not an
  MRP.

## Status

Public charter stage — grilled product decisions live in
[docs/CHARTER.md](docs/CHARTER.md) with the durable decision ledger under
`.grilltrack/`. There is no installable plugin or published npm package yet.
The package manifest is private at `0.0.0` to prevent accidental publication.

Part of [Dinkus](https://github.com/dinkuskit): blocks, AICommerce, commerce
extensions, and templates for [EmDash](https://github.com/emdash-cms/emdash)
sites.

Under construction, dogfooding in the open. MIT.
