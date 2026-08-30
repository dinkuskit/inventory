# Whole-transfer receipt implementation plan

## Scope

Implement the locked `transfer.receive` slice only. An exact-version
In-transit transfer is received as one atomic unit: every line's full quantity
moves from destination in-transit to destination on-hand, the transfer becomes
Received, and the signed-in actor plus automatic commit timestamp are retained
in an immutable receipt. Normal receipt accepts no reason or user-entered
actual date. Partial receipt and Received reversion remain deferred.

Baseline: `b520b5ff7189a4180ad30f8e95d4db4d80a7a6e3`.

## Module boundaries

- `src/features/stock-transfer/domain.ts` owns the new command constant, public
  command type, exact input normalization, command digest, status, result, and
  receipt contracts.
- `src/features/stock-transfer/execute.ts` owns status admission and the
  In-transit-to-Received state transition. Its existing state-difference engine
  derives all balance effects.
- `src/storage/inventory-store.ts` remains the platform-neutral atomic port.
  Its existing `commitStockTransfer` boundary already commits transfer,
  balances, receipt, and terminal command result together; its contract does
  not change.
- `src/storage/local-sqlite-test-store.ts` and
  `src/storage/cloudflare-sqlite-inventory-store.ts` retain storage mechanics.
  Only their stock-history receipt filters gain the new receipt type.
- `src/features/stock-transfer/index.ts` is the feature export barrier;
  `src/index.ts` remains the package composition root.
- No Commerce, Blocks, SmokyClub, EmDash, shared conductor, deployed Worker, or
  production database surface is in scope.

## Interface design

```ts
type ReceiveStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.receive";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: Readonly<{ transferId: string }>;
  references: readonly ExternalReference[];
  expectedVersions: readonly Readonly<{
    transferId: string;
    version: string;
  }>[];
}>;
```

The normalizer requires exactly `transferId` in `payload` and exactly one
matching positive transfer version. Extra keys such as `reason`,
`receivedDate`, line quantities, or partial-receipt fields reject before any
storage transaction. Existing `transfer_not_in_transit` expresses wrong-state
admission.

## Data flow

1. Normalize the command and signed-in principal, then digest the exact
   normalized command.
2. Enter the pool-scoped store transaction and return the original terminal
   result for an exact `commandId` replay; reject changed command contents.
3. Read the transfer and require `status === "in_transit"` plus the exact
   expected version.
   Receipt uses those already-dispatched frozen facts rather than revalidating
   the origin's current active state; otherwise an origin legitimately archived
   after dispatching all of its stock could strand destination in-transit stock.
   Destination in-transit quantities already block destination archival.
4. Build `after` by retaining shipment facts and planned/dispatch dates,
   setting `status: "received"`, `receivedDate` and `updatedAt` to the system
   commit timestamp, and incrementing the transfer version.
5. Diff existing In-transit and Received state quantities. For every line this
   yields destination `inTransit -= quantity` and `onHand += quantity`; origin
   has no receive-time effect. A physical destination on-hand receipt marks
   that SKU-location's stock history established.
6. Commit every changed balance, the Received transfer, immutable receipt, and
   terminal result through the existing single `commitStockTransfer` call.
7. Make the receipt visible in pool/location stock history in both SQLite
   adapters.

## Invariants and failure semantics

- Receipt is all-or-nothing across every SKU line; callers cannot supply a
  subset or changed quantity.
- Expected dispatch/arrival dates are retained planning data and never gate
  receipt.
- Archiving a now-empty origin after dispatch does not prevent receipt of the
  shipment already in transit.
- Origin on-hand, reservations, outgoing commitments, and availability do not
  change at receipt time.
- Destination reservations are retained; availability is recalculated from
  received on-hand minus existing reservations and outgoing commitments.
- `receivedDate === receipt.committedAt === updatedAt`; the principal is the
  normalized execution principal.
- The receipt has `type: "transfer.receive"` and no `reason` property.
- Exact replay returns the original terminal result without new time, ID, or
  effects. Reused command IDs, missing transfer, wrong status, and stale version
  return durable rejections. An injected persistence failure rolls back every
  transfer, balance, receipt, and command-result write.
- A damaged or missing physical unit is not represented by partial receipt:
  receive the whole transfer, then issue the existing destination
  `stock.adjust` command with its required typed reason.

## Implementation sequence

1. Add domain/public-entry tests for the exact command contract and observe
   their unsupported-command failure.
2. Add local durable behavior tests for whole multi-line receipt, actor/time,
   balance effects, history, replay/conflict, wrong-state/stale rejection,
   rollback, reopen read-back, and receipt-then-adjust discrepancy handling;
   observe the missing receive behavior.
3. Add Cloudflare parity assertions and observe the same failure.
4. Implement the minimum domain, execution, export, and receipt-filter changes.
5. Update feature/docs/verifier contracts without changing a schema migration.
6. Run the focused verifier and `bin/verify-inventory full`, inspect the exact
   diff, and bind the proof/review to its content hash.

## Test strategy

- Domain: accepted exact payload; trimmed identity fields; one exact version;
  reject reason, received date, partial lines, and other extra keys.
- Local SQLite: whole multi-line state/effects, destination history, existing
  destination reservations, immutable actor/time, no reason, exact replay,
  command-content conflict, missing/wrong-state/stale rejections, injected
  rollback, close/reopen read-back, location receipt history, and a full receipt
  followed by a separately reasoned destination adjustment.
- Cloudflare SQLite Durable Object: equivalent Received record, balances,
  receipt/history/replay, and unchanged schema version `4`.
- Architecture/type/public surface: feature barrier, root re-export, TypeScript
  checks, and the canonical quick/full repository verification gates.
