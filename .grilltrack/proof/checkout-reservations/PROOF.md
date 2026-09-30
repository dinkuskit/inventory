# Checkout whole-basket reservations

Branch `codex/inventory-checkout-reservations-20260930` refreshed onto
`git:1942e347040ffa398bf9c80d5695815bc5e0b9f9` (origin/main after merge #33).
Refreshed head `git:229728838388639307aa52dd2dd8bd8ffba2f981`. Original
unpublished local source `git:220a8a1e475579aeaa615158d830082cee7ab470` is
preserved in the ignored run packet. Commerce port compatibility checked
against public source SHA `1cb55c756ef746bcb042b9679dc43b57e67bcb0d`.
Runtime Node v22.23.1. Curated 2026-09-30T14:43:45Z.

## Storage distinction

- **Actual local SQLite:** file-backed `BEGIN IMMEDIATE` store, close/reopen,
  injected rollback after batch write, two connections, and two OS processes.
- **Post-commit lost response:** wrap `runTransaction` so the original method
  commits, capture the durable result, then throw once after `COMMIT`. Public
  port returns `unknown`; restart/replay recovers the same stored result.
- **Actual Cloudflare workerd:** local Wrangler Durable Object SQLite with
  persist/restart, scarce-stock concurrency, terminal release fence, first-call
  and factory-restart binding mismatch, and a second isolated workerd pool.
  Not re-run in this test-only follow-up.
- **Not used as proof:** in-memory mocks, fake port doubles, or remote
  deploy.

## Commands

| Command | Exit | Role |
| --- | --- | --- |
| `node --experimental-sqlite --experimental-strip-types --test tests/checkout-inventory/*.test.mjs` | 0 | focused Node behavior (22/22) |
| `bin/verify-checkout-inventory` | 0 | focused feature gate, including workerd Vitest and Commerce assignability |
| `bin/verify-inventory full` | 0 | **PASS** — architecture, typecheck, plugin typecheck, 175 Node tests, Vitest 5 files / 28 tests, hosted Vitest 1 file / 3 tests, plugin bundle |
| `bin/prove-checkout-inventory-real` | not rerun | test-only follow-up; prior refresh proof remains |

## Observed

- Whole basket reserved atomically; one short SKU rejected with reserved `0`.
- Exact replay after SQLite close/reopen and after Wrangler restart.
- Duplicate reserve/release replay the original result without a second
  mutation. That test no longer claims lost-response behavior.
- Lost reserve response: public port `unknown` after a committed hold; file
  close/reopen and exact configured provider/pool/location + site factory
  replay return the captured `readCommand` result, receipt, and reservation
  IDs with the whole basket still held.
- Lost release response: public port `unknown` after committed fence and
  stock return; delayed reserve cannot reacquire; restart/replay returns the
  original terminal result/receipt; reserved balances stay `0`; no duplicate
  mutation receipts or holds.
- Precommit transaction interruption still rolls back every basket hold and
  is distinct from post-commit response loss.
- Terminal release fenced later reserve; named-hold release still allows a
  new named hold.
- Two connections and two processes: one reserved, one rejected; no oversell.
- Public factory rejects first-call and post-restart binding mismatch,
  including `providerRef` `some.other.provider`, without incrementing reserved
  stock.
- Changed `siteId` cannot recover or mutate another site's hold; same-site
  principal change still recovers the original result.
- Operation/SKU line keys stay distinct when either ID contains a colon.
- Release fails closed for missing or ambiguous reservation rows instead of
  reporting released while reserved stock remains.
- Commerce `CheckoutInventoryPort` / `StockRequest` assignability passed
  against the accepted public source SHA.
- Hosted onboarding module, Registry plugin, and hosted proofs remained in
  place; new-base lockfile stayed authoritative.

Raw working logs: `.grilltrack/work/checkout-reservations-20260930/logs/`.
This follow-up: `lost-response-focused.log`, `lost-response-full.log`.
Curated JSON: `commit.json`, `replay.json`, `race.json`, `outcomes.json`.
Formal review: not recorded.
