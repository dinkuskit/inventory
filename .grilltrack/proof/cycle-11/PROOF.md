# GrillTrack cycle 11 proof

- track: `dinkuskit-inventory-v1`
- domain: one-location and all-locations aggregate stock read
- git baseline: `a4f9e1e91106886862ad4921e53424c5a21f675e`
- branch: `codex/inventory-aggregate-stock-read-20260828`
- decisions: `aggregate-stock-view-026`,
  `aggregate-stock-quantities-027`, `zero-stock-location-029`
- reviewed source identity:
  `sha256:570972f72d75464d9eab0b13dbe5cb5e846bcea5c9069154ee26e911c39195ef`
- commit, push, pull request, merge, deployment, publication, production
  database access, or stock mutation: none

## Confirmed scope

Bobby confirmed an Inventory-only, read-only query for one caller-supplied SKU
inside one explicit pool:

- location scope returns that active location's on-hand, reserved, and
  available quantities;
- all-locations scope returns exact totals plus every active location, with
  explicit zero rows for locations without a balance;
- archived locations remain outside the normal view;
- on-hand is the primary physical quantity, reserved remains visible, and
  available is derived from on-hand minus reserved; and
- this slice does not discover, register, or synchronize Commerce products.

The sibling Commerce grill was checked newest-first in bounded chunks before
implementation. It confirms that Commerce owns products and canonical SKUs,
managed SKUs will register into Inventory at logical zero, unmanaged products
never enter Inventory, and Inventory alone owns quantities. The active Commerce
PR deliberately excludes the live Inventory connection, so this work changes
no Commerce source and depends on none of its unmerged code.

## Architecture and blast radius

The zero-implementation contract and blast-radius report are in
`docs/implementation/aggregate-stock-read.md`.

`InventoryStore.readSkuActiveLocationSnapshot` is the only shared-interface
addition. Each SQLite adapter implements it as one statement that selects the
active location registry and left-joins one SKU's balances. This prevents a
mixed location/balance snapshot and supplies the existing deterministic
selector order. Application code fills a missing balance with zero only after
another active balance establishes the SKU unit.

The public result is versioned as
`dinkuskit.inventory.sku-stock-read-result/v1`. No active balance returns
`not_found` instead of inventing a unit. Mixed units fail closed. Exact signed
decimal values are summed with `BigInt` scale alignment rather than floating
point, and available is recomputed from on-hand minus reserved at each location
and for the headline total.

The Cloudflare Durable Object and private same-account service entrypoint expose
the same application result. No HTTP route, schema version, table, migration,
command, receipt, provider fallback, credential, or deployment configuration
changed. The local SQLite adapter remains explicit-path and test-only.

## Test-driven proof

The local aggregate tests were written before implementation and failed with:

```text
SyntaxError: The requested module '../../src/index.ts' does not provide an export named 'createReadSkuStock'
```

After the platform-neutral contract, application, storage interface, local
adapter, and exports were implemented, all three focused local tests passed.

The Cloudflare RPC test was then written before the Worker method and failed
with:

```text
TypeError: The RPC receiver does not implement "readSkuStock".
```

Adding only the Durable Object and private service methods made all 11
Cloudflare runtime tests pass. TypeScript then identified one callback-narrowing
error; capturing the normalized location ID before filtering repaired the
compile without changing behavior.

## Verification

Commands and results:

- `npm test` -> 56 Node tests and 11 Cloudflare runtime tests passed;
- `npm run typecheck:cloudflare` -> passed;
- `bin/verify-aggregate-stock-read` -> 3 focused Node tests, 11 Cloudflare
  tests, and Cloudflare typecheck passed;
- broad TypeScript compile from `src/index.ts` with NodeNext module resolution
  -> passed;
- `git diff --check` -> passed;
- database-artifact scan excluding `.git` and `node_modules` -> clean;
- GrillTrack ledger validation -> passed; and
- `sha256sum -c .grilltrack/proof/cycle-11/SOURCE_MANIFEST.sha256` -> all 29
  entries passed.

Behavioral proof covers normalized explicit scope; exact location reads;
all-active-location totals and ordering; durable close/reopen; explicit zeros;
archived and unknown exclusion; missing-SKU `not_found`; signed decimal sums;
derived available values even when a stored available value is stale; mixed
unit rejection; local and Cloudflare pool isolation; Durable Object RPC; and
the private service entrypoint.

## Fidelity limits and gates

The local tests use temporary SQLite files and the Cloudflare tests use the
repository's isolated Worker runtime. Neither is proof of a deployed Worker or
live database. The query accepts one supplied SKU; it is not a catalog list,
SKU registration command, Commerce integration, reservation/order-detail view,
or Block Kit GUI.

No live service, remote database, Cloudflare account, real SKU, customer data,
credential, package registry, site, or production pool was accessed. Commit,
push, PR creation, external review rails, merge, deployment, publication, and
production cutover remain separate gates.

## Recommended next focused grill

The aggregate read reveals the next missing Inventory-owned foundation:
idempotently register a managed SKU at logical zero, including its quantity
unit, without consuming the one-time opening-balance operation. That lets a
managed Commerce product exist in Inventory and appear at zero before initial
stock is set, while unmanaged products remain absent.

Credible alternatives are the ordinary stock-adjustment command with its
required editable reason, or pausing Inventory work until the active Commerce
foundation PR completes. The Block Kit GUI remains deferred.
