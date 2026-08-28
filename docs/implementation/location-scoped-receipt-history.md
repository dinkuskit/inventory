# Location-scoped receipt history and opening-balance reason

This slice implements `receipt-history-scope-024` and
`opening-balance-reason-025` without adding a GUI, public route, or stock
mutation.

## Product contract

Inventory follows one Katana-style location context for read-only history:

- a caller explicitly selects one location or all locations inside one pool;
- one-location history contains only receipts with an effect at that location;
- all-locations history contains receipts across the pool, while every receipt
  retains its affected location identity; and
- all locations is a read scope only. Every mutation continues to require one
  exact location, or exact origin and destination for a future transfer.

The first bounded implementation is receipt history. Aggregate stock views,
the Block Kit selector, remembered user selection, purchase orders, and
manufacturing orders remain deferred.

## Read contract

```ts
type ReceiptHistoryScope =
  | Readonly<{ kind: "location"; locationId: string }>
  | Readonly<{ kind: "all_locations" }>;

type ReceiptHistoryCursor = Readonly<{
  committedAt: string;
  receiptId: string;
}>;

type ReadReceiptHistoryInput = Readonly<{
  poolId: string;
  scope: ReceiptHistoryScope;
  limit?: number;
  before?: ReceiptHistoryCursor;
}>;
```

`createReadReceiptHistory` normalizes the pool and scope, defaults the page size
to 50, rejects values above 100, and returns immutable receipts newest first.
`committedAt` and `receiptId` form a deterministic continuation cursor. A
location filter matches any effect in a receipt, so the contract remains valid
for future transfers and other multi-location receipts.

The application boundary asks storage for one extra row to determine whether a
continuation exists. Both SQLite adapters apply the same pool, location,
cursor, ordering, and limit predicates. They query the canonical receipt JSON
already stored in `inventory_receipts`; no table, migration, deployment, or
production-data rewrite is introduced.

## Opening-balance reason

The platform-neutral package exports:

```ts
const DEFAULT_OPENING_BALANCE_REASON_NOTE = "Set Initial Stock";
```

This is the exact initial value for the future editable GUI field. The domain
engine does not silently insert it: every preview and command must carry the
final trimmed, non-empty `reason.note`. The stable `reason.code` remains a
separate machine classification.

Because the normalized reason is part of the preview action and command
digests, editing it after preview invalidates that confirmation. A successful
commit freezes the final text on the immutable receipt, and an exact retry
returns the original stored result.

## Verification

The repository tests prove:

- the exact default text and required non-empty final reason;
- edited reason normalization, confirmation binding, receipt persistence, and
  exact replay behavior;
- explicit location and all-location query normalization;
- location filtering without pool leakage;
- deterministic bounded paging;
- local SQLite close/reopen history reads; and
- equivalent history behavior in Cloudflare's Durable Object SQLite runtime.

No test opens the production pool or creates a production stock balance.
