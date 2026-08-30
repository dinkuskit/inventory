# Transfer-list RED proof

Baseline source: `ff6dd9de3841dd95965849c1b0221b1551929656`.

No production source had been edited when this proof was captured. Only the
confirmed GrillTrack state, architecture/blast-radius documents, and new tests
were present.

Command:

```text
node --experimental-sqlite --experimental-strip-types --test \
  tests/stock-transfer/list-stock-transfers.test.mjs \
  tests/stock-transfer/public-entry.test.mjs
```

Result: exit `1` as expected.

Focused failure:

```text
SyntaxError: The requested module '../../src/index.ts' does not provide an
export named 'InvalidStockTransferListQueryError'
```

The new list suite failed at the missing public contract. The pre-existing
public-entry test remained green (`1` pass, `1` fail overall), so the RED is not
fixture, syntax, dependency, or baseline noise.
