# Transfer-list TDD proof

Baseline: `ff6dd9de3841dd95965849c1b0221b1551929656`.

## Initial contract RED

Before production source edits:

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/list-stock-transfers.test.mjs \
  tests/stock-transfer/public-entry.test.mjs

exit 1
SyntaxError: ../../src/index.ts does not provide
InvalidStockTransferListQueryError
existing public-entry test: passed
```

The complete captured result is in `RED.md`.

## Initial local GREEN

After the minimum public contract, application service, store port, local
adapter, and export implementation:

```text
focused list plus public entry: 4/4 passed
all stock-transfer Node tests: 20/20 passed
```

## Cloudflare parity RED/GREEN

The Cloudflare test was added before its adapter implementation:

```text
npx vitest run --config vitest.config.ts \
  tests/cloudflare/stock-transfer.test.mjs

RED: dependencies.store.listStockTransfers is not a function;
     2 existing tests passed, 1 new test failed
GREEN: 3/3 passed
npm run typecheck:cloudflare: passed
```

## Review-repair RED

Independent exact-diff review found three fail-closed defects and four proof
gaps. Repair tests were added before repair source:

```text
local list test: 4 passed, 1 failed
failure: Missing expected rejection for materialized/table status drift

Cloudflare stock-transfer test: 2 passed, 1 failed
failure: status-drift query resolved instead of rejecting
```

The same tests also cover impossible lifecycle dates and a null terminal date
that would otherwise disappear after a Done cursor.

## Review-repair GREEN

```text
local list test: 5/5 passed
Cloudflare stock-transfer test: 3/3 passed
```

The repair selects and checks materialized status against transfer JSON,
validates every status/date/null combination, and keeps null terminal sort
positions eligible after a cursor so corruption reaches the fail-closed reader.

## Final focused GREEN

```text
bin/verify-stock-transfer
  22/22 Node tests passed
  18/18 local Cloudflare tests passed across 2 files
  Cloudflare TypeScript check passed
```

The final suite additionally proves Done pagination across primary,
`updatedAt`, and transfer-ID tie-breakers; selected-active location visibility
with an archived opposite endpoint; durable default-50 and maximum-100 page
boundaries over 101 rows; and rejection before any storage call.
