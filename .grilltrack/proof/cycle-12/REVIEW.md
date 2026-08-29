# GrillTrack cycle 12 repaired exact-source review

- source identity:
  `sha256:fdc7950c5cbed32bfd552d866bf731346a0429ca40924ce137017b4019c68355`
- manifest: `.grilltrack/proof/cycle-12/SOURCE_MANIFEST.sha256`
- Inventory baseline: `git:e32ac165cae5efd78390bee1f0306754aa7fabbb`
- Commerce contract source: `git:7b09a25749ce2c650f294a0bd5ab7d99132d2ce5`
- result: clean local standards and source-intent review
- remaining local findings: none

## Superseded verdict and repaired findings

The earlier local-clean verdict at source identity
`sha256:65e909821319e3e6e069d9dcee58a3b33d134e81546e3612b87641c450e9475b`
is superseded. Exact Commerce-main inspection and the ClawSweeper review of PR
#12 exposed two required fixes:

1. registration used the visible Commerce SKU as Inventory identity, rejected
   an already-present visible SKU, and stored no independent Inventory name;
2. schema v3 rejected the exact committed v2 Durable Object shape instead of
   migrating it.

Both findings are resolved in the repaired manifest. This review does not rely
on the superseded verdict.

## Manifest verification

The 40-entry source manifest hash matches the recorded source identity and
`sha256sum -c` passes. It covers repository instructions, product locks,
architecture, command and receipt contracts, schema policy, public types,
application code, both SQLite adapters, focused and regression tests, verifier,
and Cloudflare configuration.

## Standards review

Passed.

- Work remains isolated in the existing PR worktree based on fetched Inventory
  `origin/main` at the exact baseline above. The ordinary Inventory checkout is
  untouched.
- No Commerce, Blocks, SmokyClub, EmDash, x-api, or shared review-conductor
  source was modified.
- The repaired architecture and blast radius were written before production
  changes.
- Strict TDD captured the registration dependency failure and exact-v2 schema
  rejection before their minimal repairs.
- The package remains private at `0.0.0`; there is no public HTTP route, second
  stock writer, fallback ledger, deployment, account, credential, or production
  mutation.
- The local and Cloudflare SQLite implementations satisfy the same additive
  store contract.
- Full regressions, focused verifiers, strict typechecks, broad platform-neutral
  compilation, diff validation, ledger validation, and manifest validation pass.

## Commerce contract alignment review

Passed against the exact Commerce source above.

- A new visible SKU atomically mints an opaque permanent `inventorySkuId` and
  returns `registered` with `{ inventorySkuId, sku, displayName }`.
- A visible SKU already present in the selected pool atomically stores and
  returns `existing` with the original identity. The later title proposal is
  ignored, so Commerce cannot rename an existing Inventory record.
- Registration persists `displayNameIfNew` only for the first record, and also
  freezes the trusted signed-in principal and registration time as setup audit
  metadata.
- Registration changes identity state, not stock. It creates no balance and no
  stock receipt.
- Exact command replay returns the original terminal result without invoking ID
  generation again. Reusing the command ID with changed normalized contents
  returns `command_id_conflict` and preserves the first result.
- Pool-scoped primary and unique constraints protect both the permanent
  identity and visible SKU. A generated-ID collision rolls the new command back.
- Existing stock APIs continue to carry the field name `skuId`, but now resolve
  only the permanent Inventory identity. The visible Commerce SKU does not
  resolve balances, previews, or opening commands.

The Inventory result includes its normal command envelope and command ID. A
future Commerce adapter can normalize the inner `outcome` and `inventorySku`
exactly as Commerce main specifies; this PR intentionally adds no transport or
adapter code.

## Durable Object migration review

Passed against the exact Inventory v2 source at the baseline above.

- Empty storage creates complete v3 directly and records history `[3]`.
- The exact six-table v2 shape with history `[2]` enters one synchronous Durable
  Object storage transaction, creates the registry, backfills all identities
  present in balances, appends version 3, and validates history `[2, 3]`.
- Each backfilled record keeps the legacy balance `sku_id` as the permanent ID
  and uses the same value as the temporary visible SKU and display name. This
  preserves every existing stock reference without rewriting receipts,
  commands, or balances.
- Backfill accepts only one consistent `each` unit per pool and identity. A
  conflicting-unit fixture proves the transaction rolls back to history `[2]`,
  preserves both balance rows, and leaves no registry table.
- Commands, receipts, confirmations, locations, and balances are preserved by
  exact workerd runtime proof; a second initializer call is idempotent.
- Exact v3 accepts either fresh history `[3]` or upgraded history `[2, 3]`.
  Version 1, partial, extra-table, and otherwise incompatible shapes fail closed.

The migration test uses the repository's Cloudflare workerd Durable Object
SQLite runtime, not an in-memory substitute. It proves disposable local runtime
behavior only; it makes no live-database or deployment claim.

## Blast radius and exclusions

The public surface additively changes managed-SKU registration types and the
shared store interface. Registration no longer participates in the receipt
union. Opening-balance and aggregate-read admission become intentionally tied
to the permanent Inventory identity. Both storage adapters, all repository-owned
callers, fixtures, exports, and verification entry points were inspected and
pass.

No GUI, Commerce provider adapter, binding persistence, pool discovery, OAuth,
deployment, publication, reservation, fulfillment, ordinary stock adjustment,
or production data is part of this repair.

No local `required_fix`, `reject_false_positive`, `defer`, or `human_gate`
finding remains for this source identity. An official external review must bind
its verdict to the final pushed PR head; this local review does not substitute
for that rail.
