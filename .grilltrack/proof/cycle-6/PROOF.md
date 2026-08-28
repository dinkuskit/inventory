# GrillTrack cycle 6 proof

- track: `dinkuskit-inventory-v1`
- domain: opening-balance preview and confirmation boundary
- stacked baseline: `git:2f100e3c94c60a8a154110d7db9da12b247ef9d9`
- decision: `opening-balance-confirmation-020`
- reviewed source identity: `sha256:74007db421e3580441bd90d282ba3189b3af2135103caa29aa2563987d6344b8`
- production access or mutation: none
- delivery action: none

## Confirmed scope

Bobby confirmed an immediately usable opening-balance confirmation with a
five-minute maximum window and future visible countdown support. The bounded
implementation therefore:

- previews the exact normalized site, pool, location, SKU, quantity effect,
  reason, references, logical version zero, and resulting version-one balance;
- returns `expiresAt` exactly 300,000 milliseconds after issue so a future GUI
  can calculate a visible countdown without delaying confirmation;
- writes no balance, receipt, or command result during preview;
- stores only a SHA-256 digest of the opaque confirmation, bound to the action,
  explicit pool, and normalized principal;
- binds the first valid confirmation to one caller-created command ID in the
  same transaction as its committed or stably rejected command result;
- returns the exact original result for the same confirmation, command ID,
  normalized contents, and principal after expiry, restart, or a lost response;
  and
- fails closed for unconfirmed expiry, changed action, another principal, or a
  consumed token presented with another command ID.

The Block Kit GUI, service/authentication transport, Commerce, SmokyClub,
Cloudflare deployment, accounts, publication, and production cutover remain
outside this slice. The local database remains disposable test evidence and
cannot become final storage.

## Implementation references

- `src/domain/opening-balance.ts`
- `src/application/set-opening-balance.ts`
- `src/application/preview-confirm-opening-balance.ts`
- `src/storage/inventory-store.ts`
- `src/storage/local-sqlite-test-store.ts`
- `src/index.ts`
- `tests/opening-balance/preview-confirm-opening-balance.test.mjs`
- `tests/opening-balance/set-opening-balance.test.mjs`
- `bin/verify-opening-balance`
- `skills/opening-balance-verification/SKILL.md`
- `docs/implementation/opening-balance-preview-confirmation.md`
- `docs/COMMAND-RECEIPT-CONTRACT.md`
- `docs/CLI-SPEC.md`
- `docs/CHARTER.md`
- `README.md`
- `.grilltrack/ledger.json`
- `.grilltrack/events.jsonl`

## Test-driven proof

The new behavioral test file was written before implementation. The red command
was:

```text
bin/verify-opening-balance
```

It exited `1` because `src/index.ts` did not provide the new
`createConfirmOpeningBalance` export. The ten pre-existing opening-balance tests
passed and the new test module failed to load, proving the red state was caused
by the absent boundary rather than a baseline regression.

The minimal implementation then added the versioned preview types,
preview/confirm application functions, confirmation transaction port, SQLite
v2 test table, and a reusable transaction-level opening-balance evaluator. A
post-green atomicity test additionally proves that a receipt constraint failure
rolls back both the balance work and confirmation consumption, allowing the
exact approved request to succeed after storage recovers.

The pre-terminal source review identified that expiry had initially been read
before asynchronous digest work and transaction entry. The final source reads
the clock inside the transaction, so waiting before transaction evaluation
cannot extend the five-minute window.

## Verification

Commands and results:

- `bin/verify-opening-balance` -> 20 passed, 0 failed;
- `npm test` -> 28 passed, 0 failed, including all workflow tests;
- Node TypeScript syntax checks with type stripping -> passed for every file
  under `src/`;
- `git diff --check` -> passed;
- GrillTrack `validate` -> passed;
- source snapshot `sha256sum -c` -> all 20 entries passed; and
- repository database-file scan -> no `.sqlite`, `.sqlite3`, or `.db` file.

Behavioral proof covers exact preview shape and normalization, immediate use,
no preview mutation, exact five-minute expiry, unconfirmed-preview persistence,
post-expiry exact replay after reopen, changed action, another principal,
single-command token binding, atomic rollback, stable business rejection and
replay, plus every earlier command/receipt/storage invariant.

## Fidelity limits and gates

The SQLite schema advances to `opening-balance-local/v2` only because this is a
disposable local test adapter. Existing v1 test databases are deliberately
incompatible. The adapter still requires a caller-selected absolute path,
rejects `:memory:`, refuses `NODE_ENV=production`, records its test-only role,
and remains absent from the platform-neutral root API.

The injected principal is trusted application context, not authentication
proof. The injected token generator is responsible for production-grade
entropy. No HTTP endpoint, credentials, Cloudflare Durable Object, migration,
GUI, package build/publication, deployment, or production write is claimed.
Commit, push, pull request, merge, publication, deployment, and production
cutover remain separate gates for this slice.

## Review and delivery

The standards and confirmed-source-intent review is recorded in `REVIEW.md`
and bound to the content manifest above. The work remains uncommitted in the
isolated stacked worktree; PR #7 and its exact head are unchanged.

## Recommended next focused grill

Define the smallest read-only query boundary for one explicit SKU-location
balance and one immutable receipt. That lets a future UI refresh after commit
and prove what happened without adding Block Kit, authentication, Cloudflare
deployment, or another ledger.

Credible alternatives are an undeployed Cloudflare Durable Object adapter
conformance slice, or the Inventory-owned service request/response contract
without authentication or deployment.
