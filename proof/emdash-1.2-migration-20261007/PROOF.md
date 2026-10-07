# Inventory EmDash 1.2 migration

This candidate upgrades the Inventory development/install toolchain from EmDash
1.0.1 to the individually published 1.2 package matrix. It changes no Inventory
kernel, account authorization, stock schema, Website issuance, or provider
authority. Implementation commit and per-file hashes are in
`source-manifest.json`; subsequent proof commits preserve those runtime bytes.

`bin/verify-inventory full` passed on Node 22.23.2: 258 Node tests, 29 Cloudflare
tests, 12 hosted tests, both TypeScript checks, architecture and plugin bundle.
The production sandbox backend remains 130,968 bytes within the 131,072-byte
limit, leaving 104 bytes. The exact installed package, descriptor and runtime
files match the current generated assembly. `verification.json` records package
versions and the non-symlink npm tarball identity.

## Actual installation and upgrade

`astro-host.json` records an actual Astro 7.2.9 + EmDash 1.2.0 config-managed npm
installation using sandbox-workerd 0.9.3 and the production plugin bytes. Health
reports 1.2.0. Anonymous admin dispatch returns 401 and an authenticated editor
returns 403; the administrator receives the Inventory Block Kit response.
The settings API accepts its secret field without returning it. CMS options,
plugin KV and settings namespace survive a normal host restart, and admin
dispatch still returns 200. No state is seeded or rewritten during restart.

`migration-state.json` records a separate fresh synthetic 1.0.1 database with
88 applied migrations. After adding representative CMS, encrypted plugin
settings and plugin KV state through the old runtime, the supported 1.2 CLI
applies exactly two pending migrations to the same target fingerprint. All
90 migrations are then current, with the state hash unchanged. No historical
proof database was opened, copied, reset or reseeded.

The new resolution of CodeMirror language 6.13.0 imported an absent
`@codemirror/streamparser` package and failed the actual Astro build. The override
to 6.12.4 uses the minimum version declared by EmDash 1.2 admin and restores the
build. Existing Astro, React adapter, Vite and Rolldown versions remain pinned
to the previously qualified compatible peers. CI moves to Node 22.23.2 to meet
the registry verifier's published floor.

The selected [admin screenshot](https://github.com/dinkuskit/dinkus-pr-assets/releases/download/inventory-emdash12-d9cb2f8/astro-admin-1.2.png)
shows the actual Connect Inventory screen after restart. `assets.json` records
its capture identity, visual review, size and SHA256; uploaded size and digest
match local bytes. The asset shelf requires access. This capture proves local
rendering, not a live merchant connection.

## Complementary behavior and Registry limit

`opening-stock.json` records the real published dispatcher and workerd sandbox
calling the canonical local Inventory SQLite Durable Objects with synthetic
authentication. No opening balance is seeded. Preview moves no stock; another
administrator sends zero mutations. A lost acknowledgement, reload and exact
retry retain the original command and one opening receipt. Service restart
retains stock and the same receipt; existing history exposes adjustment rather
than another opening balance. This proof uses a clearly identified finite test
authority variant; original and running code hashes are recorded separately.

The fresh onboarding component also passed actual 1.2 dispatcher/workerd
consent, PKCE, retry/reinstall and anonymous/editor/CSRF boundaries with synthetic
Website transport. Repository hosted tests cover signed single-organization
metadata reads, isolation and SQLite persistence. These do not grant live
Website signing or operator access.

`registry-context.json` records a local opaque Registry-derived installation
context using the unchanged production plugin code. Private admin policy and
settings/KV isolation work under the opaque ID, while a slug alias returns 404.
The existing Website callback/proof protocol still embeds `dinkus-inventory`.
Therefore signed Registry onboarding is **not qualified**: it needs a separately
coordinated install-ID protocol change and actual Registry delivery proof.
This was already a limitation of the previous source; the 1.2 migration keeps
the proven config-managed npm target and makes no Registry publication claim.

## Reproduction and evidence scope

The public `recipes/` preserve the parent proof controllers. Set
`EMDASH_MIGRATION_PROOF_RUN_DIR` to a fresh owned ignored run directory. Prepare
`astro-install`, `migration-baseline-host` and `migration-upgrade-host` with the
durable `tools/emdash-clean-install-astro.config.mjs`, login/seed/ports helpers
and the current locally packed non-symlink plugin. The baseline uses EmDash
1.0.1 / sandbox 0.9.1; the other hosts use 1.2.0 / 0.9.3. Host dependencies are
Astro 7.2.9, node adapter 11.1.7, React adapter 6.0.4, React/DOM 19.2.8, and
auth-atproto 0.2.8; preserve the root overrides. Do not reuse any old database.

Run `migration-state-proof.mjs`, then `astro-context-proof.mjs` against the
bootstrap-prepared fresh host, and `registry-context-proof.mjs` after stopping
that host. Runtime controllers must run sequentially because the published
standalone runner begins allocating at port 18788. Use Node 22.23.2 and the
normal workerd postinstall/native binary. Scripts-disabled npm preparation
leaves a JavaScript wrapper whose native child can survive wrapper shutdown;
task-owned process-group shutdown and final child inventories were verified.
The public controllers retain transient test keys in memory and emit only
sanitized result metadata. `tools/hosted-onboarding-proof-host.mjs` and
`tools/opening-stock-proof-host.mjs` support fresh output directories and derive
version labels from the actual installed packages.

All archived 1.0.1 proof remains historical. There is no live Registry delivery,
hosted account issuance, deployment or provider activation in this packet.
Exact-current-source CI, comprehensive OpenClaw P3 and native ClawSweeper are
separate required merge evidence, recorded in the final local gate packet.
