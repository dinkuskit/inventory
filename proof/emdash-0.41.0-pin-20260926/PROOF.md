# EmDash 0.41.0 scaffold proof

- Source head: `085a3413d0ea75da22cf8a2bf8577a6fd4f20c63`
- Owner branch: `dinkuskong/pin-emdash-0.41.0`
- Scope: exact EmDash 0.41.0 development baseline. Kernel still does not import EmDash.
- Release: `emdash@0.41.0` published 2026-09-26T10:47:16Z, release commit `eab84af73ae6adc87930e2acff39e2916c3719ff`.

## Verification

- `node --version` — passed on `v24.16.0`, above the declared Node `>=22.12.0` floor.
- `npm --version` — `11.13.0` on the proof host. This npm does not implement `install-scripts`; the 0.35 baseline proof used npm 11.19.
- `npm config get ignore-scripts` — returned `false`; no blanket lifecycle-script suppression was configured.
- `npm ci` — passed. Added 664 packages, audited 665. Exact-head lockfile resolved `emdash@0.41.0`.
- `npm ls emdash --depth=0` — resolved exact `emdash@0.41.0`.
- `bin/verify-inventory full` — passed after that `npm ci` (architecture, typecheck, 138 Node tests, 24 workerd tests, Wrangler dry-run).
- Redacted terminal evidence: `terminal.txt` in this proof directory.

## Findings

- This is a development/tooling baseline, not a plugin runtime or minimum-compatible-version claim.
- Inventory storage remains the Inventory-owned Durable Object SQLite schema. EmDash 0.41.0 `_plugin_storage.revision` is unused here; no plugin-storage fixture change was required.
- The locked 0.41.0 tree declares the same install scripts as the 0.40.1 lockfile: `esbuild` and `workerd` (`fsevents` is optional). Nested `esbuild` copies under `@cloudflare/vitest-plugin` and `wrangler` are still flagged. `better-sqlite3` stays out of the tree. This host's npm 11.13 did not print `allowScripts` coverage warnings; other npm versions or operator policies may execute those scripts during `npm ci`.
- `emdash@0.41.0` still declares `engines.node` `>=22.16`, same as `0.40.1`. This repository's own floor stays `>=22.12.0`. The proof host was `v24.16.0`.
- `npm audit` reported 5 vulnerabilities (1 moderate, 4 high) in the already-pinned `wrangler@4.127.0` / `@cloudflare/vitest-plugin@1.1.1` graph (`wrangler`, `miniflare`, `sharp`, `qs`). Those pins are unchanged by this PR. No `npm audit fix`.
- Historical proof receipts under `proof/emdash-0.35-baseline-20260827/` and `proof/emdash-0.40.1-pin-20260925/` were left alone.

## Gates

- No runtime product behavior, repository npm lifecycle policy, deployment, secret, account, or production state changed.
- No lifecycle script was approved or denied by this pin. Approval of the development dependency's lifecycle-code boundary, merge, and any downstream release remain human-gated.
