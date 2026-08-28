# GrillTrack cycle 7 proof

- track: `dinkuskit-inventory-v1`
- domain: authoritative balance and receipt read-back
- stacked baseline: `sha256:74007db421e3580441bd90d282ba3189b3af2135103caa29aa2563987d6344b8`
- git head: `2f100e3c94c60a8a154110d7db9da12b247ef9d9`
- decisions: `read-back-021`, `receipt-actor-022`
- reviewed source identity: `sha256:9c84e82f2e9e48d08613276e4ec0185f7385977e7c863de5beadaaff97a60c3b`
- production access or mutation: none
- delivery action: none

## Confirmed scope

Bobby confirmed one explicit SKU-location balance read and one exact mutation
lookup for audit or lost-response recovery. The bounded implementation:

- reads a balance only from an explicit pool, location, and SKU and returns a
  versioned `found` or `not_found` result;
- looks up exactly one stored mutation using either a receipt ID or command ID;
- returns the exact immutable committed result and receipt for either committed
  lookup path;
- returns a stable business rejection only by command ID and never invents a
  receipt;
- rejects blank or ambiguous lookup identity and never guesses a latest record;
- advances human receipts to schema v2 with trusted stable user ID,
  public-safe display-name snapshot, and originating surface;
- ignores actor-like command fields because the actor comes only from trusted
  execution context;
- binds confirmation and exact retry to stable principal identity (`kind`,
  `id`, and `surface`) while freezing the display name presented at commit; and
- keeps system principals valid without a fabricated human display name.

The Block Kit GUI, history lists, search, pagination, real EmDash authentication
or session wiring, service transport, Cloudflare binding or deployment,
Commerce, SmokyClub, publication, and production cutover remain outside this
slice. The local SQLite database remains disposable test evidence and cannot
become final storage.

## Implementation references

- `src/domain/inventory-read.ts`
- `src/application/read-inventory.ts`
- `src/domain/opening-balance.ts`
- `src/application/set-opening-balance.ts`
- `src/application/preview-confirm-opening-balance.ts`
- `src/storage/inventory-store.ts`
- `src/storage/local-sqlite-test-store.ts`
- `src/index.ts`
- `tests/opening-balance/read-back.test.mjs`
- `tests/opening-balance/preview-confirm-opening-balance.test.mjs`
- `tests/opening-balance/set-opening-balance.test.mjs`
- `bin/verify-opening-balance`
- `skills/opening-balance-verification/SKILL.md`
- `docs/implementation/opening-balance-read-back.md`
- `docs/implementation/opening-balance-preview-confirmation.md`
- `docs/implementation/opening-balance-local-slice.md`
- `docs/COMMAND-RECEIPT-CONTRACT.md`
- `docs/CHARTER.md`
- `README.md`
- `.grilltrack/ledger.json`
- `.grilltrack/events.jsonl`

## Test-driven proof

`tests/opening-balance/read-back.test.mjs` was added before the read boundary
was implemented. The red command was:

```text
bin/verify-opening-balance
```

It exited `1`: all 20 prior focused tests passed, then the new module failed to
load because `createReadInventoryMutation` was not exported. This proves the
new test failed for the absent behavior rather than a baseline regression.

The minimal implementation added versioned read query/results, two read-only
application functions, two storage read methods, receipt schema v2, stable
principal confirmation identity, and SQLite v3 test reads. A final system-actor
test was added to prove the human display-name requirement does not fabricate a
name for system receipts.

## Verification

Commands and results:

- `bin/verify-opening-balance` -> 26 passed, 0 failed;
- `npm test` -> 34 passed, 0 failed, including all workflow tests;
- Node TypeScript syntax checks with type stripping -> passed for every file
  under `src/`;
- `git diff --check` -> passed;
- GrillTrack `validate` -> passed;
- source snapshot `sha256sum -c` -> all 24 entries passed; and
- repository database-file scan -> no `.sqlite`, `.sqlite3`, `.db`, WAL, or
  shared-memory database artifact.

Behavioral proof covers balance found/not-found and location isolation,
committed read-back by receipt and command after database reopen, stable
rejection without a receipt, explicit missing identity, ambiguous/blank query
rejection, actor spoof resistance, rename-safe confirmation, immutable
commit-time display name on retry and read-back, human/system principal shapes,
and every earlier command, receipt, preview, confirmation, atomicity, and local
storage invariant.

## Fidelity limits and gates

The local test schema advances to `opening-balance-local/v3` solely as a
disposable compatibility fence for receipt schema v2. The adapter still
requires an explicit absolute file path, rejects `:memory:`, refuses
`NODE_ENV=production`, records its test-only role, and remains absent from the
platform-neutral root API.

The application principal is trusted context, not authentication proof. The
future EmDash adapter must derive it from an authenticated session. No HTTP
endpoint, credential, session reader, Cloudflare Durable Object, migration,
GUI, package publication, deployment, or production write is claimed.

Commit, push, pull request, merge, publication, deployment, and production
cutover remain separate gates. The work remains uncommitted in the isolated
stacked worktree; PR #7 and its exact head are unchanged.

## Exact-source review

The standards and confirmed-source-intent review is recorded in `REVIEW.md`
and bound to the 24-entry content manifest. It found no remaining issue.

## Recommended next focused grill

Define an undeployed Cloudflare SQLite Durable Object adapter that conforms to
the existing platform-neutral transaction and read ports. This directly proves
that Bobby's machine remains test-only without requiring accounts, deployment,
service transport, GUI, EmDash wiring, publication, or production cutover.

Credible alternatives are an Inventory-owned service request/response contract
without authentication or deployment, or a read-only receipt history contract
with explicit pagination and filters.
