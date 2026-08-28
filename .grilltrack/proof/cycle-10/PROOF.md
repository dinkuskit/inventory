# GrillTrack cycle 10 proof

- track: `dinkuskit-inventory-v1`
- domain: Inventory location registry lifecycle and first Cloudflare schema
- git baseline: `ea8583131aae4ba63510b92b37cbcb94dff587c4`
- pull request: `https://github.com/dinkuskit/inventory/pull/10`
- decisions: `location-lifecycle-030`, `location-archive-safety-031`,
  `location-name-uniqueness-032`, `fresh-schema-initialization-034`
- reviewed source identity:
  `sha256:69f6528d61961d36a92b92863e65e1f0ccccfb338dff189aeafb50c7b483dd3d`
- production access, deployment, database creation, or stock mutation: none
- merge, publication, or production cutover: none

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

## Required-fix repair

ClawSweeper reported a P1 finding on the original PR head: the proposed
version-1-to-version-2 migration could create an empty location registry beside
balances whose location IDs predated that registry. The finding was admitted
as `required_fix`:

`https://github.com/dinkuskit/inventory/pull/10#issuecomment-5456159246`

Bobby clarified that Inventory has no live database to upgrade: this work is
scaffolding its first real Cloudflare database. The repair therefore removes
the invented legacy-upgrade path instead of pretending an old database can be
reconstructed safely.

The resulting initialization contract is:

- storage with zero `inventory_*` tables creates the complete schema directly
  at version 2 in one atomic initialization and records history `[2]`;
- storage with the exact complete version-2 table set and history `[2]` is
  accepted without writes; and
- any non-empty older, partial, or unexpected Inventory schema fails closed
  before modification.

This is a source and local-runtime repair only. It did not create, inspect,
migrate, or mutate a deployed Cloudflare database.

## Architecture and blast radius

The architecture contracts are
`docs/implementation/location-registry-lifecycle.md` and
`docs/implementation/fresh-cloudflare-schema-initialization.md`.

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

The repair changes the schema initializer and its Worker-construction path, so
its blast radius includes all fresh Durable Object instances. Exact table and
migration-history assertions prevent the initializer from guessing at any
non-empty predecessor. No public HTTP route, second ledger, provider fallback,
Commerce, Blocks, SmokyClub, EmDash, x-api, shared review-conductor, account,
credential, or production surface changed.

## Test-driven proof

The original location Node and Cloudflare tests were written before the
location implementation. The Node run failed because `src/index.ts` did not
export `createExecuteLocationCommand`; the Cloudflare runtime run failed
because `src/application/location-registry.ts` did not exist.

For the ClawSweeper repair, two focused assertions were changed before source:

- fresh storage expected migration history `[2]` but observed `[1, 2]`; and
- version-1-shaped storage was expected to throw an older/incompatible-schema
  error but initialization completed instead.

Those two observed red failures prove the repair tests targeted the removed
upgrade behavior. The minimal source change then made both pass: new empty
storage is initialized directly and the simulated old shape remains unchanged
after rejection.

## Final verification

Commands and results:

- `bin/verify-location-registry` -> 7 passed, 0 failed;
- `bin/verify-opening-balance` -> 32 passed, 0 failed;
- `npm test` -> 50 Node tests and 9 Cloudflare runtime tests passed;
- `bin/verify-cloudflare-storage` -> strict Cloudflare typecheck passed, 3
  deployment-contract tests passed, 9 runtime tests passed, and Wrangler deploy
  dry-run exited without deploying;
- broad strict TypeScript check over `src/index.ts` and all reachable
  platform-neutral modules -> passed;
- `git diff --check` -> passed;
- GrillTrack ledger validation -> passed;
- database-artifact scan -> clean; and
- `sha256sum -c .grilltrack/proof/cycle-10/SOURCE_MANIFEST.sha256` -> all 46
  entries passed.

Behavioral proof covers name normalization; active/archive uniqueness; durable
exact replay before and after reopen; permanent identity; actor snapshots;
rename, archive, and restore versions; active and archived reads; positive,
negative, and reserved blockers; durable blocker replay after balances clear;
atomic rollback on receipt conflict; cross-type command-ID conflicts; input
validation; stock-history filtering; Cloudflare adapter parity; pool isolation;
fresh direct version-2 initialization; idempotent current-schema reopen; and
fail-closed rejection without mutation of a simulated older schema.

## Fidelity limits and gates

This is a platform-neutral command/storage slice, not the future visual
Katana-style interface. Opening-balance admission against an active registered
location and aggregate stock reads remain separate follow-up slices. No live
service call, remote database, production pool, real SKU, account, credential,
package, site, or customer data was accessed.

The prior version-1 probe contained zero Inventory records and was never a live
database. It is test history, not migration input. Consequently there is no
real upgraded-storage proof to gather and the repaired PR makes no upgrade
claim. Creating the first Cloudflare database, deployment, merge, publication,
and production cutover remain separate gates.

## Exact-source review

The standards and source-intent review in `REVIEW.md` is bound to the 46-entry
manifest identity above and found no remaining required fix.

## Recommended next focused grill

Bind stock mutation admission to the new authoritative registry: an opening
balance must name an existing active location, while unknown or archived
locations fail closed. That is the smallest next integration that prevents an
archived location from later receiving hidden stock.

After that, return to the already locked one-location/all-locations aggregate
stock read. The credible alternative is to grill the ordinary post-opening
stock-adjustment command and reason contract first.
