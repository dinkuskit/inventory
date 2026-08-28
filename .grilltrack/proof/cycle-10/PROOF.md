# GrillTrack cycle 10 proof

- track: `dinkuskit-inventory-v1`
- domain: Inventory location registry lifecycle, first Cloudflare schema, and
  active-location admission for opening balances
- git baseline: `ea8583131aae4ba63510b92b37cbcb94dff587c4`
- pull request: `https://github.com/dinkuskit/inventory/pull/10`
- decisions: `location-lifecycle-030`, `location-archive-safety-031`,
  `location-name-uniqueness-032`, `fresh-schema-initialization-034`,
  `opening-balance-location-admission-035`
- reviewed source identity:
  `sha256:d817681efbbfe7dcf117824468412e280af5d9033b20654a229ee637f903b820`
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
  block it;
- create, rename, archive, and restore use awaited idempotent commands, stable
  command IDs, actor-bearing immutable receipts, exact retry, and atomic
  durable storage; and
- opening balance may commit only for an existing active location in the same
  explicit pool. Unknown and archived locations produce durable rejections,
  create no stock or receipt, and replay their original result even if the
  location registry later changes.

The bounded implementation covers the platform-neutral domain/application
contract, active and archived list reads, the explicit local SQLite test
boundary, Cloudflare Durable Object SQLite schema/storage parity, and the
opening-balance admission check. It does not add the EmDash GUI,
authentication/deployment routes, package delivery, storefront bindings, or
the aggregate stock view.

## Required-fix repair cycle 1: first schema

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

## Required-fix repair cycle 2: active location admission

ClawSweeper then found that an archived empty location could receive an
opening balance and regain hidden stock. Bobby confirmed that every new
opening balance must target an existing active location.

The repaired command order inside the existing serialized transaction is:

1. replay or conflict against a previously stored command result;
2. resolve the explicit location ID in the command's explicit pool;
3. durably reject an unknown location with `location_not_found`, or an
   archived location with `location_not_active`;
4. enforce the existing one-time stock-history rule; and
5. commit the balance effect and immutable opening-balance receipt together.

The replay-first order is intentional. A rejected command stays rejected after
an archived location is restored or an unknown location is later created. A
rejection does not request a receipt ID and creates neither balance nor
receipt. The confirmed-preview path calls the same transaction function after
checking its confirmation binding, so it receives the same commit-time
location admission without a parallel implementation.

## Architecture and blast radius

The architecture contracts are
`docs/implementation/location-registry-lifecycle.md`,
`docs/implementation/fresh-cloudflare-schema-initialization.md`, and
`docs/implementation/opening-balance-active-location-admission.md`.

Names are trimmed, Unicode NFKC-normalized, and lowercased into a durable
uniqueness key. SQLite enforces `UNIQUE (pool_id, name_key)` across active and
archived rows. Lifecycle records use monotonically advancing string versions
and preserve the same ID through rename, archive, and restore.

All lifecycle operations share `inventory_command_results` and
`inventory_receipts` with opening balances, keeping command IDs globally
conflict-safe and storing each successful mutation, receipt, and terminal
result in one transaction. Existing stock receipt history explicitly filters
`stock.opening_balance`, so lifecycle receipts do not silently alter that
accepted read model; direct mutation lookup can resolve either result type.

The active-location repair reuses `InventoryTransaction.getLocation`, which is
already implemented and pool-scoped by both storage adapters. It changes no
storage interface, schema, or migration. Its public blast radius is the two
new opening-balance rejection codes and the stricter behavior of direct and
confirmed opening-balance execution. Existing tests now create their required
active location explicitly.

No public HTTP route, second ledger, provider fallback, Commerce, Blocks,
SmokyClub, EmDash, x-api, shared review-conductor, account, credential, or
production surface changed.

## Test-driven proof

The original location Node and Cloudflare tests were written before the
location implementation. The Node run failed because `src/index.ts` did not
export `createExecuteLocationCommand`; the Cloudflare runtime run failed
because `src/application/location-registry.ts` did not exist.

