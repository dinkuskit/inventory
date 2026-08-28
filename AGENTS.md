# Agent Contract

This public repository owns Dinkuskit Inventory: the inventory ledger for
EmDash sites. Keep it generic: site copy, customer data, tenant branding,
credentials, business figures, and production configuration do not belong
here. Assume every committed line eventually publishes; business rationale
lives in the operator's private planning repo and is cross-referenced by
issue or path only.

## Source priority

1. This file.
2. [docs/CHARTER.md](docs/CHARTER.md) — grilled product locks.
3. `.grilltrack/` — durable decision ledger. Do not hand-edit `ledger.json`;
   use the GrillTrack ledger CLI.

## Boundary

- One product, one ledger. The kernel is platform-neutral; EmDash and
  storefront integrations are adapters at the edge.
- Exactly one inventory writer owns a pool. Never introduce a second writer
  or silently fall back between providers.
- WooCommerce and Katana are outside the product boundary. The first EmDash
  cutover uses a human-gated physical count and manual opening balances; do
  not build a WooCommerce/Katana adapter, importer, shadow sync, or tail sync.
- Manufacturing/MRP, checkout, orders, payments, and shipping labels are not
  owned here.
- Dinkuskit Inventory owns canonical stock truth. EmDash is its human admin
  surface through one generic standard-format sandboxed plugin with a real
  Block Kit GUI. The public plugin calls the Inventory service through
  authenticated, declared network routes; it is not a site-specific native
  React fork.
- Dinkuskit Commerce owns the per-product `Manage stock?` choice and retains a
  narrow provider seam. Dinkuskit Inventory is the default and only first-party
  v1 provider, while advanced site settings may select one user-supplied
  conforming provider. A managed product has exactly one provider: never fan
  out, silently fall back, or create a Commerce-local production stock ledger.
- Authoritative stock mutations use the awaited command-and-receipt contract in
  [docs/COMMAND-RECEIPT-CONTRACT.md](docs/COMMAND-RECEIPT-CONTRACT.md). A
  timeout is an unknown outcome resolved under the original command identity,
  never permission to create a replacement mutation.
- The `dinkus-inventory` CLI is a thin shared-client adapter governed by
  [docs/CLI-SPEC.md](docs/CLI-SPEC.md). It has no direct database path or
  inherent privilege. A Discord adapter is a later, non-launch-blocking client;
  do not make it another command engine or shell it through the CLI.

## Working rules

- Product decisions flow through GrillTrack; no code lands before its domain
  is grilled and locked.
- `FEATURE_MAP.md` is the machine-checked ownership contract. Migrated features
  expose one `src/features/<domain>/index.ts`; outside code may not import their
  internals. `bin/verify-inventory quick|full` is the canonical repository gate.
- Implementation goes through isolated branches or worktrees and PRs with
  tests and proof. Docs-only PRs may skip code review rails; code PRs may
  not.
- Do not publish to npm, list in an EmDash marketplace or registry, deploy,
  merge, or mutate a production site without Bobby's explicit approval. Keep
  EmDash pre-1.0 compatibility claims bound to exact proof.
