# GrillTrack cycle 5 proof

- track: `dinkuskit-inventory-v1`
- domain: opening-balance kernel with local durability proof
- baseline: `git:d1603797aef020224c4a7d6dc8f215a1cea51820`
- decision: `opening-balance-storage-019`
- reviewed source identity: recorded in `SOURCE_MANIFEST.sha256`
- production access or mutation: none
- delivery action: none

## Confirmed scope

Bobby confirmed that the first executable `Set opening balance` slice should
use a real local SQLite database for testing, with one hard product constraint:
the local machine and its database must never become the final or production
storage layer.

The bounded implementation therefore:

- accepts one versioned command with explicit site, pool, location, SKU,
  non-negative exact quantity, reason, command ID, and expected version zero;
- owns normalization, SHA-256 command-content identity, exact replay,
  changed-content conflict, and stable second-opening rejection;
- atomically commits one SKU-location version-1 balance, immutable receipt,
  and terminal result;
- proves other locations remain independent;
- writes only caller-selected absolute local test files and refuses in-memory,
  production-mode, unrelated, and schema-incompatible SQLite storage;
- keeps the domain/application command behind a platform-neutral transaction
  port; and
- leaves the Cloudflare SQLite Durable Object as the separately gated
  production direction.

Block Kit, SmokyClub, Commerce, EmDash runtime adapters, authentication,
accounts, Cloudflare deployment, package publication, and production cutover
remain outside this slice.

## Implementation references

- `src/domain/opening-balance.ts`
- `src/application/set-opening-balance.ts`
- `src/storage/inventory-store.ts`
- `src/storage/local-sqlite-test-store.ts`
- `src/index.ts`
- `tests/opening-balance/set-opening-balance.test.mjs`
- `bin/verify-opening-balance`
- `skills/opening-balance-verification/SKILL.md`
- `docs/implementation/opening-balance-local-slice.md`
- `README.md`
- `docs/CHARTER.md`
- `package.json`
- `.grilltrack/ledger.json`
- `.grilltrack/events.jsonl`

## Test-driven proof

Red command:

```text
node --experimental-sqlite --experimental-strip-types --test tests/opening-balance/*.test.mjs
```

Observed before source existed: exit `1` with `ERR_MODULE_NOT_FOUND` for
`src/index.ts`; 0 passing and 1 failing test file.

The post-green safety review found that the first adapter draft could claim an
unrelated SQLite file or overlook an incompatible local-test schema version.
A new refusal test was added first and observed failing with `Missing expected
exception`. The adapter initialization was then changed to inspect before DDL,
reject foreign files without adding tables, and require the exact local-test
schema metadata and table set.

The exact-source intent review then found that the test-only adapter was
exported from the platform-neutral package root. A boundary test was added
first and observed failing (`true !== false`); the root export was removed so
only domain, application, and transaction-port contracts are public from
`src/index.ts`.

## Verification

Commands and results:

- `bin/verify-opening-balance` -> 10 passed, 0 failed;
- `npm test` -> 18 passed, 0 failed, including every pre-existing workflow
  test;
- TypeScript syntax checks with Node type stripping -> passed for every file
  under `src/`;
- `git diff --check` -> passed;
- GrillTrack `validate` -> passed; and
- repository database-file scan -> no `.sqlite`, `.sqlite3`, or `.db` file.

Behavioral proof covers first commit, receipt/balance agreement, location
isolation, normalized byte-stable replay after database reopen, changed-content
conflict, persisted second-opening rejection, competing command IDs, rollback
after a receipt constraint failure, malformed request refusal, and every local
storage fence.

## Fidelity limits and gates

This is a local kernel and storage-boundary proof. The SQLite schema is
explicitly disposable development/test evidence, not a production migration
format. The adapter refuses `NODE_ENV=production`, has no default path, refuses
`:memory:`, records `storage_role=local-development-test-only`, and refuses to
modify an unrelated database.

No HTTP service, authentication, permissions adapter, preview token, Block Kit
screen, EmDash plugin, Commerce provider, Cloudflare object, export/restore,
deployment, production inventory write, or compatibility claim was created or
exercised. Commit, push, pull request, merge, publication, deployment, and
production cutover remain separate gates.

## Review and delivery

The standards and confirmed-source-intent review is recorded in `REVIEW.md`
and bound to `SOURCE_MANIFEST.sha256`. No delivery action was authorized or
performed.

## Recommended next focused grill

Define the Inventory-owned opening-balance preview and confirmation boundary:
a server-validated preview, short-lived confirmation bound to the exact action,
and safe stale or changed-action rejection over this proven command kernel.
This remains independent of Block Kit and the active EmDash scheduler work.

Credible alternatives are read-only balance/receipt query models for refresh
and audit, or an undeployed Cloudflare Durable Object conformance plus
export/restore spike against the platform-neutral transaction contract.
