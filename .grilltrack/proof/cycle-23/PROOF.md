# Cycle 23 proof — stock.unpack

Command: `bin/verify-inventory full`

Observed 2026-09-26:
- `stock.unpack` restores a packed 3-hat ticket to `not_shipped` of 3
- on-hand and reserved both come back; available stays 7
- unpack of pack-some remainder (packed 1 of 3) joins leftover 2 on the same ticket
- original 3-hat reserve retry returns that same ticket
- exact command-ID replay returns the original unpacked result
- not-shipped and canceled tickets reject
- Cloudflare v5 reservation upgrade remaps live `active` to `not_shipped`
- Cloudflare unpack parity matches local SQLite

`bin/verify-inventory full` passed: architecture, typecheck, 138 Node tests,
24 Cloudflare tests, Wrangler dry-run.
