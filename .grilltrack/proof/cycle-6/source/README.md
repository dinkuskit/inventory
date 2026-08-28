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
  reason codes. Exactly one writer owns a pool; there is never a second stock
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
behavior.

The real local SQLite test adapter is explicitly development/test-only and
refuses production mode or in-memory use. It is not the final storage layer and
makes no production schema or deployment claim; the separately gated
Cloudflare SQLite Durable Object remains the production direction. There is
still no runtime service, installable plugin, executable CLI, or published npm
package. The package manifest remains private at `0.0.0` to prevent accidental
publication.

Scaffold development is pinned to exact `emdash@0.35.0` with a lockfile. This
is the implementation target for the first standard-format plugin fixture, not
a claim that the unimplemented plugin already has a proven runtime or minimum
compatible version.

The locked development toolchain requires Node `>=22.12.0`. Its dependency tree
declares third-party lifecycle scripts, including install scripts for `esbuild`
and `better-sqlite3`. On the proof host, npm 11.19 reports both scripts as not
covered by `allowScripts` and does not approve them; another npm version or
operator policy may execute them during `npm ci`. The repository adds no
lifecycle approval or bypass. Accepting this development-only supply-chain
boundary remains an explicit maintainer decision at merge.

```bash
npm ci
npm test
npm ls emdash --depth=0
bin/verify-opening-balance
```

Part of [Dinkus](https://github.com/dinkuskit): blocks, Commerce, extensions,
and templates for [EmDash](https://github.com/emdash-cms/emdash) sites.

Under construction, dogfooding in the open. MIT.
