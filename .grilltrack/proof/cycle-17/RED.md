# Strict TDD RED proof

Baseline production source:
`b520b5ff7189a4180ad30f8e95d4db4d80a7a6e3`.

## Domain/public contract RED

Command:

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/domain.test.mjs \
  tests/stock-transfer/public-entry.test.mjs
```

Observed: 5 tests, 4 passed, 1 failed. The receive normalization case failed
at `normalizeStockTransferCommand` with
`InvalidStockTransferCommandError: type must be a supported stock transfer command.`

## Durable behavior RED

Command:

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/received-stock-transfer.test.mjs
```

Observed after the complete RED set was assembled: 9 tests across the domain,
public entry, and receive files; 3 existing tests passed and 6 receive-facing
tests failed. The domain and four durable receive scenarios failed at the
absent `transfer.receive` normalization path, while the public-entry assertion
observed the missing runtime constant. The rollback case failed before reaching
its injected transaction error for the same missing-command reason.

These failures are the intended missing behavior, not a fixture, import, or
environment failure. No production source had been edited when they were
captured.
