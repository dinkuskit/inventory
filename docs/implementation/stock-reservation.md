# Named order-line reservations

## Decision

Inventory owns named reservation records and two awaited commands:
`stock.reserve` and `stock.release`. This is the first writer of the reserved
balance dimension. Schema v5 adds `inventory_reservations` with a partial unique
index on active `(pool_id, order_line_key)`.

## State contract

- One hold is one warehouse, one managed SKU, one positive exact quantity, and
  one public-safe order/line reference.
- Inventory mints the reservation ID.
- Reserve fails closed when available < quantity. Available is
  `onHand - reserved - outgoingTransferCommitted`.
- One active hold per pool and order/line. Matching contents return `existing`.
  Different contents reject `order_line_conflict`.
- Release cancels into durable history and returns reserved stock to available.
- The same order/line may reserve again after cancel under a new ID.
- Exact command-ID retry returns the original terminal result.

## Out of this slice

GUI, CLI, Worker transport, live Commerce checkout, packing/commit, expiry,
backorder, edit-in-place, deployment, and Woo/Katana.

## Verification

`bin/verify-stock-reservation` then `bin/verify-inventory full`.
