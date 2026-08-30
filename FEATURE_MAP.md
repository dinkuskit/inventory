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
| `dinkus.stock-read` | Explicit one-location and all-active-location stock reads plus mutation and receipt-history lookup | `src/domain/inventory-read.ts`; `src/application/read-inventory.ts` | `src/index.ts` | `src/domain/opening-balance.ts`; `src/domain/location-registry.ts`; `src/storage/inventory-store.ts` | `tests/inventory/`; read-back and receipt-history tests under `tests/opening-balance/` | `bin/verify-inventory quick` | `bin/verify-inventory full` | read inputs, results, normalization, errors, and read factories | mapped current location |
| `dinkus.managed-sku` | Pool-wide permanent Inventory SKU identity, visible-SKU register-or-return behavior, one-time display name, setup audit, and logical-zero admission | `src/features/managed-sku/` | `src/features/managed-sku/index.ts`; `src/index.ts` | `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/managed-sku/`; `tests/helpers/managed-sku-fixture.mjs`; `tests/cloudflare/inventory-pool.test.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | managed-SKU identity, record, command, result, validation, digest, and registration factory exports | migrated pilot |
| `dinkus.stock-adjustment` | Signed-delta preview, five-minute confirmation, exact arithmetic, atomic commit, replay/conflict, oversell warning, and immutable actor receipt | `src/features/stock-adjustment/` | `src/features/stock-adjustment/index.ts`; `src/index.ts` | `src/domain/exact-decimal.ts`; `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/stock-adjustment/`; `tests/cloudflare/stock-adjustment.test.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | adjustment command, preview, confirmation, result, receipt, errors, arithmetic, digest, and execution factory exports | migrated feature |
| `dinkus.stock-transfer` | Created transfer create/edit/cancel/read, editable unique reference, outgoing commitment, destination expected stock, atomic replay/conflict, and immutable actor receipts | `src/features/stock-transfer/` | `src/features/stock-transfer/index.ts`; `src/index.ts` | `src/domain/exact-decimal.ts`; `src/domain/opening-balance.ts`; `src/storage/inventory-store.ts` | `tests/stock-transfer/`; `tests/cloudflare/stock-transfer.test.mjs`; `tests/cloudflare/inventory-pool.test.mjs` | `bin/verify-inventory quick` | `bin/verify-inventory full` | transfer commands, record, line, result, receipt, warning, read result, errors, normalization, digest, and execution/read factories | migrated feature |

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
