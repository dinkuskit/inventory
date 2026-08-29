# Cycle 14 proof — ordinary stock adjustment

Decision: `ordinary-stock-adjustment-038`

Baseline: `git:d31fbfda982ad669f638a222f0cb1caa7592c095`

Implementation worktree:
`/home/smoky/Developer/worktrees/inventory-codex-stock-adjustment-20260829`

Branch: `codex/stock-adjustment-20260829`

Immutable reviewed source identity:
`sha256:4a3897d5f827267ef308e8620cd892f69fc66bc264af62403ffec84bd6bd469e`

The identity is the SHA-256 of `SOURCE_MANIFEST.sha256`. The manifest binds all
24 changed implementation, adapter, test, verification, architecture, and
contract-document files. `sha256sum -c` passed for every entry.

## Accepted lock

One ordinary human adjustment after opening history uses an explicit site,
pool, active location, permanent Inventory SKU identity, one non-zero signed
exact delta, one mandatory note-only reason, and one observed balance version.
Preview is non-mutating, lasts five minutes, shows exact before/after stock and
an exact reserved-order oversell warning, and permits negative results. Commit
changes only on-hand, preserves reserved, derives available, advances version,
and atomically persists one immutable trusted-actor receipt and terminal result.
Exact replay returns the original result; changed content conflicts. Corrections
create a new receipt linked by `corrects_receipt` rather than editing history.

Dependencies preserved: command/result identity, immutable receipt audit,
opening balance, confirmation, signed-in receipt actor, exact aggregate stock,
managed-SKU registration, and repository feature boundaries.

## TDD evidence

Observed red failures before implementation included:

- missing `InvalidStockAdjustmentCommandError` package export;
- missing `createConfirmStockAdjustment` application export;
- changed contents under a committed command ID incorrectly surfacing as a
  confirmation mismatch;
- stock receipt history omitting `stock.adjust`;
- preview misclassifying an unknown location as missing opening history.

Each failure was repaired at its owning boundary and rerun green before the
next increment.

## Verified behavior

- canonical signed-decimal normalization and arbitrary-precision arithmetic;
- zero-delta, blank-reason, reason-category, malformed version, and mismatched
  SKU-location rejection;
- explicit active-location, registered-SKU, unit, opening-history, and current
  version admission;
- preview non-mutation and exact five-minute principal/action/version binding;
- on-hand 10, reserved 8, delta -5 producing on-hand 5, available -3, and
  `oversoldBy=3` without blocking commit;
- negative stock admission, reserved preservation, and one-version increment;
- immutable receipt with signed-in actor, before/after quantities, reason, and
  `corrects_receipt` reference;
- exact retry after local database close/reopen, changed-content conflict,
  stale-version durable rejection, and confirmation expiry;
- atomic rollback of balance, receipt, result, and confirmation binding after
  injected post-persistence failure;
- mixed opening/adjustment stock receipt history while location lifecycle
  receipts remain excluded;
- local SQLite and Cloudflare Durable Object parity with schema remaining v3;
- package-root/feature-entry parity and enforced cross-feature export barriers.

## Commands run

```text
node --experimental-sqlite --experimental-strip-types --test tests/stock-adjustment/*.test.mjs
  -> 13 passed

bin/verify-stock-adjustment
  -> 13 Node tests passed
  -> 1 focused workerd test passed
  -> strict Cloudflare typecheck passed

git diff --check
  -> passed

bin/verify-inventory full
  -> architecture tests and audit passed
  -> strict Cloudflare typecheck passed
  -> 81 Node tests passed
  -> deployment-contract tests passed
  -> 15 workerd tests passed
  -> Wrangler dry-run passed
  -> verify-inventory full passed in 8.59s

sha256sum -c .grilltrack/proof/cycle-14/SOURCE_MANIFEST.sha256
  -> all 24 entries OK
```

## Renderer and fidelity

The faithful renderer for this platform-neutral API/storage slice is accepted
request/result flow through the real local SQLite test adapter and the real
workerd Durable Object adapter. This proof does not render a GUI and makes no
claim about EmDash authentication transport, Commerce/SmokyClub binding,
deployed Cloudflare state, or production data.

## Deferrals and gates

Deferred: Block Kit GUI, location selector UI, Commerce and SmokyClub wiring,
reservation creation/order details, auth/account deployment details, network
mutation transport, package publication, deployment, and production cutover.

No commit, push, pull request, merge, deployment, publication, account/security
action, or production mutation occurred in this implementation cycle.
