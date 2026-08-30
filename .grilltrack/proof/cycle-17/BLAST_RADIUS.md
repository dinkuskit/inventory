# Whole-transfer receipt blast-radius analysis

Baseline: `b520b5ff7189a4180ad30f8e95d4db4d80a7a6e3`.

## Directly affected

| Surface | Change | Risk | Proof |
| --- | --- | --- | --- |
| `src/features/stock-transfer/domain.ts` | Add `transfer.receive`, its exact command type, and union/normalizer support | Medium: an ambiguous payload could bypass the whole-transfer lock | Domain rejection tests and digest/replay tests |
| `src/features/stock-transfer/execute.ts` | Admit only In-transit, set Received/time/version, and establish destination history | High: wrong deltas could duplicate or lose stock | Multi-line balance/effect assertions and injected rollback |
| `src/features/stock-transfer/index.ts`; `src/index.ts` | Export constant and command type through both barriers | Low | Public-entry and typecheck proof |
| Both SQLite inventory stores | Include receive receipts in stock-history queries | Medium: movement could commit but disappear from audit views | Local and Cloudflare location-history assertions |
| `tests/stock-transfer/`; `tests/cloudflare/stock-transfer.test.mjs` | Add contract, durability, and parity coverage | Low | Focused verifier |
| Feature/docs/verifier contracts | Describe Received behavior and new proof | Low | Architecture check and exact-source review |

## Confirmed unchanged boundaries

- `InventoryStore.commitStockTransfer` already carries previous/next transfer,
  every balance mutation, immutable receipt, and terminal result through one
  transaction. No port change is required.
- Both transfer tables already allow `received`; balance tables already contain
  on-hand, expected, in-transit, version, and history columns. Schema version 4
  remains sufficient, so no migration is added.
- `stateQuantitiesFor` already models the correct In-transit and Received
  quantities. The transition naturally leaves origin unchanged and produces
  only destination on-hand/in-transit deltas.
- Read-by-transfer-ID stores the full transfer JSON and already returns a
  Received record. No new read API or Done/Open listing API is introduced.
- Adjustment remains a separate public feature reached through its export
  barrier; receipt does not import or orchestrate adjustment internally.

## Downstream and caller risk

- The command union widens. Exhaustive TypeScript callers may need to recognize
  `transfer.receive`; repository typechecks expose missed switches.
- Receipt type widens through `StockTransferCommandV1["type"]`; inventory stock
  history must not omit it. Both adapter filters are explicit allowlists and
  therefore require parallel edits.
- Destination `hasStockHistory` changes from false to true on first physical
  receipt. Opening-balance preview must consequently report already-established
  stock there; this is the confirmed business invariant and needs a regression
  assertion.
- Received records are final for this slice. Existing update, cancel, dispatch,
  reopen, and repeat-receive commands must reject through their current
  state-specific codes without changing any balances.
- No cross-repository consumer is changed or required. Commerce and Blocks can
  remain on their merged contracts; EmDash scheduler/materialization work is
  unrelated.

## Failure-mode matrix

| Failure | Required outcome |
| --- | --- |
| Missing transfer | Durable `transfer_not_found`; no balance/receipt writes |
| Created, Received, or Canceled target | Durable `transfer_not_in_transit`; no effects |
| Stale expected version | Durable `stale_version`; no effects |
| Exact command replay | Original terminal result byte-for-byte; no new IDs/time |
| Same command ID, changed contents | `command_id_conflict`; original result retained |
| Extra reason/date/partial payload keys | Domain normalization error before transaction |
| Multi-line persistence failure | Roll back all line balances, transfer, receipt, and command result |
| Existing destination reservations | Preserve reserved; recalculate available from new on-hand |
| First destination physical stock | Set `hasStockHistory: true` atomically with receipt |
| Physical shortage/damage | Whole receipt succeeds; separate reasoned adjustment records discrepancy |
| Origin archived after dispatching all stock | Receive the already-frozen shipment; do not strand destination in-transit stock |

## Verification plan

1. Capture baseline `bin/verify-stock-transfer` result; local tests pass and the
   fresh worktree lacks installed Cloudflare dev dependencies.
2. Capture RED from focused new Node tests before production edits.
3. Reuse an exact-lockfile-compatible local dependency installation for
   Cloudflare/typecheck proof without contacting or mutating a deployed Worker.
4. Run `bin/verify-stock-transfer` after implementation.
5. Run `node scripts/check-architecture.mjs`, package typechecks, and
   `bin/verify-inventory full`.
6. Inspect `git diff --check`, exact changed paths, content hash, and ledger
   state before marking decisions implemented/verified.
