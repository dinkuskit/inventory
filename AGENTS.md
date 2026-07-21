# Agent Contract

This public repository owns the advanced Dinkus Inventory extension for
AICommerce on EmDash. Keep it generic: site copy, customer data, Smoky branding,
credentials, and production configuration do not belong here.

## Boundary

- AICommerce owns the canonical commerce and inventory-provider contracts.
- This extension adds multi-location/shared-pool operations, movement history,
  imports, reconciliation, exceptions, and migration tooling.
- Exactly one inventory provider owns a pool. Never introduce a second writer
  or silently fall back between providers.
- Manufacturing/MRP, checkout, orders, payments, and shipping labels are not
  owned here.

## Bootstrap State

This is a design stub. Add implementation only through an isolated branch and
worktree with tests, proof, and a documented `@dinkuskit/commerce-sdk` range.
Keep the package private until its dogfood and release gates pass.

## Gates

Do not publish to npm, list in an EmDash marketplace or registry, deploy,
merge, or mutate a production site without Bobby's explicit approval. Keep
EmDash pre-1.0 compatibility claims bound to exact proof.
