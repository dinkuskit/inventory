# Cycle 17 TDD record

## Initial red

Before any production source edit, the complete focused command/public/receive
set ran with three established tests passing and six receive-facing failures.
The domain and four durable scenarios all failed because
`transfer.receive` was not a supported command. The public-entry assertion
independently observed that `RECEIVE_STOCK_TRANSFER_TYPE` was absent. The
rollback scenario therefore could not yet reach its injected transaction
failure.

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/domain.test.mjs \
  tests/stock-transfer/public-entry.test.mjs \
  tests/stock-transfer/received-stock-transfer.test.mjs
```

Terminal summary: `9 tests`, `3 passed`, `6 failed`, exit `1`.

The durable RED scenarios already covered whole multi-line receipt,
wrong-state/stale/replay/conflict behavior, post-commit rollback, and receipt
after an emptied origin is archived. Their common unsupported-command failure
was the intended missing production boundary.

## Minimal green

The minimum production change added the exact command union/normalizer, one
In-transit-to-Received execution branch, destination physical-history truth,
public exports, and the two explicit receipt-history allowlists. The same
focused command completed with `9/9` passing.

Coverage then expanded without changing the locked behavior: canceled and
already-Received rejection, opening-balance exclusion, a separate linked
reasoned discrepancy adjustment, immutable receive receipt, destination-only
history scope, close/reopen durability, Cloudflare multi-line parity, and a
real adapter receipt-ID collision rollback.

Final green:

- focused Node stock-transfer tests: `17/17`;
- focused local Cloudflare tests: `17/17` across two files;
- Cloudflare TypeScript check: passed;
- adjacent opening-balance tests: `35/35`;
- adjacent stock-adjustment Node tests: `13/13`;
- adjacent stock-adjustment local Cloudflare test: `1/1`;
- canonical Node suite: `99/99`;
- canonical local Cloudflare suite: `18/18` across three files;
- architecture contract: clean; and
- Wrangler deployment dry-run: passed without deploying.
