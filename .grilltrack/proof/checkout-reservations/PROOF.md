# Checkout whole-basket reservations

Branch `codex/inventory-checkout-reservations-20260930` on base
`git:1228ed5f0ff74b8e5a6e303a1fe54698b04de441`. Commerce port compatibility
checked against public source SHA
`1cb55c756ef746bcb042b9679dc43b57e67bcb0d`. Runtime Node v22.23.1.
Curated 2026-09-30T14:25:37Z.

## Storage distinction

- **Actual local SQLite:** file-backed `BEGIN IMMEDIATE` store, close/reopen,
  injected rollback after batch write, two connections, and two OS processes.
- **Actual Cloudflare workerd:** local Wrangler Durable Object SQLite with
  persist/restart, scarce-stock concurrency, terminal release fence, first-call
  and factory-restart binding mismatch, and a second isolated workerd pool.
- **Not used as proof:** in-memory mocks, fake port doubles, or remote
  deploy.

## Commands

| Command | Exit | Role |
| --- | --- | --- |
| `node --experimental-sqlite --experimental-strip-types --test tests/checkout-inventory/*.test.mjs` | 0 | focused Node behavior |
| `bin/verify-checkout-inventory` | 0 | focused feature gate, including workerd Vitest |
| `node tools/checkout-inventory-commerce-port-proof.mjs` | 0 | exact Commerce port assignability |
| `bin/prove-checkout-inventory-real` | 0 | local SQLite + two-process + workerd |
| `bin/verify-inventory full` | 0 | **PASS** — architecture, typecheck, 166 Node tests, Vitest 5 files / 28 tests |

## Observed

- Whole basket reserved atomically; one short SKU rejected with reserved `0`.
- Exact replay after SQLite close/reopen and after Wrangler restart.
- Duplicate reserve/release idempotent; lost-response replay matched.
- Terminal release fenced later reserve; named-hold release still allows a
  new named hold.
- Two connections and two processes: one reserved, one rejected; no oversell.
- Workerd race: outcomes `rejected` + `reserved`; later reserve after release
  fence stayed rejected.
- Public factory rejects first-call and post-restart binding mismatch,
  including `providerRef` `some.other.provider`, without incrementing reserved
  stock. A second workerd pool reserved only under its own configured binding.
- Changed `siteId` cannot recover or mutate another site's hold; same-site
  principal change still recovers the original result.
- Operation/SKU line keys stay distinct when either ID contains a colon.
- Release fails closed for missing or ambiguous reservation rows instead of
  reporting released while reserved stock remains.
- Commerce `CheckoutInventoryPort` / `StockRequest` assignability passed
  against the accepted public source SHA.

Raw working logs: `.grilltrack/work/checkout-reservations-20260930/logs/`.
Curated JSON: `commit.json`, `replay.json`, `race.json`.
