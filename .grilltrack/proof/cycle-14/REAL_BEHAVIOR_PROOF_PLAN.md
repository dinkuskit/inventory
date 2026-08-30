# Cycle 14 real-behavior proof repair plan

ClawSweeper classification: `required_fix` for proof only. No source-logic
defect was reported.

## Boundary

The repair owns one disposable, local-only Wrangler proof path for the existing
stock-adjustment feature. It exercises the production Cloudflare SQLite store
inside a real local Durable Object runtime and emits a redacted transcript.

It does not change the production Worker, public package API, schema, command or
receipt contracts, authentication, remote Cloudflare resources, or deployed
state. It does not add a production HTTP mutation route.

## Interfaces

- `POST /` with `{ "action": "commit" }` bootstraps a disposable proof pool,
  previews one adjustment, confirms it, and returns the preview, terminal
  result, durable balance, and receipt-history summary.
- `POST /` with `{ "action": "replay" }` runs after Wrangler has stopped and
  reopened the same persisted local state. It reuses the exact confirmation and
  command and returns the original terminal result plus the durable balance and
  receipt-history summary.
- `bin/prove-stock-adjustment-real` owns the temporary directory, loopback port,
  Wrangler lifecycle, persistence check, and redacted terminal output.
- `npm run proof:stock-adjustment:real` is the stable contributor command.

## State and invariants

- All setup and stock commands use stable IDs and deterministic proof-only
  identities.
- The confirmation value is never printed; transcript output replaces it with
  `<redacted>`.
- The first call must commit exactly one `stock.adjust` receipt.
- Wrangler must stop before replay and reopen at least one persisted state file.
- Replay must equal the original terminal result byte-for-byte at the JSON data
  level, retain balance version `2`, and retain exactly one adjustment receipt.
- The runner must stay local (`--local`, loopback address, no `--remote`) and
  delete its temporary state on exit.

## Verification

1. Contract test proves the local-only configuration, production-store import,
   preview/confirm path, restart, redaction, and replay assertions are present.
2. The real proof command produces the after-fix transcript outside Node Test,
   Vitest, and Miniflare test harnesses.
3. The focused verifier and canonical full repository verifier remain green.
