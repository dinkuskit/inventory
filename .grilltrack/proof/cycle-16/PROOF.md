# Cycle 16 proof — stock-transfer dispatch and reversal

## Outcome

Implemented the confirmed Inventory-owned dispatch slice:

- `transfer.dispatch` for exact-version positive Created transfers;
- automatic trusted dispatch timestamp and signed-in actor receipt;
- atomic origin on-hand decrement and outgoing-commitment release;
- atomic destination expected-to-in-transit movement;
- customer-order-priority movable stock with current-transfer exclusion;
- exact non-blocking negative-stock warning;
- `transfer.reopen` with optional free-text reason and exact inverse effects;
- immutable original dispatch plus reversal receipt history;
- stable replay, changed-command conflict, stale/wrong-state rejection, and
  rollback; and
- local SQLite plus local Cloudflare Durable Object parity without a schema
  migration.

## Source identity

- fetched `origin/main` and worktree baseline:
  `86da623e0a21f174636cd833f8faf932ba219721`;
- branch: `codex/stock-transfer-in-transit-20260830`;
- exact changed non-GrillTrack source manifest SHA-256:
  `6c84f3919a8ba74077d45cc057deb1480fe079cdca56406697360b5144f7ff6e`;
- identity artifact: `SOURCE_IDENTITY.txt`; and
- exact-source review: `REVIEW.md`.

## Delivery

- pull request: https://github.com/dinkuskit/inventory/pull/17
- implementation commit: `ff8956f38cda4da9a9380b586b753a6a488bb3bb`
- branch: `codex/stock-transfer-in-transit-20260830`

The PR is delivery and review plumbing only. Merge and deployment remain
separate human gates.

## Verification

```text
bin/verify-stock-transfer
  13/13 focused Node tests passed
  16/16 focused local Cloudflare tests passed across 2 files
  Cloudflare TypeScript check passed

bin/verify-inventory full
  architecture clean
  Cloudflare TypeScript check passed
  95/95 Node tests passed
  17/17 local Cloudflare tests passed across 3 files
  Wrangler deploy --dry-run passed
  terminal: verify-inventory full passed

git diff --check
  passed
```

All Cloudflare tests ran locally through Vitest/Miniflare. Wrangler used
`--dry-run`. No Worker, route, Durable Object, database, account, or production
resource was created or changed.

## Risk and coverage

The mutation risk is contained inside the existing stock-transfer transaction
boundary. Coverage proves exact normalization and exports; current-transfer and
other-transfer movable stock; customer-order reservations; the confirmed
negative warning; multi-SKU dispatch/reopen; automatic timestamp and immutable
actor history; optional reversal reason; close/reopen durability; receipt
history; replay/conflict; stale and wrong-status rejection; zero-line rejection;
injected rollback; both SQLite adapters; unchanged Cloudflare v4 schema; and
full repository compatibility.

## Gates and deferrals

No commit, push, pull request, merge, deployment, publication, account/security
action, live-database mutation, or production mutation occurred. Deferred by
confirmed scope:

- whole-transfer Received execution and automatic received timestamp;
- partial receiving and Received reversion;
- Block Kit/EmDash GUI and authentication transport;
- Commerce/Blocks/SmokyClub integration;
- package publication, deployment, and production cutover.

Official review-rail proof must be rerun against the eventual PR head before
merge. Delivery remains a separate human gate.
