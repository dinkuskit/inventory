# Opening-balance active-location admission

## Decision

Every new opening-balance command must resolve its explicit location ID to an
active Inventory location in the same pool. Unknown locations return the
durable `location_not_found` rejection. Archived locations return the durable
`location_not_active` rejection. Neither rejection creates a balance or an
opening-balance receipt.

Exact command replay remains first. A stored terminal result is returned before
consulting current location state, so an original commit or rejection never
changes after an archive, restore, or later location creation.

## Boundaries

| Component | Owns | Does not own |
| --- | --- | --- |
| Opening-balance application command | Atomic location admission, stable rejection, balance and receipt commit | Location creation, naming, archive policy, authentication |
| `InventoryTransaction` | Same-pool location lookup beside command and balance state | Cross-pool reads or fallback storage |
| Location lifecycle command | Active/archive state and permanent identity | Stock mutation execution |
| Future EmDash surface | Selecting from active locations and presenting rejection messages | Bypassing Inventory admission or inferring a location |

This repair changes no Worker route, preview GUI, authentication boundary,
schema, provider binding, Cloudflare account, or deployed database.

## Interface and result contract

The existing synchronous transaction interface is sufficient:

```ts
interface InventoryTransaction {
  getCommand<TResult>(commandId: string): StoredCommandResult<TResult> | null;
  getLocation(locationId: string): LocationRecord | null;
  getBalance(key: SkuLocationKey): BalanceRecord | null;
  storeRejection(record: StoredCommandResult): void;
  commitOpeningBalance(input: OpeningBalanceCommit): void;
}

type OpeningBalanceRejectionCode =
  | "location_not_found"
  | "location_not_active"
  | "opening_balance_already_set"
  | "command_id_conflict";
```

No storage-adapter signature changes. Both existing adapters already implement
pool-scoped `getLocation` inside their serialized transaction boundary.

## State and ordering contract

```text
stored command ID
  -> same digest: return original terminal result unchanged
  -> changed digest: return command_id_conflict

new command ID
  -> location absent: store location_not_found, no balance, no receipt
  -> location archived: store location_not_active, no balance, no receipt
  -> location active + prior stock history: store opening_balance_already_set
  -> location active + no stock history: commit balance + receipt + result
```

The location lookup, durable rejection, and successful stock commit occur in
the same `runTransaction` callback. A concurrent archive cannot interleave
between admission and balance commit. In the confirmed flow, confirmation
binding and the terminal opening-balance result remain part of that same
transaction.

## Invariants

- Every accepted command still names one explicit pool and location.
- Location membership is resolved from Inventory storage, never a caller hint.
- Archived and unknown locations receive no new balance row and no stock
  receipt.
- A durable rejection replays exactly even if the location is later restored
  or created under the originally unknown ID.
- A committed opening balance replays exactly even if the location later
  changes state.
- No receipt ID is requested until all location and prior-history admission
  checks pass.
- Commerce, EmDash, and clients never acquire a fallback ledger.

## Blast radius

| Surface | Direct callers or consumers | Risk | Required proof |
| --- | --- | --- | --- |
| `executeSetOpeningBalanceInTransaction` | direct set command and confirmed-preview command | High | local and Cloudflare active/archived/unknown scenarios; exact retry |
| exported rejection-code union | package consumers and command-result readers | Medium | strict TypeScript and full Node regression |
| opening-balance test fixtures | five Node test files | Medium | explicit active-location setup; all existing behavior remains green |
| Cloudflare runtime fixture | one Durable Object test module | High | same-pool active commit and archived/unknown rejection |
| opening-balance verifier and proof | maintainers and review rails | Medium | deterministic temporary-SQLite behavior transcript plus complete verifier |

There are two production execution callers, two transaction adapters, and no
new cross-process interface. The database schema and Worker HTTP surface do not
change.

## Zero-implementation review

Admission must occur after stored-command replay and before reading or creating
the SKU-location balance. Checking outside the serialized transaction would
permit archive/commit races. Treating an archived location as not found would
hide a useful operator distinction, while allowing caller-provided status would
break Inventory ownership. The minimal safe change therefore reads the
canonical location record once inside the mutation transaction and stores one
of the two stable business rejections before any receipt or balance work.
