# Feature ownership map

This map is the repository contract for bounded Inventory feature work. A
feature owns its listed paths and reaches a migrated feature only through that
feature's public entry. The package root composes feature entries; it does not
import feature internals.

Managed SKU established the first feature-local pilot and stock adjustment
follows the same migrated boundary. Opening balance, location
registry, and stock read remain mapped at their current paths until separate
behavior-preserving migration cycles are confirmed.

| Stable feature ID | Responsibility | Owned paths | Public entry point | Allowed shared dependencies | Fixtures and tests | Quick verifier | Full verifier | Public compatibility surface | Structure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `dinkus.opening-balance` | Preview, confirm, commit, replay, conflict, reason, and immutable-receipt behavior for one initial SKU-location balance | `src/domain/opening-balance.ts`; `src/application/set-opening-balance.ts`; `src/application/preview-confirm-opening-balance.ts` | `src/index.ts` | `src/storage/inventory-store.ts`; location and managed-SKU public contracts | `tests/opening-balance/`; `scripts/verify-active-location-admission.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | opening command, preview, confirmation, result, receipt, quantity, principal, and factory exports | mapped current location |
| `dinkus.location-registry` | Permanent location identity, unique names, active/archive lifecycle, blockers, receipts, and list behavior | `src/domain/location-registry.ts`; `src/application/location-registry.ts` | `src/index.ts` | `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts`; managed-SKU public result | `tests/locations/`; `tests/helpers/location-fixture.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | location commands, records, results, receipts, normalization, execution, and list exports | mapped current location |
| `dinkus.stock-read` | Explicit one-location and all-active-location stock reads, registered-SKU active-location opening eligibility, plus mutation and receipt-history lookup | `src/domain/inventory-read.ts`; `src/application/read-inventory.ts` | `src/index.ts` | `src/domain/opening-balance.ts`; `src/domain/location-registry.ts`; `src/storage/inventory-store.ts` | `tests/inventory/`; read-back and receipt-history tests under `tests/opening-balance/` | `bin/verify-inventory quick` | `bin/verify-inventory full` | read inputs, results, normalization, errors, and read factories | mapped current location |
| `dinkus.managed-sku` | Pool-wide permanent Inventory SKU identity, visible-SKU register-or-return behavior, one-time display name, setup audit, and logical-zero admission | `src/features/managed-sku/` | `src/features/managed-sku/index.ts`; `src/index.ts` | `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/managed-sku/`; `tests/helpers/managed-sku-fixture.mjs`; `tests/cloudflare/inventory-pool.test.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | managed-SKU identity, record, command, result, validation, digest, and registration factory exports | migrated pilot |
| `dinkus.stock-adjustment` | Signed-delta preview, five-minute confirmation, exact arithmetic, atomic commit, replay/conflict, oversell warning, and immutable actor receipt | `src/features/stock-adjustment/` | `src/features/stock-adjustment/index.ts`; `src/index.ts` | `src/domain/exact-decimal.ts`; `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/stock-adjustment/`; `tests/cloudflare/stock-adjustment.test.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | adjustment command, preview, confirmation, result, receipt, errors, arithmetic, digest, and execution factory exports | migrated feature |
| `dinkus.stock-transfer` | Created transfer create/edit/cancel, dispatch, In-transit reopen, atomic whole receipt, contextual detail read, explicit Open/Done location-scoped list read, outgoing/expected/in-transit/on-hand effects, atomic replay/conflict, and immutable actor receipts | `src/features/stock-transfer/` | `src/features/stock-transfer/index.ts`; `src/index.ts` | `src/domain/exact-decimal.ts`; `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/stock-transfer/`; `tests/stock-transfer/list-stock-transfers.test.mjs`; `tests/cloudflare/stock-transfer.test.mjs`; `tests/cloudflare/inventory-pool.test.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | transfer commands, record, line and line-stock context, compact list rows, list view/scope/result and opaque pagination, receipt, warning, detail read result, errors, normalization, digest, and execution/read factories | migrated feature |
| `dinkus.stock-reservation` | Named order-line holds, fail-closed available checks, one live Not shipped hold per order/line, cancel-to-history release, full-hold pack consume at Packed, one-or-more pack-all consume, named-quantity pack-some with partially packed leftover, Katana-shaped unpack of all packed quantity on a ticket back to Not shipped, all-or-none Packed to Delivered and one-ticket Undo Delivered back to Packed, both with no stock-count change, reserved/available/on-hand effects, atomic replay/conflict, and immutable actor receipts | `src/features/stock-reservation/` | `src/features/stock-reservation/index.ts`; `src/index.ts` | `src/domain/exact-decimal.ts`; `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/stock-reservation/`; `tests/cloudflare/stock-reservation.test.mjs`; `tests/workflows/stock-reservation-real-proof-contract.test.mjs`; `tools/stock-reservation-local-proof.ts`; `tools/stock-reservation-local-sqlite-proof.mjs`; `bin/prove-stock-reservation-real` | `bin/verify-inventory quick` | `bin/verify-inventory full` | reserve, release, pack, pack-all, pack-some, unpack, deliver, and undo-deliver commands, reservation record, receipt, rejection codes, normalization, digest, and execution factories | migrated feature |
| `dinkus.checkout-inventory` | First-party whole-basket CheckoutInventoryPort: reserve only at Checkout, one trusted configured provider/pool/location binding admitted before mutation, site-bound operation identity, all basket lines held atomically or durable terminal rejection with no holds, exact operation replay, terminal release fence, fail-closed missing/ambiguous release, no independent TTL, fail-closed backorder and binding/content conflicts | `src/features/checkout-inventory/` | `src/features/checkout-inventory/index.ts`; `src/index.ts` | `src/domain/exact-decimal.ts`; `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts`; `src/features/stock-reservation/index.ts` | `tests/checkout-inventory/`; `tests/cloudflare/checkout-inventory.test.mjs`; `tests/workflows/checkout-inventory-real-proof-contract.test.mjs`; `tools/checkout-inventory-local-sqlite-proof.mjs`; `tools/checkout-inventory-local-proof.ts`; `tools/checkout-inventory-concurrency-proof.mjs`; `tools/checkout-inventory-commerce-port-proof.mjs`; `wrangler.checkout-inventory-proof.jsonc`; `bin/prove-checkout-inventory-real` | `bin/verify-inventory quick` | `bin/verify-inventory full` | CheckoutInventoryPort, StockRequest, binding, reserve/release factories, checkout command IDs, rejection codes, and receipt/result exports | migrated feature |
| `dinkus.hosted-onboarding` | Account-authorized site binding, owned-operation selection, frozen provisioning, replay-safe setup status and read-only account metadata overview; no stock ledger | `src/features/hosted-onboarding/` | `src/features/hosted-onboarding/index.ts` | zod validation; injected control-plane store and pool provisioner | `tests/hosted-onboarding/`; `tests/hosted-runtime/` | `bin/verify-inventory quick` | `bin/verify-inventory full` | connection input, authenticated principal, operation metadata, state results, overview snapshot/projection and factory | migrated feature |
| `dinkus.store-connect` | Host-attested store-control challenge, site origin/callback, PKCE S256, public proof receipt, originating-admin bind; no stock ledger or account issuance | `src/features/store-connect/` | `src/features/store-connect/index.ts`; `src/index.ts` | zod validation | `tests/store-connect/` | `bin/verify-inventory quick` | `bin/verify-inventory full` | site-origin, PKCE, proof receipt, start/token schemas, frozen `/account/connect` verification URI, authoritative `expires_at`, administrator bind helpers | migrated feature |

## Toolchain pin

- Exact `emdash@1.0.1` is the development scaffold pin with a lockfile. The
  kernel does not import EmDash; this is not a plugin runtime or
  minimum-compatible-version claim.
- Prior scaffold install proof: `proof/emdash-0.41.0-pin-20260926/`. Current sandbox proof is recorded with hosted onboarding.

## Shared kernel and adapter ownership

- `src/storage/inventory-store.ts` is the platform-neutral persistence port
  shared by application features.
- `src/domain/exact-decimal.ts` is the shared exact-arithmetic kernel used by
  stock mutations; feature-owned arithmetic may not diverge from it.
- `src/storage/local-sqlite-test-store.ts` is a disposable local-test adapter,
  never a production storage fallback.
- `src/storage/cloudflare-sqlite-inventory-store.ts` and `src/cloudflare/` are
  production adapter surfaces. They own SQLite and Durable Object mechanics,
  not domain policy.
- `tests/helpers/` may compose public feature entries with test-only adapters.

## Boundary rules

- Install type: the sandboxed Registry plugin is the supported product. A
  native entry is a developer and test setup with no features the Registry
  build lacks, except gaps the README lists (owner rule, 2026-10-08).
- A migrated feature may import its own files, declared shared dependencies,
  and another migrated feature only through that feature's `index.ts`.
- Files outside a migrated feature may reach it only through its `index.ts`.
- `src/index.ts` is the package composition root and may re-export only the
  migrated feature entry, never a feature internal.
- Existing focused `bin/verify-*` commands remain developer diagnostics.
  `bin/verify-inventory quick|full` is the canonical repository gate.
- `node scripts/check-architecture.mjs` validates this map and every governed
  import before a change is review-ready.

The feature grain is an Inventory responsibility, not a demand that shared
storage adapters be duplicated into every feature.

- `src/cloudflare/account-connections.ts` is the account-scoped SQLite control plane; it stores connection metadata only. `src/cloudflare/hosted-worker.ts` verifies access tokens before routing to account and pool objects.
- `plugins/emdash-inventory/` owns the standard sandboxed Block Kit admin plugin, including the private `plugins:manage` Connect route and the public `store-proof` receipt route. Its non-routable service/publisher defaults remain deployment integration boundaries. Website/account issuance is outside this repository.

- Opening-stock transport uses the existing opening-balance kernel; `tests/hosted-runtime/opening-stock.test.mjs` and `tests/store-connect/plugin-opening-balance.test.mjs` cover service and plugin admission/retry. `tools/opening-stock-proof*` are explicit synthetic dispatcher/workerd proof fixtures, never deployment entry points.
