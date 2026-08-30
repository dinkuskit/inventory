# Cycle 18 proof — stock-transfer list read model

## Outcome

Implemented the six confirmed Inventory transfer-list decisions as one
platform-neutral read model:

- one explicit `open` or `done` view per query;
- one explicit active location or `all_locations` scope;
- incoming and outgoing membership for one location, with unrelated transfers
  excluded and All Locations rows never duplicated;
- current endpoint identity/name/archive metadata, one-archived visibility,
  typed unknown/archived selection outcomes, and both-archived exclusion;
- compact status-specific rows with full line/audit detail retained outside the
  list;
- lifecycle-aware Open/Done ordering with deterministic `updatedAt` and
  transfer-ID tie-breakers; and
- default 50, maximum 100, versioned opaque keyset pagination bound to pool,
  view, and scope.

Both SQLite adapters fail closed for missing endpoints, materialized-status
drift, missing terminal sort dates behind a cursor, and impossible lifecycle
date/null combinations. The existing singular read and every transfer command,
balance, receipt, and lifecycle mutation remain unchanged.

## Source identity

- fetched `origin/main`, worktree baseline, and current local `HEAD`:
  `ff6dd9de3841dd95965849c1b0221b1551929656`;
- branch: `codex/stock-transfer-list-read-20260830`;
- exact changed non-GrillTrack source manifest SHA-256:
  `4eb90a36d9bc326335d5557575c3ad37d0b33d8d62b6e3e1c98abbe633fc0e8c`;
- manifest scope: 16 changed source/test/doc/verifier files, including untracked
  files; and
- identity artifact: `SOURCE_IDENTITY.txt`.

## Verification

```text
RED/GREEN details
  .grilltrack/proof/cycle-18/RED.md
  .grilltrack/proof/cycle-18/RED_GREEN.md

bin/verify-stock-transfer
  22/22 focused Node tests passed
  18/18 focused local Cloudflare tests passed across 2 files
  Cloudflare TypeScript check passed

bin/verify-location-registry
  7/7 passed

bin/verify-inventory quick
  architecture clean
  Cloudflare TypeScript check passed
  102/102 Node tests passed before the review-repair additions

bin/verify-inventory full (final repaired source)
  architecture clean
  Cloudflare TypeScript check passed
  104/104 Node tests passed
  19/19 local Cloudflare tests passed across 3 files
  Wrangler deploy --dry-run passed
  terminal: verify-inventory full passed in 4.06s

git diff --check
  passed
```

All Cloudflare behavior ran locally through Vitest/Miniflare. Wrangler used
`--dry-run`. No Worker, route, Durable Object, database, Cloudflare account, or
production resource was created or changed.

## Exact-source review and repair

Two independent read-only reviewers inspected implementation correctness and
contract coverage. The first pass classified three `required_fix` defects:

- null terminal sort dates could be excluded forever after a Done cursor;
- materialized table status could drift from JSON status within the same view;
  and
- incompatible lifecycle date/null combinations could project as valid rows.

A separate contract review found four required proof gaps: Done keyset/tie
coverage, selected-active location with an archived opposite endpoint,
end-to-end 50/100 boundaries, and an explicit no-storage-on-invalid-input
assertion. Tests reproduced the defects before source repair. The repaired
source and expanded proof passed both focused runtimes, both reviewers confirmed
every finding resolved, and the final exact-source result is clean. See
`REVIEW.md`.

## Storage and migration decision

`InventoryStore.listStockTransfers` is an additive read port implemented by the
local SQLite test adapter and the Cloudflare SQLite Durable Object adapter.
Each reads materialized pool/status plus the complete existing transfer JSON,
joins retained location records, and applies the same keyset predicate. No
schema, migration, index, backfill, command, receipt, or Worker route changed.
Cloudflare schema v4 remains exact.

## Locks preserved

- `transfer-list-view-selection-001`: explicit independent Open or Done query.
- `transfer-list-location-scope-002`: incoming/outgoing one-location scope and
  one-row All Locations behavior.
- `transfer-list-archived-endpoint-003`: archived selector exclusion,
  one-archived visibility, and both-archived normal-list exclusion.
- `transfer-list-ordering-004`: operational Open order, terminal Done order,
  and deterministic tie-breakers.
- `transfer-list-row-summary-005`: compact status-specific row with detail and
  audit retained elsewhere.
- `transfer-list-pagination-006`: default 50, maximum 100, opaque stable keyset,
  and no offset/count/search/custom sort.

## Delivery and remaining gates

This proof is local and uncommitted. No commit, push, pull request, merge,
deployment, publication, account/security action, live-database mutation, or
production mutation occurred. Commit/push/PR delivery requires the user's next
explicit approval. Any eventual PR review verdict must bind to that committed
PR head rather than this local content hash.

Still deferred:

- Block Kit/EmDash GUI, CLI, Worker transport, and authentication;
- Commerce/Blocks/SmokyClub integration;
- partial receiving and Received reversion;
- archive-area query, search, alternate sorting, and exact total count;
- measured scale/index migration; and
- deployment, publication, and production cutover.
