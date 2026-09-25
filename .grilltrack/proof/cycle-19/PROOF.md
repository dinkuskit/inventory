# Cycle 19 proof — order-reservation kernel

## Outcome

Implemented the five confirmed reservation decisions as one platform-neutral
kernel:

- named holds with Inventory-minted IDs;
- fail-closed available checks;
- one active hold per pool and order/line;
- cancel-to-history release;
- schema v5 reservation records on local SQLite and Cloudflare SQLite.

`stock.reserve` and `stock.release` are awaited, idempotent, actor-bearing
commands. They write reserved stock and derived available. They do not pack,
expire, backorder, expose a Worker route, or talk to Commerce.

## Source identity

- worktree baseline and current local `HEAD`:
  `61bc604d03d9b482b05daaa3647c84c77ce4fdb3`;
- branch: `grill/order-reservations-20260925`;
- exact changed source manifest SHA-256:
  `ffa25e3975d6c401474f69499a82df004d6fd65d5fd6deb682522136fa3e278b`;
- identity artifact: `SOURCE_IDENTITY.txt`.

## Verification

```text
bin/verify-stock-reservation
bin/verify-inventory full
```

`bin/verify-inventory full` passed on this worktree: architecture clean,
typecheck, 112 Node tests, 20 Cloudflare tests, Wrangler dry-run.

Node reservation tests proved hold, fail-closed available, uniqueness,
cancel-to-history, new ID after cancel, and outgoing-transfer reducing
reservable stock. Cloudflare proved reserve/release parity on schema v5.
Existing transfer and adjustment tests now expect schema history `[5]`.

## Locks preserved

- `reservation-domain-001`
- `reservation-record-002`
- `reservation-availability-003`
- `reservation-uniqueness-004`
- `reservation-cancel-005`

Prior opening, location, SKU, adjustment, and transfer locks remain represented.

## Remaining gates and deferrals

Still deferred:

- packing/commit, expiry, backorder, edit-in-place;
- Block Kit GUI, CLI, Worker transport/authentication;
- live Commerce checkout;
- deployment, publication, and production cutover.

This proof is local implementation evidence only. It does not authorize commit,
push, PR, merge, or deploy.

## Real runtime transcript

ClawSweeper asked for inspectable reserve, conflict, release, and v4-to-v5
upgrade evidence outside the test harness. `npm run proof:stock-reservation:real`
ran local SQLite plus `wrangler dev --local`. Transcript:
`.grilltrack/proof/cycle-19/REAL_RUNTIME_TRANSCRIPT.txt`.

Observed: reserve `rsv_proof_hat` quantity 3; same-line quantity 4 rejected
`order_line_conflict`; release canceled; exact reserve command replayed after
restart; schema history `[4, 5]`; reserved returned to `0` available `10`.
