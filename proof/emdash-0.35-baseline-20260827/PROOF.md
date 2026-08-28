# EmDash 0.35 scaffold proof

- Source base: `6ebb294e64a1bc2c94f4ba3fd83c6f60b2ab6658`
- Owner branch: `codex/emdash-0.35-baseline-20260827`
- Scope: exact EmDash 0.35 development baseline for the charter-only Inventory scaffold.

## Verification

- `node --version` — passed on `v26.7.0`, above the declared Node `>=22.12.0` floor.
- `npm config get ignore-scripts` — returned `false`; no blanket lifecycle-script suppression was configured.
- `npm ci` — passed with zero reported vulnerabilities.
- `npm install-scripts ls` — reported `better-sqlite3@12.11.1` and `esbuild@0.28.2` as not covered by `allowScripts`; neither was approved by this change.
- `npm test` — passed: 8 of 8 workflow tests, including the toolchain contract.
- `npm ls emdash --depth=0` — resolved exact `emdash@0.35.0`.
- `git diff --check` — passed.
- Redacted terminal evidence: `terminal.txt` in this proof directory.

## Findings

- This is a development/tooling baseline, not a runtime compatibility claim.
- The locked toolchain requires Node `>=22.12.0` because its EmDash dependency tree includes Astro 7.2.9 with that floor.
- The dependency tree declares third-party install scripts, including `esbuild` and `better-sqlite3`. npm 11.19 on the proof host leaves both unapproved, while other npm versions or policies may execute them during installation.
- The existing manual cutover boundary remains intact: no WooCommerce or Katana adapter, importer, shadow reader, tail, or dual writer was added.

## Gates

- No runtime product behavior, repository npm lifecycle policy, deployment, merge, secret, account, or production state changed.
- No lifecycle script was approved or denied by this repair. Approval of the development dependency's lifecycle-code boundary, merge, and any downstream release remain human-gated.
