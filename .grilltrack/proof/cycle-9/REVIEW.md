# GrillTrack cycle 9 exact-source review

- source identity: `sha256:1c71bf104cc432119aa35274ca7204c29ff5585e647f3cde59fcb824a25fdc4f`
- manifest: `.grilltrack/proof/cycle-9/SOURCE_MANIFEST.sha256`
- baseline: `git:ea8583131aae4ba63510b92b37cbcb94dff587c4`
- result: clean
- remaining findings: none

## Manifest verification

- The manifest hash matches the recorded source identity.
- `sha256sum -c` passed for all 33 entries.
- The manifest covers repository instructions, product contracts, focused
  implementation designs, domain/application/store boundaries, both SQLite
  adapters, Cloudflare schema/Worker context, public exports, behavioral tests,
  and both repo-owned verifiers.

## Standards review

Passed.

- Work is isolated on
  `codex/inventory-location-history-reason-20260828` from exact merged
  `origin/main` baseline `ea8583131aae4ba63510b92b37cbcb94dff587c4`.
- The existing Inventory checkout is unchanged. No Blocks, SmokyClub,
  Commerce, EmDash, x-api, or shared review-conductor file was touched.
- Public source contains no credential, tenant/customer data, business figure,
  production identifier, or production configuration.
- The package remains private at `0.0.0`. No route, database migration, second
  writer, fallback ledger, account action, deployment, publication, or stock
  mutation was introduced.
- The local SQLite adapter remains test-only and outside the package root. The
  Cloudflare adapter remains bound to one explicit pool and rejects cross-pool
  history reads.
- Focused tests, full regression, local and Cloudflare runtime verification,
  strict typechecks, Wrangler dry-run, ledger validation, manifest validation,
  database-artifact scan, and `git diff --check` passed.

## Confirmed source-intent review

Passed.

- `ReceiptHistoryScope` represents exactly one location or all locations; it
  has no mutation use and does not alter existing command context types.
- Normalization requires an explicit pool, requires a location ID only for the
  location variant, rejects a location ID on `all_locations`, and caps pages at
  100.
- The application boundary remains read-only. It requests one extra row only
  to determine continuation and returns immutable receipts newest first.
- Both SQLite adapters constrain by embedded canonical pool. The Cloudflare
  adapter additionally requires the query pool to match its object-bound pool.
- Location filtering checks every receipt effect instead of assuming a
  one-effect opening balance, preserving future transfer compatibility.
- `committedAt` plus `receiptId` provides deterministic ordering and a stable
  before-cursor, including equal timestamps.
- `DEFAULT_OPENING_BALANCE_REASON_NOTE` is exactly `Set Initial Stock`, exposed
  for a future editable GUI rather than silently inserted by the command
  engine.
- Command and preview normalization require a trimmed non-empty final note.
  That normalized note participates in existing action/command digests, so a
  post-preview edit fails confirmation and an exact retry retains its original
  terminal identity.
- Commit copies the final normalized reason into the same immutable receipt
  atomically stored with balance and command result. No replay, conflict,
  rejection, principal, expiry, or rollback invariant changed.
- Existing explicit pool/location requirements and the ban on an
  all-locations mutation remain intact.

## Blast radius and fidelity

The public InventoryStore interface gains one read method, and both known
implementers were updated and tested. The opening-balance command input now
requires the human-readable note that repository callers already provided.
There is no public network consumer, published package, live stock row, or
database migration in this slice.

The visual selector, aggregate stock view, other mutation types, authentication,
and integrations are deliberately absent. JSON-path history filtering may
later need an indexed projection for scale, but it is correct, bounded, and
avoids prematurely changing the empty production schema. The reviewed source
has no `required_fix`, `reject_false_positive`, `defer`, or `human_gate`
finding and requires no repair cycle.
