# Cycle 18 exact-source review

Final result: clean after one repair cycle.

Source identity: `SOURCE_IDENTITY.txt`, changed-source manifest SHA-256
`4eb90a36d9bc326335d5557575c3ad37d0b33d8d62b6e3e1c98abbe633fc0e8c`.

Two independent read-only reviewers inspected the complete 16-file
non-GrillTrack change against baseline
`ff6dd9de3841dd95965849c1b0221b1551929656` and the six locked decisions.

## First-pass classifications

### Required fixes

1. Done keyset predicates excluded a `NULL` terminal sort date after a cursor,
   allowing a corrupt Received/Canceled record to disappear permanently.
2. Storage used materialized status to choose ordering but projection used JSON
   status; same-view drift could therefore return a plausible row in the wrong
   position.
3. Projection checked only some required dates and did not reject incompatible
   populated lifecycle fields.

### Required proof repairs

1. Done `<` paging and both deterministic tie-breakers lacked explicit parity
   proof.
2. A selected active location with an archived opposite endpoint lacked an
   explicit assertion.
3. Default-50 and maximum-100 behavior lacked durable 101-row boundary proof.
4. Invalid-input tests did not explicitly prove storage remained untouched.

No finding required a product-scope change, migration, remote action, or human
gate.

## Repair adjudication

- Null terminal sort positions remain eligible in both adapters after a cursor
  and therefore reach the existing position validator.
- Both adapters select materialized status and compare it to the parsed transfer
  before projection.
- Projection enforces complete Created, In-transit, Received, and Canceled
  lifecycle date/null invariants.
- Local and Cloudflare tests cover Done terminal-date, `updatedAt`, and transfer
  ID continuation; archived-opposite selected-location behavior; durable
  50/100 boundaries; pre-storage rejection; and all three corruption classes.

Both original reviewers re-inspected only their findings and confirmed every
one resolved. Focused repair tests passed `5/5` locally and `3/3` on Cloudflare.
The final canonical repository gate passed `104/104` Node tests, `19/19`
Cloudflare tests, TypeScript, architecture checks, and Wrangler dry-run.

## Final inspection

- The API is additive and public only through the stock-transfer feature entry
  and package composition root.
- Query normalization is strict; cursors are versioned, opaque, query-bound,
  and never treated as authorization.
- Open/Done membership, effective dates, mixed-direction tie-breakers, and
  keyset predicates agree in application, local SQLite, and Cloudflare SQLite.
- Selected location never falls back; All Locations emits one row only when at
  least one endpoint remains active; missing endpoint facts fail closed.
- Compact rows contain only the locked list fields and use current endpoint
  names/status with permanent IDs.
- The store reads requested `limit + 1`; page size may change safely while a
  pool/view/scope-bound cursor is reused.
- Existing transfer detail, mutation, balances, receipts, schema, migrations,
  Worker routing, and other repositories remain untouched.

No unresolved `required_fix`, `reject_false_positive`, `defer`, or `human_gate`
finding remains. Keyset paging is deterministic absent a concurrent edit that
moves an existing Open record; cross-request snapshot semantics and measured
index optimization remain explicitly outside this slice. Official PR review
rails must bind a new verdict to any eventual committed PR head.
