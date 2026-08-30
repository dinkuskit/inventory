# Cycle 15 TDD record

## Initial red

The first focused stock-transfer run failed before implementation because the
public `src/features/stock-transfer/index.ts` module and root composition export
did not exist. That established the feature boundary before source code.

## Focused behavior red

After the first implementation, a new metadata-only edit test failed:

```text
Expected negative_available warning; actual warnings: []
```

Cause: warnings were derived only from changed balance effects. Editing only a
note/reference produced no balance effect even when the origin remained
oversold. The implementation now derives warnings from the complete
post-command origin balances.

## Cross-feature red

Exact-source review added a transfer/opening-balance interaction test. It failed
with:

```text
OpeningBalancePreviewError: This SKU-location already has committed stock history.
```

Cause: a Created transfer materialized destination expected stock in a
no-physical-history row, while opening preview assumed every materialized row
was version 0/eligible only when absent. The previous commit path also inserted
or replaced instead of advancing that planning row.

The repair binds opening confirmation to the observed planning-row version,
uses compare-and-set update when the row exists, preserves all transfer
quantities, and durably rejects stale versions.

## Final green

- focused Node transfer tests: 8 passed;
- focused workerd/schema tests: 16 passed across 2 files;
- canonical Node suite: 89 passed;
- canonical workerd suite: 17 passed across 3 files;
- strict Cloudflare TypeScript check: passed;
- architecture contract: clean; and
- Wrangler deployment dry-run: passed without deploying.
