# Stock-transfer list read-model blast-radius analysis

Baseline: `ff6dd9de3841dd95965849c1b0221b1551929656`.

## Directly affected

| Surface | Change | Risk | Required proof |
| --- | --- | --- | --- |
| `src/features/stock-transfer/domain.ts` | Add public list schema/types, strict normalization, cursor validation contract | High interface risk: ambiguous scope or cursor reuse could expose the wrong list | Exact input rejection and cross-query cursor tests |
| `src/features/stock-transfer/read.ts` | Add list service and compact projection while preserving singular read | Medium: status/date mapping or page boundary could omit/repeat work | Open/Done ordering and multi-page tests |
| `src/storage/inventory-store.ts` | Add one required read-only list port | Medium: both implementations must stay structurally identical | Typecheck and adapter parity |
| Both SQLite stores | Filter by pool/view/scope, join endpoint metadata, and apply stable keysets | High read correctness risk; no mutation risk | Local durability plus Cloudflare parity |
| Feature/root export barriers | Add the supported list API | Medium public-package risk | Public-entry and architecture tests |
| Feature map, docs, verifier skill | Describe the implemented compatibility surface and proof | Low | Architecture/full verification and exact diff review |

## Callers and implementations inspected

- `InventoryStore` has exactly two concrete implementations: local SQLite test
  storage and Cloudflare SQLite Durable Object storage. Both must add the port
  in the same slice so the shared contract cannot drift.
- The stock-transfer detail reader is called across existing domain, local,
  Cloudflare, and regression tests. Its input/result behavior is unchanged.
- The package root and migrated feature index are the only supported import
  barriers. No consumer should import a storage adapter or sibling feature.
- `src/cloudflare/worker.ts` has no transfer-list route and remains unchanged;
  remote transport/auth is explicitly deferred.
- Existing transfer commands, receipts, balances, reservations, and location
  mutations do not call the new list port and remain unchanged.

## Confirmed unchanged durable boundaries

- No command, command ID, principal, confirmation, receipt, stock balance, or
  transfer lifecycle mutation is added.
- `inventory_transfers` already materializes `status` and retains the full
  transfer JSON with endpoint IDs, timestamps, version, lines, and reference.
- `inventory_locations` retains archived records with their permanent IDs,
  current names, and status. Archive does not delete endpoint facts.
- Cloudflare schema version remains `4`; local test schema version remains
  unchanged. No migration, backfill, or index is necessary.
- All Locations uses joined endpoint activity rather than a `UNION`, so one
  transfer cannot be emitted twice when both endpoints are active.

## Dependency and behavior risks

- Adding a required store method is compile-time breaking for any untracked
  third-party `InventoryStore` implementation. The repo currently owns exactly
  two implementations; the public interface addition and release implications
  must be visible in review.
- Endpoint display names are live registry names, not historical snapshots.
  Renaming a location changes list presentation without changing the immutable
  transfer ID or receipt history; this is intentional.
- A selected active location can be archived between pages. The next query
  returns `location_not_active`; it never silently falls back to All Locations.
- Missing endpoint rows, unparsable transfer JSON, or terminal records lacking
  their required date fail closed as durable corruption rather than being
  silently hidden.
- Open records can be edited or transition state while a caller pages. Keyset
  pagination prevents offset drift, but it is not a cross-request snapshot.
  This limitation is documented and does not weaken command atomicity.
- JSON extraction is correct for the initial scale but may scan a pool. Index
  optimization requires measured evidence and a separately grilled migration.

## Failure-mode matrix

| Scenario | Required outcome |
| --- | --- |
| Missing pool or malformed view/scope/limit | `InvalidStockTransferListQueryError`; store not called |
| Unknown selected location | Typed `location_not_found`; no rows or cursor |
| Archived selected location | Typed `location_not_active`; no rows or cursor |
| All Locations and no active endpoints | Successful empty page |
| One endpoint archived, other selected/active | Transfer visible once; archived endpoint labeled |
| Both endpoints archived | Excluded from normal All Locations page |
| Location is both origin and destination predicate match | Transfer emitted once |
| Cursor from another pool/view/scope | Rejected; never restarts at page one |
| Equal primary sort dates | `updatedAt` then immutable transfer ID provide deterministic continuation |
| Corrupt endpoint or required lifecycle date | Throw/fail closed |
| Store reopened from same local file | Same query result and continuation ordering |
| Existing command executed while list exists | Command behavior/atomicity unchanged |

## Verification plan

1. Baseline `bin/verify-stock-transfer` already passed: 17/17 Node, 17/17
   local Cloudflare across two files, and Cloudflare typecheck.
2. Add the new focused Node test and observe the missing-export RED before any
   production source edit.
3. Make the local application/storage path green and rerun every existing
   transfer test.
4. Add and observe Cloudflare parity RED, then implement its matching query and
   retain schema version 4.
5. Add the new test to architecture-required files and update the existing
   verifier skill; no duplicate runner is created.
6. Run `bin/verify-stock-transfer`, `bin/verify-location-registry`, canonical
   quick/full verification, `git diff --check`, and exact-source review.
