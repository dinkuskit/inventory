# GrillTrack cycle 12 proof

- track: `dinkuskit-inventory-v1`
- domain: managed SKU registration at logical zero
- git baseline: `e32ac165cae5efd78390bee1f0306754aa7fabbb`
- branch: `codex/managed-sku-registration-20260828`
- decision: `managed-sku-registration-036`
- reviewed source identity:
  `sha256:65e909821319e3e6e069d9dcee58a3b33d134e81546e3612b87641c450e9475b`
- commit, push, pull request, merge, deployment, publication, production
  database access, or stock mutation: none

## Confirmed scope

Bobby confirmed the smallest Inventory-owned prerequisite for turning Commerce
`Manage stock` on:

- one awaited, pool-scoped `sku.register` command enrolls a required unique SKU;
- Inventory stores only the opaque SKU identity and v1 individual-item unit
  `each`, not product names, images, descriptions, prices, or categories;
- the first setup creates an immutable receipt identifying the trusted signed-in
  actor, with no typed reason;
- an exact command retry returns the original terminal result, while a new
  duplicate command durably says `This SKU is already set up.` without another
  SKU or receipt;
- a registered SKU reads as zero at every active location before initial stock;
  and
- opening preview and commit fail closed when registration is absent or the
  quantity unit differs.

Turning `Manage stock` off and case/box conversion remain deferred until a real
Inventory/Commerce/Blocks store flow is proven. GUI, integration adapters,
authentication deployment, publication, deployment, and production cutover
remain outside this slice.

## Architecture and blast radius

The zero-implementation contract and blast-radius report are in
`docs/implementation/managed-sku-registration.md`.

`ManagedSkuRecord` is pool-scoped and contains only SKU, unit, version, and
registration time. `RegisterManagedSkuCommandV1` uses the existing command,
principal, digest, result, and receipt contracts. One serialized transaction
inserts `inventory_skus`, `inventory_receipts`, and
`inventory_command_results`, so a receipt conflict rolls back all three.

Both SQLite adapters implement the same transaction and read methods. The
Cloudflare fresh-only schema advances to version 3 and the local test schema to
`opening-balance-local/v5`; neither invents a migration because no live
Inventory database exists. Older, partial, or unexpected storage still fails
closed.

Aggregate stock reads now use the registered record as existence and unit
authority. Opening preview rejects an absent registration before storing a
confirmation. Opening commit stores stable `sku_not_registered` or
`sku_unit_mismatch` rejections without a balance or receipt.

The changed public/store/schema surfaces are high risk inside Inventory but
have no cross-repository caller in this slice. Commerce, Blocks, SmokyClub,
EmDash, x-api, and shared review-conductor source are untouched.

## Test-driven proof

The managed-SKU tests were written before production implementation and first
failed with:

```text
SyntaxError: The requested module '../../src/index.ts' does not provide an export named 'REGISTER_MANAGED_SKU_TYPE'
```

After the domain, application, and storage boundary passed, the full Node and
Cloudflare suites exposed all older fixtures that had created opening stock
without registration. Those fixtures were updated to explicitly register their
SKU rather than weakening the new guard.

A second red test then proved the preview/unit gap and failed with:

```text
AssertionError: Missing expected rejection.
```

The minimal repair added unregistered preview admission and a durable opening
unit-mismatch result. The focused suite then passed all six cases.

## Verification

Commands and results:

- `npm test` -> 63 Node tests and 12 Cloudflare runtime tests passed;
- `npm run typecheck:cloudflare` -> passed;
- `npm run verify:managed-sku` -> 6 managed-SKU tests, 3 aggregate-stock
  regressions, 12 Cloudflare tests, and Cloudflare typecheck passed;
- broad TypeScript compile from `src/index.ts` with NodeNext module resolution
  -> passed;
- `git diff --check` -> passed;
- GrillTrack ledger validation -> passed; and
- `sha256sum -c .grilltrack/proof/cycle-12/SOURCE_MANIFEST.sha256` -> all 39
  entries passed.

Behavioral proof covers strict command normalization; actor-bearing receipt
shape; absence of catalog fields and reason; local SQLite close/reopen;
Cloudflare Durable Object SQLite persistence; pool isolation; exact replay;
changed-content command conflict; durable duplicate registration; atomic
rollback on receipt conflict; registered zero stock across active locations;
unknown-SKU `not_found`; opening preview admission; durable unregistered and
unit-mismatch rejection; aggregate read unit consistency; fresh schema v3; and
all prior opening-balance, location, receipt-history, workflow, and Worker
regressions.

## Fidelity limits and gates

The local adapter and Cloudflare runtime tests use disposable test state. They
prove the actual SQLite adapters and Durable Object transaction boundary, not a
deployed service or live database. The local machine is not a final storage
layer.

No live Cloudflare account, remote database, real SKU, customer data,
credential, external package, storefront, or production pool was accessed.
Registration is not remotely exposed in this slice. Commit, push, PR creation,
external review rails, merge, deployment, publication, and production cutover
remain separate gates.

## Recommended next focused grill

The next independent Inventory-owned frontier is the ordinary stock-adjustment
command with its mandatory editable reason. It can reuse the proven registered
SKU, explicit active location, awaited idempotent command, immutable actor
receipt, and atomic storage boundary without depending on Blocks, Commerce, or
the EmDash scheduler repair.

A credible alternative is to pause Inventory implementation until the owning
Commerce and Blocks tracks are ready for the first real-store end-to-end flow.
