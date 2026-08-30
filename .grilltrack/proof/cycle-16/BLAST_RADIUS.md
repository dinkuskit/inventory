# Stock-transfer dispatch and reversal blast radius

## Direct owners

- `src/features/stock-transfer/domain.ts`: command union, normalization,
  rejection codes, line-stock read shape, and receipt/result types.
- `src/features/stock-transfer/execute.ts`: admission, transition arithmetic,
  warnings, immutable receipts, and atomic commit construction.
- `src/features/stock-transfer/read.ts`: current-transfer-aware movable stock
  and destination on-hand context.
- `src/features/stock-transfer/index.ts` and `src/index.ts`: strict public export
  barriers.

## Shared persistence consumers

- `src/storage/inventory-store.ts`: existing `StockTransferCommit` already
  accepts the required transfer, balance vector, receipt, and result; no port
  change is required.
- `src/storage/local-sqlite-test-store.ts`: existing optimistic transfer and
  balance writes are sufficient; receipt-history type filter must include
  dispatch and reopen.
- `src/storage/cloudflare-sqlite-inventory-store.ts`: same as the local adapter.
- `src/cloudflare/schema.ts`: v4 already has `on_hand`, `reserved`, `outgoing`,
  `available`, `expected`, and `in_transit` plus the `in_transit` transfer
  status. No schema or migration change is justified.

## Read/audit consumers

- `src/domain/location-registry.ts` and `src/domain/inventory-read.ts` consume
  the stock-transfer result/receipt unions through the feature index, so the
  widened command receipt type flows through without an internal import.
- Receipt-history SQL in both adapters currently enumerates only create,
  update, and cancel and would silently omit the new immutable receipts unless
  changed.
- Existing location archive blockers already include on-hand, outgoing,
  expected, and in-transit, so transitions remain protected without changes.

## Verification and documentation consumers

- `tests/stock-transfer/`, `tests/cloudflare/stock-transfer.test.mjs`, and
  `tests/cloudflare/inventory-pool.test.mjs` cover the feature and schema parity.
- `bin/verify-stock-transfer`, `skills/stock-transfer-verification/SKILL.md`,
  `FEATURE_MAP.md`, `docs/CHARTER.md`, `docs/CLI-SPEC.md`, and the implementation
  contract must describe and prove the expanded boundary.
- Repository architecture checks require all external consumers to continue
  importing through `src/features/stock-transfer/index.ts`.

## Proven exclusions

No source or runtime dependency was found on Commerce, Blocks, SmokyClub,
EmDash, x-api, scheduler materialization, external accounts, deployment, or a
live database. The slice is independently executable in the Inventory-owned
platform-neutral kernel with disposable local SQLite and local Miniflare proof.
