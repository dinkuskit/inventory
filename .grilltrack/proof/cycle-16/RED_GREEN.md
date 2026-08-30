# Cycle 16 TDD record

## Initial red

Before production implementation, the focused command/read tests ran with four
passes and four failures. The failures proved both missing boundaries:

- `transfer.dispatch` and `transfer.reopen` were rejected as unsupported
  command types;
- the stock-transfer read result had no `lineStock` context; and
- the rollback test could not reach persistence because dispatch normalization
  failed first.

The command was:

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/domain.test.mjs \
  tests/stock-transfer/public-entry.test.mjs \
  tests/stock-transfer/in-transit-stock-transfer.test.mjs
```

Terminal summary: `8 tests`, `4 passed`, `4 failed`, exit `1`.

## Minimal green

After adding only the command union, transition arithmetic, contextual read,
exports, receipt-history admission, and required adapter-neutral behavior, the
focused Node suite passed. Subsequent coverage added multi-SKU transitions,
other-transfer exclusion, automatic-date input rejection, Cloudflare receipt
history, and exact receipt-shape compatibility.

Final green:

- focused Node stock-transfer tests: `13/13`;
- focused local Cloudflare tests: `16/16` across two files;
- Cloudflare TypeScript check: passed;
- canonical Node suite: `95/95`;
- canonical local Cloudflare suite: `17/17` across three files;
- architecture contract: clean; and
- Wrangler deployment dry-run: passed without deploying.