For repair cycle 1, two focused assertions were changed before source:

- fresh storage expected migration history `[2]` but observed `[1, 2]`; and
- version-1-shaped storage was expected to throw an older/incompatible-schema
  error but initialization completed instead.

For repair cycle 2, tests were written before source and observed these
failures:

- all three focused local cases committed instead of rejecting unknown and
  archived locations; and
- the focused Cloudflare runtime case committed for an archived location.

The minimal source change added the two rejection codes and the canonical
location check inside `executeSetOpeningBalanceInTransaction`. The focused
local and Cloudflare tests then passed. Existing opening-balance fixtures were
updated only to establish the active-location precondition through real
location commands.

## Final verification

Commands and results:

- `bin/verify-location-registry` -> 7 passed, 0 failed;
- `bin/verify-opening-balance` -> 35 tests passed plus the deterministic
  active-location runtime scenario;
- `npm test` -> 53 Node tests and 10 Cloudflare runtime tests passed;
- `bin/verify-cloudflare-storage` -> strict Cloudflare typecheck passed, 3
  deployment-contract tests passed, 10 runtime tests passed, and Wrangler
  deploy dry-run exited without deploying;
- broad strict TypeScript check over `src/index.ts` and all reachable
  platform-neutral modules -> passed;
- `git diff --check` -> passed;
- GrillTrack ledger validation -> passed;
- database-artifact scan -> clean; and
- `sha256sum -c .grilltrack/proof/cycle-10/SOURCE_MANIFEST.sha256` -> all 50
  entries passed.

Behavioral proof covers name normalization; active/archive uniqueness; durable
exact replay before and after reopen; permanent identity; actor snapshots;
rename, archive, and restore versions; active and archived reads; positive,
negative, and reserved blockers; durable blocker replay after balances clear;
atomic rollback on receipt conflict; cross-type command-ID conflicts; input
validation; stock-history filtering; Cloudflare adapter parity; pool isolation;
fresh direct version-2 initialization; idempotent current-schema reopen;
fail-closed rejection without mutation of a simulated older schema; direct and
confirmed opening-balance admission; stable unknown/archive rejection; and no
balance or receipt side effect on rejection.

The repo-owned behavior artifact is
`.grilltrack/proof/cycle-10/ACTIVE_LOCATION_RUNTIME.json`, SHA-256
`25b2de42d3697d5a5f6fbcf9a0893bd3386be84e006e27812643bb6c8c8a21e9`.
It was generated by `scripts/verify-active-location-admission.mjs` against a
real temporary local SQLite file. The script closes the store and removes the
temporary directory. It proves an active commit at four units with a receipt,
archived and unknown rejection without balance or receipt, exact replay after
the registry changes, and exactly one receipt-ID request. Cloudflare runtime
tests separately exercise the same adapter contract.

## Fidelity limits and gates

This is a platform-neutral command/storage slice, not the future visual
Katana-style interface. The behavior artifact is local SQLite proof and the
Cloudflare checks run in the repository's isolated Worker test runtime; neither
is proof of a deployed or live Cloudflare database. Aggregate stock reads
remain a separate follow-up slice.

No live service call, remote database, production pool, real SKU, account,
credential, package, site, or customer data was accessed. The prior version-1
probe contained zero Inventory records and was never a live database. Creating
the first Cloudflare database, deployment, merge, publication, and production
cutover remain separate gates.

## Exact-source review

The standards and source-intent review in `REVIEW.md` is bound to the 50-entry
manifest identity above and found no remaining local required fix.

## Recommended next focused grill

Return to the already locked one-location/all-locations aggregate stock read.
That is the smallest slice that lets the Katana-style selector show one
location's inventory or the combined totals without making the read view a
mutation authority.

The credible alternatives are the ordinary post-opening stock-adjustment
command with its editable reason, or preview-time active-location validation as
an earlier user-facing warning while retaining the proven commit-time guard.
