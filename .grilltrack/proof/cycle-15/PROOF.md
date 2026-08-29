# Cycle 15 proof — Created stock transfer

## Outcome

Implemented the confirmed Inventory-owned Created transfer slice:

- durable zero-quantity Open drafts;
- permanent opaque transfer IDs and editable pool-unique `ST-...` references;
- explicit active origin/destination and permanent Inventory SKU identities;
- optional note plus expected dispatch/arrival dates;
- atomic origin outgoing commitments, destination expected stock, and derived
  availability;
- full Created edit/rebalance and durable Canceled/Done history;
- immutable actor receipts, exact replay, changed-command conflict, stale
  versions, stable business rejection, and rollback;
- all six quantities in stock reads and location archive blockers;
- local SQLite v7 and Cloudflare Durable Object SQLite v4; and
- safe `Set Initial Stock` coexistence with a destination planning row.

## Source identity

- stacked baseline: `d735b180b3f4ed911667586f5131ff1727e46546`
  (PR #14 head at branch creation);
- fetched `origin/main`: `d31fbfda982ad669f638a222f0cb1caa7592c095`;
- branch: `codex/location-transfer-20260829`;
- exact non-GrillTrack source diff SHA-256:
  `9b9a8f705b9361d6ee919217aed8fb28ce1896f99ced6755868a52fb8839d58f`;
- identity artifact: `SOURCE_IDENTITY.txt`; and
- review: `REVIEW.md`.

## Verification

```text
bin/verify-stock-transfer
  8/8 focused Node tests passed
  16/16 focused workerd tests passed across 2 files
  Cloudflare TypeScript check passed

bin/verify-inventory full
  architecture clean
  Cloudflare TypeScript check passed
  89/89 Node tests passed
  17/17 workerd tests passed across 3 files
  Wrangler deploy --dry-run passed
  terminal: verify-inventory full passed

git diff --check
  passed
```

All workerd/Miniflare and Wrangler commands were local. Wrangler used
`--dry-run`; no Worker, route, database, or other Cloudflare resource was
created or changed.

## Risk and coverage

This is a high-blast-radius source change because it extends the public balance
and receipt contracts, both SQLite adapters, stock reads, adjustment
arithmetic, location archive admission, and Cloudflare migration state.
Coverage includes exact command normalization, zero drafts, positive planning,
negative warnings, metadata-only warning retention, multi-SKU destination
replacement, ordinary-adjustment coexistence, planning-row opening balance,
stale versions, reference retention after cancel, restart read-back, injected
rollback, v3-to-v4 and v2-to-v4 preservation, runtime create/update/cancel, and
fresh v4 initialization.

## Gates and deferrals

No merge, deployment, publication, account/security action, production
mutation, or live database action occurred. Deferred by confirmed scope:

- In-transit execution and In-transit-to-Created reversal;
- Received execution and whole-transfer receipt;
- partial receiving and Received reversion;
- Block Kit/EmDash GUI and authentication transport;
- Commerce/Blocks/SmokyClub integration;
- package publication and production rollout.

Official review-rail proof must be rerun against the eventual PR head before
merge. Merge remains a separate human gate.
