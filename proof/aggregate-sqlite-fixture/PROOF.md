# Aggregate SQLite proof fixture repair — 2026-11-02

Base: `4bfb8ff05f8fd20b3f92a07293210483b1ff38cf` (current main).
Implementation/test commit: `075efb9`.
Node `24.22.0`; unchanged lockfile/dependency pins, using the existing clean
`npm ci --include=optional` layout from the process-cleanup verification.

## Failure and repair

`bin/prove-aggregate-stock-read-real` fails before launching Wrangler because
its local SQLite fixture attempts an opening balance for an unregistered SKU.
The opening correctly rejects under `managed-sku-registration-036`; the fixture
still expects `committed`. Its later stock assertion also predates the six-field
aggregate stock result.

Register the synthetic visible SKU through `createRegisterManagedSku` before
opening stock, with the same deterministic permanent Inventory ID used by the
existing proof. Keep the opening commit assertion, exact 7.5 quantity, two active
locations, and close/reopen. Assert all six current stock fields; nothing in the
product, stock admission, provider seam or runtime runner changes.

The new workflow test executes the actual proof program rather than inspecting
its source. It requires the complete populated aggregate result, including the
zero-stock Warehouse row. A second case checks that an existing file is refused
without changing its bytes. Both are included by the normal `test:node` glob.

## Checks and scope

- Same regression on the original fixture: **1 FAIL / 1 PASS**, at the opening
  outcome (`rejected` rather than expected `committed`). The baseline fixture
  was byte-identical to main; it was exercised in the #71 worktree, whose only
  other changes concern runner lifecycle, not this SQLite program.
- Candidate: **2 PASS**, including unchanged-file refusal.
- `bin/verify-inventory quick`: **PASS**, 300 Node tests, architecture checks,
  Cloudflare and plugin typechecks.
- `bin/verify-inventory full`: **PASS**, 75.78s, 300 Node tests, 29 Cloudflare
  tests, 16 hosted tests, Wrangler dry-run and plugin bundle validation.
- Integration control: local commit
  `372390f032afda436787e2d7abeb2431141c22fa` combines #71 head
  `33c686f2fd5afb4b7c5a31a265f95863aac08b35` with `075efb9`.
  `bin/prove-aggregate-stock-read-real` **exit0, no timeout, zero live tracked
  descendants** after natural exit. Fixture bytes match this contribution;
  runner/helper bytes match #71. This is combined-source evidence, not a claim
  that the unmodified main runner has correct process cleanup.

The integration output has populated SQLite `found` stock after reopen. The
private Worker binding returns **`not_found`** before/after reopening its
persisted state directory (15 files). That demonstrates the existing empty-pool
binding path, **not populated Durable Object aggregate stock**. No proof or
assertion was expanded to claim otherwise. The ordinary Cloudflare tests are
separate evidence. No Registry installation, production, live provider or
full #64 acceptance claim.

Two initial test launches without the dependency link failed at missing `zod`,
before fixture assertions; they are retained, not counted as product red/green.
The prepared runs above use the same unchanged locked dependency layout. Original
failure/success logs and the external PID-lineage observation are retained by
the contributor. No separate process group or production process was used.

Material AI assistance: pi / OpenAI gpt-6.1-sol generated this change and proof.
