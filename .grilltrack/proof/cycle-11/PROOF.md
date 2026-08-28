# GrillTrack cycle 11 proof

- track: `dinkuskit-inventory-v1`
- domain: one-location and all-locations aggregate stock read
- git baseline: `a4f9e1e91106886862ad4921e53424c5a21f675e`
- branch: `codex/inventory-aggregate-stock-read-20260828`
- decisions: `aggregate-stock-view-026`,
  `aggregate-stock-quantities-027`, `zero-stock-location-029`
- reviewed source identity:
  `sha256:e99044222c6009b4d4e2ec97193744b7a585181f2d46cff66ae59243d197c5bf`
- pull request: `https://github.com/dinkuskit/inventory/pull/11`
- implementation commit: `a54b9a43427081dd82a7abf800df19128613c986`
- merge, deployment, publication, production database access, or stock
  mutation: none

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

- `npm test` -> 57 Node tests and 11 Cloudflare runtime tests passed;
- `npm run typecheck:cloudflare` -> passed;
- `bin/verify-aggregate-stock-read` -> 3 focused Node behavior tests, 1
  real-proof contract test, 11 Cloudflare tests, and Cloudflare typecheck
  passed;
- `npm run proof:aggregate-stock-read:real` -> populated a new 65,536-byte
  SQLite file, closed and reopened it, returned the expected found aggregate,
  then called the production Worker through a local private service binding,
  persisted its Durable Object state, closed and reopened the runtime, and
  returned the same versioned result;
- broad TypeScript compile from `src/index.ts` with NodeNext module resolution
  -> passed;
- `git diff --check` -> passed;
- database-artifact scan excluding `.git` and `node_modules` -> clean;
- GrillTrack ledger validation -> passed; and
- `sha256sum -c .grilltrack/proof/cycle-11/SOURCE_MANIFEST.sha256` -> all 35
  entries passed.

Behavioral proof covers normalized explicit scope; exact location reads;
all-active-location totals and ordering; durable close/reopen; explicit zeros;
archived and unknown exclusion; missing-SKU `not_found`; signed decimal sums;
derived available values even when a stored available value is stale; mixed
unit rejection; local and Cloudflare pool isolation; Durable Object RPC; and
the private service entrypoint.

The redacted real-runtime transcript is
`.grilltrack/proof/cycle-11/REAL_RUNTIME_TRANSCRIPT.txt`. Its harness contract
is repository-tested and its proof-only Cloudflare caller is included in the
strict Cloudflare typecheck.

## Fidelity limits and gates

The real-runtime proof uses disposable local state, not Bobby's machine as a
final storage layer. It proves a real SQLite file and the actual local Wrangler
private-binding/Durable-Object topology, but it is not proof of a deployed
Worker or live production database. The query accepts one supplied SKU; it is
not a catalog list, SKU registration command, Commerce integration,
reservation/order-detail view, or Block Kit GUI.

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
