# Stock-transfer dispatch and reversal implementation plan

Baseline: `origin/main` at `86da623e0a21f174636cd833f8faf932ba219721`.

## Scope

Implement the platform-neutral Inventory-owned `Created -> In transit` command
and the exact `In transit -> Created` correction command. Preserve atomic,
awaited, idempotent, version-bound command behavior and immutable receipts.
Receiving, partial receiving, GUI, service authentication, deployment, and
production mutation remain out of scope.

## Public command contract

- `transfer.dispatch`
  - payload: exactly `{ transferId }`;
  - expected versions: exactly the named transfer and its positive version;
  - admitted only for an existing `created` transfer with every line greater
    than zero;
  - the transition timestamp is supplied only by the trusted `now()`
    dependency and becomes both `dispatchedDate` and the receipt `committedAt`.
- `transfer.reopen`
  - payload: exactly `{ transferId, reason }`, where `reason` is a trimmed
    free-text string or `null`;
  - expected versions: exactly the named transfer and its positive version;
  - admitted only for an existing `in_transit` transfer;
  - the current `dispatchedDate` is cleared, while the earlier dispatch receipt
    and the new reversal receipt remain immutable.

Both commands bind idempotency to the normalized full envelope. Exact replay
returns the original terminal result. Reusing a command ID with changed content
returns `command_id_conflict`. A stale transfer version is durably rejected.

## State and balance transitions

Dispatch commits one transaction containing the transfer, every balance,
receipt, and terminal result:

- origin `outgoingTransferCommitted -= quantity`;
- origin `onHand -= quantity`;
- destination `expected -= quantity`;
- destination `inTransit += quantity`;
- transfer status becomes `in_transit`, version increments, shipment facts
  freeze, and the automatic dispatch timestamp is recorded.

Reopen commits the exact inverse in one transaction:

- origin `onHand += quantity`;
- origin `outgoingTransferCommitted += quantity`;
- destination `inTransit -= quantity`;
- destination `expected += quantity`;
- destination on-hand is unchanged;
- transfer status becomes `created`, version increments, and the current
  dispatch timestamp is cleared.

Available is always re-derived as
`onHand - reserved - outgoingTransferCommitted`. Reopen validates that stored
planning/in-transit quantities cannot be driven below zero.

## Read and warning contract

The stock-transfer read result gains per-line stock context for the future GUI:

- origin movable stock excludes customer reservations and other outgoing
  transfers, but adds the current Created transfer quantity back so it is not
  counted twice;
- quantity to move;
- destination current on-hand;
- projected origin available after this transfer;
- `available` or `not_available`.

Dispatch remains allowed when projected origin available is negative. The
committed result carries `negative_available` with the projected negative
quantity and reserved-order quantity. For the confirmed example it says:
`This transfer will leave you with -3 stock. 8 are reserved for orders.`

## Compatibility and failure behavior

The v4 SQLite schema already stores all required balance dimensions and permits
`in_transit`, so there is no v4-to-v5 migration. Both SQLite adapters reuse the
existing optimistic transfer update and multi-balance transaction boundary.
Receipt-history filters must admit the two new receipt types.

Tests must prove normalization, exports, exact transitions, negative warning,
customer-order priority, replay/conflict, stale version, invalid status,
zero-line rejection, immutable actor/timestamp history, close/reopen,
transaction rollback, local SQLite behavior, and Cloudflare Durable Object
parity.
