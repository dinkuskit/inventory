# GrillTrack cycle 12 managed-SKU alignment and migration proof

- track: `dinkuskit-inventory-v1`
- repaired decisions: `managed-sku-registration-036`,
  `fresh-schema-initialization-034`
- re-verified dependent: `opening-balance-location-admission-035`
- Inventory base: `e32ac165cae5efd78390bee1f0306754aa7fabbb`
- Commerce contract source: `7b09a25749ce2c650f294a0bd5ab7d99132d2ce5`
- branch: `codex/managed-sku-registration-20260828`
- PR: `https://github.com/dinkuskit/inventory/pull/12`
- repaired source identity:
  `sha256:fdc7950c5cbed32bfd552d866bf731346a0429ca40924ce137017b4019c68355`
- source manifest: `.grilltrack/proof/cycle-12/SOURCE_MANIFEST.sha256`

## Why the decision was reopened

The original PR #12 head used the Commerce-visible SKU directly as Inventory's
record identity, rejected a second registration, stored no display name, created
a registration receipt, and accepted only fresh schema v3. Commerce main had
since verified and merged a different provider-neutral handshake: permanent
opaque `inventorySkuId`, visible SKU lookup, one-time display name, and
`registered | existing` outcomes. ClawSweeper independently demonstrated that
the fresh-only initializer rejected exact committed schema v2.

Both findings were classified `required_fix`. Bobby approved the reconciliation:
retain immutable setup actor/time audit but create no stock receipt for identity
registration, and support an atomic exact-v2 upgrade.

## Implemented contract

- New `sku.register` accepts explicit pool, visible `sku`,
  `displayNameIfNew`, unit `each`, stable command ID, and trusted execution
  principal.
- A new visible SKU atomically mints a permanent opaque `inventorySkuId`, stores
  the one-time independent display name and setup audit, and stores a terminal
  `registered` result. It creates no balance or receipt.
- A different command for the same visible SKU atomically stores and returns an
  `existing` result with the original `{ inventorySkuId, sku, displayName }`.
  It ignores the proposed new display name, mints no ID, and creates no receipt.
- Exact command replay returns the original terminal result. Changed normalized
  contents under one command ID return `command_id_conflict`.
- Stock reads, opening previews, and opening commands use the permanent
  Inventory identity carried by the existing `skuId` field. Supplying the
  visible Commerce SKU does not resolve stock.
- The local test schema advances to `opening-balance-local/v6` with pool-unique
  visible SKU and permanent-ID constraints.

## Atomic Cloudflare v2-to-v3 upgrade

The initializer now distinguishes empty, exact v2, exact v3, and incompatible
storage. Empty storage creates v3 with history `[3]`. Exact six-table v2 with
history `[2]` atomically creates `inventory_skus`, preserves every predecessor
row, backfills each legacy balanced key using that exact key as its permanent ID
and temporary visible/name fallback, appends version 3, and validates history
`[2, 3]`. Exact v3 is idempotent.

Backfill accepts only one consistent `each` unit for a legacy identity. The
workerd rollback case proves that conflicting units leave history `[2]`, the
legacy balances, and absence of `inventory_skus` unchanged. Version 1, partial,
extra-table, and otherwise incompatible shapes remain fail-closed.

Runtime artifact:

- `.grilltrack/proof/cycle-12/V2_TO_V3_WORKERD_RUNTIME.txt`
- SHA-256:
  `34af1696e853138c9810371b6adf073fcd8315b0c6e96ef1f0f857da0af7e0c9`

## Test-driven evidence

The new registration-alignment tests were written before production repair and
first failed all three cases with:

```text
TypeError: createReceiptId is required.
```

The exact-v2 workerd test was also written first and failed with:

```text
Error: Cloudflare Inventory storage uses an older or incompatible schema.
```

The minimal domain, application, adapter, and migration changes then made those
focused tests pass. Running the full suite exposed all old fixtures still using
the superseded direct-SKU registration contract; the shared fixture and focused
registration tests were updated without weakening opening/read admission.

## Verification

- `npm test` — 64 Node tests and 14 workerd Cloudflare tests passed.
- `npm run verify:managed-sku` — 7 managed-SKU, 3 aggregate-read, 14
  Cloudflare runtime tests, and strict Cloudflare typecheck passed.
- `npm run verify:cloudflare-storage` — typecheck, deployment-contract tests,
  14 Cloudflare runtime tests, and Wrangler dry-run passed.
- focused v2 upgrade/rollback command — 2 passed, 12 skipped.
- broad strict NodeNext TypeScript compile from `src/index.ts` — passed.
- `git diff --check` — passed.
- GrillTrack ledger validation — passed.
- `sha256sum -c .grilltrack/proof/cycle-12/SOURCE_MANIFEST.sha256` — all
  manifest entries passed.

Behavioral proof covers new and existing registration outcomes, hidden-ID
minting, visible-SKU uniqueness, first-name preservation, actor/time audit,
absence of registration receipts, exact replay, changed-content conflict,
generated-ID collision rollback, local close/reopen, logical-zero reads by
hidden identity, opening admission, pool isolation, exact v2 preservation,
legacy backfill, migration idempotency, conflicting-unit rollback, v1 rejection,
fresh v3 initialization, schema record counts, and all earlier location,
opening-balance, receipt-history, and read regressions.

## Fidelity and gates

The migration proof runs the actual Cloudflare workerd Durable Object SQLite
runtime through `@cloudflare/vitest-plugin`; it is not an in-memory mock. It
proves source behavior against disposable test objects, not a deployed Worker or
live database. No Cloudflare account, credential, customer data, production
pool, remote database, storefront, or physical stock was accessed or mutated.

No Commerce, Blocks, SmokyClub, EmDash, x-api, or shared review-conductor source
was modified. No UI, provider adapter, public route, deployment, publication,
merge, production mutation, reservation, or ordinary stock adjustment is part
of this repair.

## Next safe sequence

After PR #12 passes exact-head external review and Bobby separately authorizes
merge, the confirmed ordinary stock-adjustment slice can start from the merged
Inventory identity contract. Commerce's real adapter and persisted registration
orchestration can then target this register-or-return boundary before any admin
UI or broader EmDash integration.
