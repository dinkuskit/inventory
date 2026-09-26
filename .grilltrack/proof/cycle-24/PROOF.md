# Cycle 24 proof — stock.deliver

Command: `npm run proof:stock-reservation:real`

Transcript: `.grilltrack/proof/cycle-24/REAL_RUNTIME_TRANSCRIPT.txt`

Observed 2026-09-26:
- `stock.deliver` names packed hat and shirt tickets Commerce already has
- both become `delivered`, or none
- on-hand 7, reserved 0, available 7 after deliver — same as after pack; counts do not move
- exact deliver command-ID replay after SQLite close/reopen and Wrangler restart returns the original delivered result
- a not-fully-packed ticket in the same command packs none of the named tickets into Delivered
- Cloudflare schema v9 allows `delivered`; exact v8 upgrades to `[8, 9]`

`bin/verify-inventory full` passed 2026-09-26: architecture, typecheck, 144 Node tests, 24 Cloudflare tests, Wrangler dry-run.

GUI, live Commerce, Woo, Katana, ShipTheory, revert-from-Delivered, and deploy were not run.
