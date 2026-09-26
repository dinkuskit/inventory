# Cycle 22 proof — stock.pack_some

ClawSweeper P1 on PR 26: no after-fix runtime artifact for partial packing,
and original reserve retry after pack-some must return the same ticket.

Command: `npm run proof:stock-reservation:real`

Transcript: `.grilltrack/proof/cycle-22/REAL_RUNTIME_TRANSCRIPT.txt`

Observed 2026-09-25:
- reserved hat ticket `rsv_proof_hat` for 3
- `stock.pack_some` packed 1; remaining 2, `partially_packed`
- original 3-hat reserve retry returned the same ticket (`existing`)
- `stock.pack_all` then packed remaining hat plus shirt
- exact pack-all command replayed after SQLite close/reopen and Wrangler restart
