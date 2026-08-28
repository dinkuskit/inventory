# GrillTrack cycle 10 exact-source review

- source identity:
  `sha256:69f6528d61961d36a92b92863e65e1f0ccccfb338dff189aeafb50c7b483dd3d`
- manifest: `.grilltrack/proof/cycle-10/SOURCE_MANIFEST.sha256`
- baseline: `git:ea8583131aae4ba63510b92b37cbcb94dff587c4`
- external finding:
  `https://github.com/dinkuskit/inventory/pull/10#issuecomment-5456159246`
- adjudication: `required_fix`, resolved in repair cycle 1
- result: clean
- remaining findings: none

## Manifest verification

- The manifest hash matches the recorded source identity.
- `sha256sum -c` passed for all 46 entries.
- The manifest covers repository instructions, product contracts, architecture
  and blast-radius design, all domain/application/storage modules, both SQLite
  adapters, Cloudflare schema and Worker context, public exports, behavioral
  tests, and all three repo-owned verifiers.

## Standards review

Passed.

- Work remains isolated from exact merged `origin/main` baseline
  `ea8583131aae4ba63510b92b37cbcb94dff587c4` in a dedicated repair worktree.
- The existing Inventory checkout and the separate cycle-11 worktree are
  unchanged. No Blocks, SmokyClub, Commerce, EmDash, x-api, or shared
  review-conductor file was touched.
- Public source contains no credential, customer data, tenant branding,
  business figure, live SKU, production identifier, or new production
  configuration.
- The package remains private at `0.0.0`. No public route, second writer,
  fallback ledger, account action, deployment, publication, or stock mutation
  was introduced.
- Architecture and blast radius were documented before repair implementation.
  The two schema failures were observed before the minimal source change.
- The local SQLite adapter remains explicit-path and test-only. The Cloudflare
  adapter remains bound to one explicit pool and rejects cross-pool reads and
  transactions.
- Focused tests, full regression, both storage runtimes, strict typechecks,
  Wrangler dry-run, ledger validation, manifest validation,
  database-artifact scan, and `git diff --check` passed.

## External finding review

The original version-1-to-version-2 migration could create an empty location
registry beside balance rows with unregistered location IDs. That was a real
contract defect if the source claimed a supported legacy upgrade, so the P1
finding was correctly classified as `required_fix`, not dismissed.

There is no live Inventory database and no legacy data to upgrade. The repaired
source removes that unsupported upgrade claim and path. An empty Durable Object
now creates the complete schema directly at version 2. Any older, partial, or
unexpected non-empty Inventory schema throws before modification. Tests prove
both the successful fresh path and that a simulated version-1 shape remains at
history `[1]` without gaining `inventory_locations` after rejection.

The reviewer request for proof from a real upgraded database is inapplicable to
the confirmed product state because no such database exists. The PR now makes
no migration claim. This review does not substitute a local simulation for a
live deployment and explicitly keeps database creation and deployment gated.

## Confirmed source-intent review

Passed.

- `location.create` is the only command without a location ID because
  Inventory mints it; all other lifecycle commands require the exact permanent
  ID and every command requires an explicit pool.
- The normalized display value is retained while the NFKC/lowercase key makes
  casing and surrounding whitespace unable to create duplicate active or
  archived locations.
- The database unique constraint includes archived rows, so archive does not
  release a name. Application conflict checks convert ordinary duplicates into
  stable durable rejections before the constraint is reached.
- Create produces active version 1. Rename, archive, and restore preserve
  identity and creation facts while advancing the version. Archive freezes its
  timestamp; restore clears it and returns the same ID.
- Archive blocker queries are pool/location-scoped and include every canonical
  nonzero on-hand or reserved row. Tests prove positive, negative, and reserved
  quantities, exact blocker details, and that the original rejection replays
  even after balances become zero.
- Matching retries return the byte-stable stored result without minting another
  ID or receipt. Changed contents under one command ID conflict across stock
  and location command types while preserving the original.
- Location insert/update, receipt insert, and command-result insert share one
  serialized transaction in both adapters. Duplicate-receipt tests prove the
  location row and command state roll back together.
- Receipts freeze trusted principal identity and display metadata plus complete
  location before/after snapshots. Direct mutation lookup resolves them from
  the canonical command/result tables.
- Active and archived reads are explicit-pool, explicit-status, deterministic,
  and source normal selector/archive behavior without deleting history.
- Stock receipt history remains stock-only by an explicit type predicate, so
  the earlier location-scoped history lock is preserved.
- Cloudflare version 2 is the first complete schema, not a migration target.
  Fresh initialization, exact current reopen, older-shape rejection, table and
  history assertions, pool isolation, strict typing, and a no-deploy Wrangler
  build are proven.

## Blast radius and fidelity

The public platform-neutral API gains location command/read contracts and
widens direct mutation results to the actual stock-or-location union. Both
known store implementations were updated. The Worker HTTP surface and remote
mutation surface remain unchanged and closed.

The confirmed slice intentionally does not yet bind opening-balance admission
to active registry membership and does not implement aggregate stock reads or
the EmDash GUI. Those omissions are documented follow-up domains. No
`required_fix`, `reject_false_positive`, `defer`, or `human_gate` finding
remains for this source identity.
