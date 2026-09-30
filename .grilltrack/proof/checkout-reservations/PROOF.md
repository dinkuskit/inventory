# Checkout whole-basket reservations

Branch `codex/inventory-checkout-reservations-20260930` reviewed at
`git:dc91bf628d0c25340c18fe3a83757275ee0ac19f` against
`git:3397d7237e8e07e2b64c608dad8704ec4bbd84bf`. Repair source bytes are bound by the file hashes in
`source-owner-verification.json`; the published commit is identified by PR 36.
Independent source-owner verification passed on the final patch. Commerce port
compatibility checked against public source SHA
`1cb55c756ef746bcb042b9679dc43b57e67bcb0d`. Runtime Node v22.23.1. Curated
2026-09-30T16:11:12Z.

## Storage distinction

- **Actual local SQLite:** file-backed `BEGIN IMMEDIATE` store, close/reopen,
  injected rollback after batch write, two connections, and two OS processes.
- **Post-commit lost response:** wrap `runTransaction` so the original method
  commits, capture the durable result, then throw once after `COMMIT`. Public
  port returns `unknown`; restart/replay recovers the same stored result.
- **Actual Cloudflare workerd:** local Wrangler Durable Object SQLite with
  persist/restart, scarce-stock concurrency, terminal release fence, first-call
  and factory-restart binding mismatch, a second isolated workerd pool, and
  wrong-site release-first identity conflict in both directions. The
  both-direction regression now reads `state.storage.sql.exec` command,
  result, receipt, and reservation rows and compares those snapshots so a
  hidden stray hold or receipt cannot pass on balance alone.
- **Not used as proof:** in-memory mocks, fake port doubles, or remote
  deploy.

## Commands

| Command | Exit | Role |
| --- | --- | --- |
| `node --experimental-sqlite --experimental-strip-types --test tests/checkout-inventory/*.test.mjs` | 0 | focused Node behavior (23/23) |
| `bin/verify-checkout-inventory` | 0 | focused feature gate, including workerd Vitest and Commerce assignability |
| `bin/verify-inventory full` | 0 | **PASS** — architecture, typecheck, plugin typecheck, 176 Node tests, Vitest 5 files / 29 tests, hosted Vitest 1 file / 3 tests, plugin bundle |
| `bin/prove-checkout-inventory-real` | not rerun | prior real-storage packet remains; this repair used focused and full gates |

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
- Terminal release fences later reserve only when the stored release digest
  matches the current site-bound digest. Named-hold release still allows a
  new named hold.
- Wrong-site release-first in both directions returns a non-persisted
  `command_id_conflict`. No foreign reserve command, receipt, or hold is
  written. The original release stays immutable. Owner same-digest reserve
  after release is durably `checkout_released`. Same-site principal recovery,
  current unrelated hold, restart, idempotent foreign replay, and later
  rollback remain intact. Workerd Durable Object SQLite snapshots the
  original control hold rows/receipt and release result before the foreign
  reserve, then asserts no foreign reserve receipt and exact original
  reservation/receipt rows after collision, repeated foreign replay, owner
  durable `checkout_released` fence, and factory restart.
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

Accepted finding:
`.grilltrack/proof/checkout-reservations/accepted-p1-finding.md`.
Assigned formal review of the repaired source is separate and is not recorded
as clean.

Raw working logs remain under ignored work artifacts. Curated JSON:
`commit.json`, `replay.json`, `race.json`, `outcomes.json`.

Independent source-owner acceptance: final `bin/verify-inventory full` passed
176 Node, 29 Cloudflare, and 3 hosted tests with plugin checks and bundling.
Commerce assignability passed against the source SHA above. Command output
hashes are recorded in `source-owner-verification.json`; raw logs remain ignored.
