# Cycle 17 proof — whole-transfer receipt

## Outcome

Implemented the confirmed Inventory-owned receipt slice:

- `transfer.receive` for an exact-version In-transit transfer;
- atomic whole-transfer receipt of every line and full frozen quantity;
- destination in-transit removal and matching on-hand increase;
- destination physical stock-history establishment with origin unchanged;
- Received/Done status with retained planned and dispatched facts;
- trusted automatic received timestamp and signed-in actor receipt;
- no normal reason, actual-date, partial-line, or partial-quantity input;
- a separately reasoned linked destination adjustment for damage or shortage;
- stable replay, changed-command conflict, missing/stale/wrong-state rejection,
  and complete rollback; and
- local SQLite plus local Cloudflare Durable Object parity without a schema
  migration.

An already-dispatched shipment remains receivable when an origin that sent all
of its stock was archived afterward. Receipt uses the frozen shipment facts so
destination in-transit stock cannot be stranded.

## Source identity

- fetched `origin/main` and worktree baseline:
  `b520b5ff7189a4180ad30f8e95d4db4d80a7a6e3`;
- branch: `codex/stock-transfer-received-20260830`;
- exact changed non-GrillTrack source manifest SHA-256:
  `2ea7057c54423eecbf8b5d13930a4055a6f19c947cceab6a65ae926cc4bd9f00`;
- identity artifact: `SOURCE_IDENTITY.txt`; and
- exact-source review: `REVIEW.md` after adjudication.

## Delivery

No delivery action occurred. There is no commit, push, pull request, merge,
deployment, publication, account/security action, live-database mutation, or
production mutation. The isolated local worktree and branch remain
uncommitted. Delivery requires separate explicit approval.

## Verification

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/domain.test.mjs \
  tests/stock-transfer/public-entry.test.mjs \
  tests/stock-transfer/received-stock-transfer.test.mjs
  RED: 9 tests; 3 passed; 6 failed for the missing receive command/export
  GREEN: 9/9 passed

bin/verify-stock-transfer
  17/17 focused Node tests passed
  17/17 focused local Cloudflare tests passed across 2 files
  Cloudflare TypeScript check passed

bin/verify-opening-balance
  35/35 Node tests passed
  active-location behavior probe passed

bin/verify-stock-adjustment
  13/13 Node tests passed
  1/1 local Cloudflare test passed
  Cloudflare TypeScript check passed

node scripts/check-architecture.mjs
  inventory_architecture=clean

node --test tests/workflows/repository-architecture.test.mjs
  3/3 passed

bin/verify-inventory full
  architecture clean
  Cloudflare TypeScript check passed
  99/99 Node tests passed
  18/18 local Cloudflare tests passed across 3 files
  Wrangler deploy --dry-run passed
  terminal: verify-inventory full passed in 10.41s

git diff --check
  passed
```

All Cloudflare behavior ran locally through Vitest/Miniflare. Wrangler used
`--dry-run`. No Worker, route, Durable Object, database, Cloudflare account, or
production resource was created or changed. The fresh worktree temporarily
reused the exact-lockfile-compatible dependency tree from the already-proven
prior Inventory worktree; that local symlink was removed after verification.

## Risk and coverage

The mutation remains inside the existing serialized `commitStockTransfer`
boundary. Coverage proves strict input keys and one exact transfer version;
two-line destination effects; retained reservations and derived availability;
unchanged origin balances and versions; physical-history activation; blocked
late opening balance; separate linked adjustment; immutable actor/time and
receipt; exact replay; command-content conflict; missing, Created, Canceled,
stale, and already-Received rejection; local injected rollback; Cloudflare
receipt-collision rollback; destination-only receipt history; close/reopen
read-back; archived-origin completion; both SQLite adapters; unchanged
Cloudflare schema v4; public export barriers; and full repository compatibility.

## Locks preserved

- `transfer-whole-receipt-043`: all lines and full quantities commit together.
- `transfer-lifecycle-dates-051`: planned, dispatched, and received dates are
  retained with their distinct meanings.
- `transfer-user-entered-actual-dates-052`: the trusted command commit supplies
  the actual received timestamp; callers cannot backdate or future-date it.
- `transfer-lifecycle-with-expected-053`: destination in-transit becomes
  destination on-hand at receipt while origin remains unchanged.
- `transfer-receive-command-058`: exact-version, idempotent, atomic, receipt-
  backed execution and stable failure semantics.
- `transfer-receive-discrepancy-059`: normal receive has no reason; a physical
  discrepancy is a separate destination adjustment with its required reason.

## Deferrals and remaining gates

Deferred by confirmed scope:

- partial receiving;
- Received transfer reversion;
- Block Kit/EmDash GUI and authentication transport;
- Commerce/Blocks/SmokyClub integration;
- runtime mutation exposure, package publication, deployment, and production
  cutover.

Official review-rail proof must be run against any eventual committed PR head
before merge. Commit, push, PR creation, merge, and every production action
remain separate human gates.
