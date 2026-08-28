# GrillTrack cycle 9 proof

- track: `dinkuskit-inventory-v1`
- domain: location-scoped receipt history and opening-balance reason
- git baseline: `ea8583131aae4ba63510b92b37cbcb94dff587c4`
- branch: `codex/inventory-location-history-reason-20260828`
- decisions: `receipt-history-scope-024`, `opening-balance-reason-025`
- reviewed source identity: `sha256:1c71bf104cc432119aa35274ca7204c29ff5585e647f3cde59fcb824a25fdc4f`
- production access, deployment, or stock mutation: none
- commit, push, pull request, or merge: none

## Confirmed scope

Bobby confirmed the Katana-style location model and opening-balance reason:

- read-only Inventory history explicitly selects one location or all locations
  within one pool;
- a selected location shows only receipts with an effect at that location;
- all locations shows receipts across the pool and keeps location identity on
  every receipt;
- all locations is never a mutation target;
- opening balance still requires one exact location;
- its editable Reason starts as exactly `Set Initial Stock`, may be replaced or
  appended, cannot be blank, and is frozen on the immutable receipt.

This bounded slice implements the platform-neutral receipt-history query,
local and Cloudflare SQLite read adapters, and opening-balance reason contract.
The Block Kit GUI, remembered selector, aggregate stock view, other adjustment
commands, purchase orders, manufacturing orders, EmDash authentication,
SmokyClub and Commerce integration, publication, deployment, and cutover remain
deferred.

## Architecture and blast radius

The public query uses an explicit discriminated scope:

- `{ kind: "location", locationId }`; or
- `{ kind: "all_locations" }`.

Results default to 50 receipts, reject limits above 100, order by
`committedAt DESC, receiptId DESC`, and return a stable continuation cursor.
Location filtering matches any effect in the immutable receipt, so it remains
valid for a future multi-location transfer receipt.

Both storage adapters query `receipt_json` already stored in the canonical
`inventory_receipts` table. There is no schema migration, second ledger,
fallback writer, public route, or Worker deployment. The highest blast radius
is a deliberate pre-1.0 command-input tightening: a final non-empty
`reason.note` is now required. Existing repository callers already supplied a
note, and new negative tests prove omission and blanks fail before storage.

## Test-driven proof

The reason and history tests were written before implementation.

`bin/verify-opening-balance` exited `1` with 27 prior/new-compatible tests
passing and five expected failures:

- missing `DEFAULT_OPENING_BALANCE_REASON_NOTE`;
- missing `createReadReceiptHistory` in two tests; and
- command and preview paths incorrectly accepting a missing reason note.

After clean-worktree dependencies were installed, the Cloudflare runtime test
also exited `1` because `createReadReceiptHistory` did not exist. These red
states bind the tests to absent behavior rather than a pre-existing pass.

The minimal implementation added the default constant, required normalized
note, versioned receipt-history query/result, one read-only application
function, one read-only store method, equivalent local/Cloudflare SQL filters,
and platform-neutral exports. No command engine, transaction, or schema was
duplicated.

## Final verification

Commands and results:

- `bin/verify-opening-balance` -> 32 passed, 0 failed;
- `npm test` -> 43 Node tests and 6 Cloudflare runtime tests passed;
- `bin/verify-cloudflare-storage` -> strict Cloudflare typecheck passed, 3
  deployment-contract tests passed, 6 runtime tests passed, and Wrangler
  deploy dry-run exited without deploying;
- broad strict TypeScript check over every `src/**/*.ts` file -> passed;
- `git diff --check` -> passed;
- GrillTrack ledger validation -> passed;
- database-artifact scan -> clean; and
- `sha256sum -c .grilltrack/proof/cycle-9/SOURCE_MANIFEST.sha256` -> all 33
  entries passed.

Behavioral proof covers exact default text, missing/blank reason rejection,
edited-reason trimming, confirmation mismatch after a reason edit, immutable
receipt preservation, local close/reopen history, explicit scope validation,
pool isolation, one-location filtering, all-location results, same-timestamp
ordering, bounded continuation, malformed cursor rejection, and Cloudflare
adapter parity.

## Fidelity limits and gates

This is a platform-neutral read and command-contract slice, not the visual
Katana-like interface. It does not yet aggregate balances across locations.
The current JSON-backed filtering is correct and avoids a live schema change;
future scale may justify a separately reviewed indexed receipt-location
projection and migration.

The Cloudflare tests use the local Durable Object runtime only. No live Worker,
production pool, real SKU, account, credential, package, or site was accessed.
The existing private production pool remains empty.

Commit, push, pull request, exact-head external review, merge, deployment,
publication, and production cutover remain separate gates.

## Exact-source review

The standards and source-intent review in `REVIEW.md` is bound to the 33-entry
manifest identity above and found no required fix.

## Recommended next focused grill

Define the read-only aggregate stock view for the same one-location versus
all-locations selector. It is the next smallest slice needed for the Katana
viewing model and remains independent of the active Blocks and EmDash work.

The credible alternative is to grill the ordinary post-opening stock-adjustment
command and its required location/reason contract before adding more reads.
