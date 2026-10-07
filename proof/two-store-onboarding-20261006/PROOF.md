# Two-store first-stock onboarding

Base: `206879d9562f927f2fad00dfa9b10a5cbef796c8` (merged Inventory41).

Authenticated hosted `/v1/skus` and `/v1/skus/register` resolve account from verified issuer/subject, site from the signed claim, and pool from its owned operation. Registration reuses the existing replay-safe kernel, returns a permanent SKU identity, and creates no stock or movement receipt. The plugin offers owned SKU and active-location selectors and preserves the originating administrator, command ID, and payload through an unknown registration outcome.

The confirmed account/pool choice preserves the current topology: each new store defaults to a separate pool; a merchant can explicitly reconnect another site to an operation owned by the same account. A populated separate pool cannot be silently joined or migrated. No new production ledger or database topology was introduced.

## Source verification

`NAPI_RS_FORCE_WASI=error npm run verify:full` passes: 240 Node tests, 29 Cloudflare tests, nine hosted-runtime tests, both typechecks, architecture checks, and plugin bundle validation. Official version-matched local WASI bindings were installed only in ignored `node_modules`; the package manifest and lockfile are unchanged. See `verification.json` and `source-manifest.json`.

Real SQLite Durable Object tests use ES256 JWT signatures and the actual account authenticator. They cover overlapping names for two different customers, independent pools/identities/balances/receipts, no stock at registration, exact replay and changed-command conflicts, foreign reads returning no data, foreign writes/reconnect denial, posted authority rejection, site-claim mismatch, and deliberate same-account sharing. Separate same-account new stores get separate pools, and an already connected store cannot silently migrate.

Plugin tests cover lost acknowledgement and replay, foreign administrator fencing, mismatched command/status replies, the kernel's real registration identity shape, existing registration without a zero-stock claim, and a fresh pool without an empty stock selector.

## Installed local proof

Two fresh EmDash1.0.1 sites were built and migrated independently (88 migrations each), with actual non-symlink npm package installation. Both browser flows used the owner-qualified Website11 source `7502dc83424902c442da1eaaa5980fd250ff6aa8`, real local Better Auth signup/sign-in, a token-hidden test mailbox, explicit site consent, real plugin public receipt, fixed callback/PKCE exchange, and actual public JWKS verification. No merchant session, service grant, pool, registered SKU or opening stock was injected. The EmDash host administrator is synthetic.

The sites use two isolated Website test controllers and ONE shared Inventory service with account/pool SQLite Durable Objects. This proves bounded local component behavior, not a shared hosted Website deployment. The package variants change only explicit proof authorities/verification origins; production `.invalid` defaults remain fail-closed. `installed-flow.json` records package hashes, distinct issuer-subject identities, site/pool/SKU IDs, receipts, and six original capture hashes. Five unique screenshots are published separately as immutable proof assets; the duplicate remains local.

Both customers used `HAT-BLACK` / `Black Hat` and `Shared Depot`. Store A explicitly confirmed seven units; store B confirmed eleven. Each original receipt and balance remained after host restart and fresh consent renewal. Website tokens last five minutes. Revoking B through the actual local Website GUI left A's seven-unit read functional; immediate invalidation of already-issued JWTs is not claimed.

The standalone EmDash proof runner starts every process at plugin port18788; B's proof adapter uses18790. The npm workerd Node wrapper can leave its native child after termination. Exact task-owned native children were retired after process-group/executable verification, and both databases were preserved. Consequently restart evidence includes scoped owned-child cleanup; it is not proof that the unmodified standalone wrapper needs no lifecycle supervision. An upstream host port/child-lifecycle contract is a separate handoff.

## Remaining maintainer gates

CI, comprehensive exact-source OpenClaw and native ClawSweeper evidence must qualify the final PR tuple. Merge requires explicit owner approval. Hosted HTTPS/DNS/merchant issuance, one shared hosted auth authority, signed Registry availability, production provisioning, deployment, releases, costs, real stock, and immediate grant introspection remain outside this local proof. Any such activation needs a concrete separately approved runtime/authority handoff.

## Immutable media placement

The [selected evidence release](https://github.com/dinkuskit/dinkus-pr-assets/releases/tag/inventory-pr-42-3ed9152d49a9) preserves captures from source head `3ed9152d49a9385e9d439f32ddbf59a47b1a7843`. The subsequent media-only commit removes product-repository binaries and adds this claim map; it does not change runtime source or regenerate UI evidence. `assets.json` records exact URLs, byte sizes, SHA256, capture date, source provenance, visual redaction review, selection rationale and limits. GitHub's uploaded-asset size/digest were checked against local selected bytes. The asset shelf is private; media access requires authorization. Public text remains authoritative.

| Evidence | Supported visible claim |
| --- | --- |
| [store-a-stock-after-restart.jpg](https://github.com/dinkuskit/dinkus-pr-assets/releases/download/inventory-pr-42-3ed9152d49a9/store-a-stock-after-restart.jpg) | Store A stock view after scoped host restart: seven each, version 1. |
| [store-b-stock-after-restart.jpg](https://github.com/dinkuskit/dinkus-pr-assets/releases/download/inventory-pr-42-3ed9152d49a9/store-b-stock-after-restart.jpg) | Store B stock view after scoped host restart: eleven each, version 1. |
| [store-a-receipt-after-restart.jpg](https://github.com/dinkuskit/dinkus-pr-assets/releases/download/inventory-pr-42-3ed9152d49a9/store-a-receipt-after-restart.jpg) | Store A retains original receipt a13a6955-70b3-4fa0-be28-b47d5554ecdb after restart. |
| [store-b-receipt-after-restart.jpg](https://github.com/dinkuskit/dinkus-pr-assets/releases/download/inventory-pr-42-3ed9152d49a9/store-b-receipt-after-restart.jpg) | Store B retains original receipt 393a6d75-c53b-4344-b46e-24b5026d3743 after restart. |
| [store-b-grant-revoked.jpg](https://github.com/dinkuskit/dinkus-pr-assets/releases/download/inventory-pr-42-3ed9152d49a9/store-b-grant-revoked.jpg) | Qualified local Website controller shows store B Inventory grant revoked. |

All six raw captures remain in the ignored local run. The omitted after-other-revocation capture has the same SHA256 as Store A’s stock screenshot; it is not independent timing evidence. Recorded flow and signed-identity runtime tests substantiate the isolation claims. No immediate issued-JWT revocation, hosted publication, Registry release or unsupervised host-child cleanup is claimed.
