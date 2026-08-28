# GrillTrack cycle 8 proof

- track: `dinkuskit-inventory-v1`
- domain: production Cloudflare inventory pool
- git baseline: `08a4fef09dfdb33091d444fe03bb53f1aeba754d`
- branch: `codex/inventory-cloudflare-pool-20260828`
- decision: `cloudflare-pool-023`
- reviewed source identity: `sha256:530156e4d0406ebfd8aab60106a391fe3ecdb1f3d0067de1e226972a7d94da49`
- deployed Cloudflare version: recorded in private machine proof
- package publication: none
- storefront traffic binding or cutover: none

## Confirmed scope

Bobby approved creating the real production-intended Cloudflare database while
leaving the live hat SKU without stock until a human physical count. The
bounded implementation:

- deploys one generic private Inventory Worker with a SQLite-backed Durable
  Object namespace;
- selects one object database from every complete explicit pool ID;
- disables workers.dev and preview URLs and declares no route;
- exposes only a same-account read inspection, while default HTTP returns 404;
- initializes a monotonic version-1 schema under `blockConcurrencyWhile` and
  `transactionSync`;
- implements the complete current `InventoryStore` over Durable Object SQLite;
- preserves atomic balance, immutable receipt, command result, and confirmation
  behavior without creating a second command engine;
- keeps Cloudflare code out of the platform-neutral package root;
- provides a local-only remote service-binding probe that is never deployed;
  and
- verifies the live hat SKU as explicit `not_found` with zero balances,
  commands, confirmations, and receipts.

No opening balance, public API, SmokyClub binding, EmDash integration, Commerce
provider, Block Kit GUI, package publication, or stock cutover is part of this
slice.

## Test-driven proof

Four useful red states were observed before the minimal corresponding behavior:

1. The deployment-contract test failed because `wrangler.jsonc` and
   `wrangler.probe.jsonc` did not exist.
2. The Cloudflare runtime suite failed to import the absent Worker entrypoint.
3. The inspection test failed because record counts were absent, proving the
   remote response could not yet demonstrate a zero-write probe.
4. A production confirmation-conformance test failed because Cloudflare's SQL
   cursor write-count behavior differed from local SQLite. The adapter now
   requires exactly one row from `UPDATE ... RETURNING`.

The fourth failure was discovered after the first private deployment but before
any mutation RPC existed. The database remained empty and read-only. The fix
passed all verification before the private Worker was replaced and the remote
zero-row probe was repeated.

## Repository verification

Final commands and results:

- `bin/verify-cloudflare-storage` -> strict type-check passed, 3 deployment
  contract tests passed, 5 Cloudflare runtime tests passed, Wrangler exact
  deploy dry-run passed;
- `npm run test:node` -> 37 passed, 0 failed;
- `git diff --check` -> passed;
- `sha256sum -c .grilltrack/proof/cycle-8/SOURCE_MANIFEST.sha256` -> all 24
  entries passed;
- GrillTrack ledger validation -> passed; and
- npm audit during dependency installation -> 0 vulnerabilities.

The runtime tests cover private HTTP posture, exact schema initialization,
not-found reads, zero business-row inspection, physical-pool isolation, atomic
command/receipt/balance commit, byte-stable replay, rollback on receipt
conflict, exact five-minute preview expiry, confirmation persistence/binding,
and receipt read-back through the production adapter.

## Live proof

The approved deploy created the generic Worker and `InventoryPool` SQLite
Durable Object export. Wrangler reported `No targets deployed`. A local probe
then used a remote same-account service binding to inspect the future live pool
with the current public hat SKU supplied only at runtime.

The response was schema version 1, explicit `not_found`, and exact zero counts
for balances, command results, confirmations, and receipts. The local probe was
shut down. Exact tenant/account/runtime identities, the Cloudflare version, and
source hashes are retained outside this public repository in
`machine-proof:inventory-cloudflare-pool-20260828/PROOF.md`.

Wrangler authorization was reduced from its 29-permission default to account
read, user read, background access, and Workers Scripts/Durable Objects write.
The credential is stored in the OS keyring and never entered repository or
proof content.

## Gates at verification cutoff

This proof was sealed while the implementation was isolated and uncommitted.
At that cutoff, no Inventory commit, push, pull request, merge, package
publication, live-site binding, or opening-balance mutation had been performed.
Subsequent separately authorized delivery is recorded by Git and the PR review
rail rather than retroactively rewriting this proof identity.

Before another product slice, the exact deployed source should be committed,
pushed to its stacked branch, opened as an Inventory PR, and routed through the
official exact-head review rail after Bobby authorizes those delivery actions.
