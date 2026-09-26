# Cycle 23 proof — stock.unpack

Command: `npm run proof:stock-reservation:real`

Transcript: `.grilltrack/proof/cycle-23/REAL_RUNTIME_TRANSCRIPT.txt`

Observed 2026-09-26:
- `stock.unpack` restores a packed 3-hat ticket to `not_shipped` of 3
- on-hand and reserved both come back; available stays 7
- unpack of pack-some remainder (packed 1 of 3) joins leftover 2 on the same ticket
- original 3-hat reserve retry returns that same ticket
- exact command-ID replay returns the original unpacked result
- not-shipped and canceled tickets reject
- Cloudflare v5 reservation upgrade remaps live `active` to `not_shipped`
- Cloudflare unpack parity matches local SQLite
- Real local SQLite file: unpack restored hat to not_shipped 3; on-hand 10 reserved 3 available 7
- Real Wrangler Durable Object: same unpack, then exact pack-all command replayed after restart

`bin/verify-inventory full` passed: architecture, typecheck, 138 Node tests,
24 Cloudflare tests, Wrangler dry-run.
