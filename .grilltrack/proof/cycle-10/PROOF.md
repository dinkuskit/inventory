# GrillTrack cycle 10 proof

- track: `dinkuskit-inventory-v1`
- domain: Inventory location registry lifecycle
- git baseline: `ea8583131aae4ba63510b92b37cbcb94dff587c4`
- branch: `codex/inventory-location-history-reason-20260828`
- decisions: `location-lifecycle-030`, `location-archive-safety-031`, `location-name-uniqueness-032`
- reviewed source identity: `sha256:54a52b1c33e7b4a0aeecaf0339a24e81c6f3b6f138e8a295a2a24934e46cad6d`
- production access, deployment, or stock mutation: none
- commit, push, pull request, or merge: none

## Confirmed scope

Bobby confirmed the Inventory-owned lifecycle rules:

- Inventory mints one permanent opaque ID for a manually created location;
- a visible name may be renamed without changing identity or history;
- no two locations in one pool may share a name, including archived records;
- archive removes a location from normal selectors and views while preserving
  an accessible, restorable record and full immutable history;
- archive is admitted only when every SKU has exactly zero on-hand and zero
  reserved; positive on-hand, negative on-hand, and reserved order stock all
  block it; and
- create, rename, archive, and restore use awaited idempotent commands, stable
  command IDs, actor-bearing immutable receipts, exact retry, and atomic
  durable storage.

The bounded implementation covers the platform-neutral domain/application
contract, active and archived list reads, the explicit local SQLite test
boundary, and Cloudflare Durable Object SQLite schema/storage parity. It does
not add the EmDash GUI, authentication/deployment routes, package delivery,
storefront bindings, or the aggregate stock view.

## Architecture and blast radius

The architecture contract is
`docs/implementation/location-registry-lifecycle.md`.

Names are trimmed, Unicode NFKC-normalized, and lowercased into a durable
uniqueness key. SQLite enforces `UNIQUE (pool_id, name_key)` across active and
archived rows. Lifecycle records use monotonically advancing string versions
and preserve the same ID through rename, archive, and restore.

All lifecycle operations share `inventory_command_results` and
`inventory_receipts` with opening balances, keeping command IDs globally
conflict-safe and storing the location row, receipt, and terminal result in one
transaction. Existing stock receipt history explicitly filters
`stock.opening_balance`, so lifecycle receipts do not silently alter that
accepted read model; direct mutation lookup can resolve either result type.

The highest-risk change is the Cloudflare schema migration. Version 2 adds only
`inventory_locations`; new objects apply version 1 then version 2, and exact
version-1 objects migrate in place. Unexpected migration histories or table
sets fail closed. The local test schema advances to v4 and still rejects
in-memory, production-mode, unrelated, and incompatible databases.

No public HTTP route, second ledger, provider fallback, Commerce, Blocks,
SmokyClub, EmDash, x-api, shared review-conductor, account, credential, or
production surface changed.

## Test-driven proof

The location Node and Cloudflare tests were written before implementation.

The Node run failed before implementation because `src/index.ts` did not export
`createExecuteLocationCommand`. The Cloudflare runtime run failed because
`src/application/location-registry.ts` did not exist. These observed red states
prove the tests targeted absent behavior.

The minimal green implementation added one location domain, one lifecycle
application module, transaction/store extensions, equivalent local and
Cloudflare adapters, the version-2 migration, root platform-neutral exports,
and one focused verifier. It generalized stored command results and direct
mutation read-back without duplicating the command engine or receipt ledger.

## Final verification

Commands and results:

- `bin/verify-location-registry` -> 7 passed, 0 failed;
- `bin/verify-opening-balance` -> 32 passed, 0 failed;
- `npm test` -> 50 Node tests and 8 Cloudflare runtime tests passed;
- `bin/verify-cloudflare-storage` -> strict Cloudflare typecheck passed, 3
  deployment-contract tests passed, 8 runtime tests passed, and Wrangler deploy
  dry-run exited without deploying;
- broad strict TypeScript check over `src/index.ts` and all reachable
  platform-neutral modules -> passed;
- `git diff --check` -> passed;
- GrillTrack ledger validation -> passed;
- database-artifact scan -> clean; and
- `sha256sum -c .grilltrack/proof/cycle-10/SOURCE_MANIFEST.sha256` -> all 45
  entries passed.

Behavioral proof covers name normalization; active/archive uniqueness; durable
exact replay before and after reopen; permanent identity; actor snapshots;
rename, archive, and restore versions; active and archived reads; positive,
negative, and reserved blockers; durable blocker replay after balances clear;
atomic rollback on receipt conflict; cross-type command-ID conflicts; input
validation; stock-history filtering; Cloudflare adapter parity; pool isolation;
fresh schema initialization; and simulated version-1 migration.

## Fidelity limits and gates

This is a platform-neutral command/storage slice, not the future visual
Katana-style interface. Opening-balance admission against an active registered
location and aggregate stock reads remain separate follow-up slices. No live
service call, remote database migration, production pool, real SKU, account,
credential, package, site, or customer data was accessed.

Commit, push, pull request, external review rail, merge, deployment,
publication, and production cutover remain separate gates.

## Exact-source review

The standards and source-intent review in `REVIEW.md` is bound to the 45-entry
manifest identity above and found no required fix.

## Recommended next focused grill

Bind stock mutation admission to the new authoritative registry: an opening
balance must name an existing active location, while unknown or archived
locations fail closed. That is the smallest next integration that prevents an
archived location from later receiving hidden stock.

After that, return to the already locked one-location/all-locations aggregate
stock read. The credible alternative is to grill the ordinary post-opening
stock-adjustment command and reason contract first.
