# EmDash 0.40.1 scaffold proof

- Source head: `2556ad58951221d2b5e38556253cc064ec3b8f52`
- Owner branch: `openclaw/pin-emdash-0401`
- Scope: exact EmDash 0.40.1 development baseline. Kernel still does not import EmDash.

## Verification

- `node --version` — passed on `v24.16.0`, above the declared Node `>=22.12.0` floor.
- `npm --version` — `11.13.0` on the proof host. This npm does not implement `install-scripts`; the 0.35 baseline proof used npm 11.19.
- `npm config get ignore-scripts` — returned `false`; no blanket lifecycle-script suppression was configured.
- `npm ci` — passed. Added 664 packages, audited 665. Exact-head lockfile resolved `emdash@0.40.1`.
- `npm ls emdash --depth=0` — resolved exact `emdash@0.40.1`.
- `bin/verify-inventory full` — passed after that `npm ci` (architecture, typecheck, 104 Node tests, 19 workerd tests, Wrangler dry-run).
- GitHub Actions `inventory-contract` on this head — passed.
- Redacted terminal evidence: `terminal.txt` in this proof directory.

## Findings

- This is a development/tooling baseline, not a plugin runtime or minimum-compatible-version claim.
- Inventory storage remains the Inventory-owned Durable Object SQLite schema. EmDash 0.40.1 `_plugin_storage.revision` is unused here; no plugin-storage fixture change was required.
- The locked 0.40.1 tree declares install scripts for `esbuild` and `workerd` (`fsevents` is optional). `better-sqlite3` left the tree with this pin. This host's npm 11.13 did not print `allowScripts` coverage warnings; other npm versions or operator policies may execute those scripts during `npm ci`.
- `npm audit` reported 5 vulnerabilities (1 moderate, 4 high) in the already-pinned `wrangler@4.127.0` / `@cloudflare/vitest-plugin@1.1.1` graph (`wrangler`, `miniflare`, `sharp`, `qs`). Those pins are unchanged by this PR. No `npm audit fix`.
- Historical 0.35 proof receipts under `proof/emdash-0.35-baseline-20260827/` were left alone.

## Gates

- No runtime product behavior, repository npm lifecycle policy, deployment, secret, account, or production state changed.
- No lifecycle script was approved or denied by this pin. Approval of the development dependency's lifecycle-code boundary, merge, and any downstream release remain human-gated.
