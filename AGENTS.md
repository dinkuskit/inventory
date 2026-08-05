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
- The WooCommerce adapter is born disposable (Katana exit only). Keep it
  thin; its deletion is a planned success criterion, not a regression.
- Manufacturing/MRP, checkout, orders, payments, and shipping labels are not
  owned here.
- The relationship between this ledger and AICommerce's inventory-provider
  contract is an open architecture decision — grill it before coding either
  side.

## Working rules

- Product decisions flow through GrillTrack; no code lands before its domain
  is grilled and locked.
- Implementation goes through isolated branches or worktrees and PRs with
  tests and proof. Docs-only PRs may skip code review rails; code PRs may
  not.
- Do not publish to npm, list in an EmDash marketplace or registry, deploy,
  merge, or mutate a production site without Bobby's explicit approval. Keep
  EmDash pre-1.0 compatibility claims bound to exact proof.
