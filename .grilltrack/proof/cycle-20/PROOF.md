# Cycle 20 proof — stock.pack after v5 upgrade

ClawSweeper P1 on PR 22: v5 reservation JSON lacked packedAt/packedBy.

Repair: v5-to-v6 backfills those fields to null. A populated v5 hold upgrades,
packs, and replays on real local SQLite plus wrangler dev --local.

Command: `npm run proof:stock-reservation:real`

Transcript: `.grilltrack/proof/cycle-20/REAL_RUNTIME_TRANSCRIPT.txt`

Observed 2026-09-25:
- schema history `[5, 6]`
- upgraded hold `packedAt`/`packedBy` null, status active
- pack `rsv_proof_hat` quantity 3: on-hand 7, reserved 0, available 7
- exact pack command replayed after Wrangler restart
