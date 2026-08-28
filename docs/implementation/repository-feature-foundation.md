# Inventory feature architecture and verification foundation

Status: confirmed zero-implementation design for GrillTrack decision
`repository-feature-foundation-037`.

Baseline: Inventory PR #12 at
`670c539303ba77db916f50012070bdd83ead4e4e`.

Reference model: the feature-map, repo-owned verifier, feature co-location, and
hard-boundary direction recorded by `saari-co/x-api#568`, then implemented
incrementally by DinkusKit Blocks and Commerce.

## Purpose

Inventory already has strong domain behavior, atomic storage boundaries, and
focused verification. This slice changes how agents find and safely extend that
behavior. It does not change any stock, command, receipt, location, managed-SKU,
schema, or Cloudflare runtime contract.

The repository will gain:

1. one complete `FEATURE_MAP.md` over current domain responsibilities;
2. one canonical `bin/verify-inventory quick|full` entry point;
3. executable feature-map, public-entry, and import-boundary checks;
4. one behavior-preserving managed-SKU feature pilot;
5. one repo-local verification skill for the canonical entry point.

Opening balance, location registry, and stock read remain at their current
paths and are explicitly marked `mapped current location`. Later moves require
separate focused decisions and parity proof.

## Feature ownership contract

`FEATURE_MAP.md` has one canonical table with these columns:

```text
Stable feature ID
Responsibility
Owned paths
Public entry point
Allowed shared dependencies
Fixtures and tests
Quick verifier
Full verifier
Public compatibility surface
Structure
```

The initial stable IDs are:

- `dinkus.opening-balance`
- `dinkus.location-registry`
- `dinkus.stock-read`
- `dinkus.managed-sku`

The map separately records shared kernel and adapter ownership:

- `src/storage/inventory-store.ts` is the platform-neutral persistence port;
- the local SQLite adapter is disposable-test-only;
- the Cloudflare SQLite adapter and `src/cloudflare/` are production adapter
  surfaces, not domain features;
- feature code may use only dependencies declared by the architecture rules.

## Managed-SKU pilot boundary

Only the two existing managed-SKU implementation files move:

```text
src/domain/managed-sku.ts
  -> src/features/managed-sku/domain.ts

src/application/register-managed-sku.ts
  -> src/features/managed-sku/register.ts
```

The new public feature entry is:

```ts
// src/features/managed-sku/index.ts
export {
  MANAGED_SKU_UNIT,
  REGISTER_MANAGED_SKU_TYPE,
  InvalidManagedSkuCommandError,
  digestRegisterManagedSkuCommand,
  normalizeRegisterManagedSkuCommand,
} from "./domain.ts";

export type {
  InventorySkuIdentity,
  ManagedSkuRecord,
  RegisterManagedSkuCommandV1,
  RegisterManagedSkuRejectionCode,
  RegisterManagedSkuResult,
} from "./domain.ts";

export { createRegisterManagedSku } from "./register.ts";
export type {
  RegisterManagedSku,
  RegisterManagedSkuDependencies,
  RegisterManagedSkuExecution,
} from "./register.ts";
```

`src/index.ts` composes this feature only through its `index.ts`. Code outside
the feature may not import `domain.ts` or `register.ts` directly. Storage
adapters consume `ManagedSkuRecord` and `RegisterManagedSkuResult` through the
feature entry. Managed-SKU tests consume either the package root or the feature
entry; only adapter-focused tests may import adapter internals.

The feature retains its existing declared dependencies:

- `src/domain/opening-balance.ts` for canonical command hashing and principals;
- `src/storage/inventory-store.ts` for the platform-neutral transaction port.

Those dependencies do not reverse ownership: managed-SKU still owns no SQL,
Cloudflare runtime, location, quantity, receipt, or Commerce state.

## Canonical verifier contract

```text
bin/verify-inventory quick
  -> architecture rule self-tests
  -> repository feature-map and import audit
  -> strict Cloudflare TypeScript check
  -> all platform-neutral Node tests

bin/verify-inventory full
  -> quick
  -> Cloudflare workerd tests
  -> deployment-contract tests and Wrangler dry-run
```

Both modes are non-interactive. They return `0` only when every child command
passes, return non-zero on the first failure, and print a final elapsed-time
success line. Existing `bin/verify-*` scripts remain valid focused developer
tools; they are delegates and diagnostics, not competing repository gates.

The canonical skill lives at
`skills/inventory-verification/SKILL.md` and documents the quick/full choice,
expected behavior, and failure rule.

## Hard invariants

The architecture audit fails when:

- `FEATURE_MAP.md` is absent, incomplete, contains duplicate IDs, references a
  missing path, or names a noncanonical verifier;
- a mapped migrated feature lacks `src/features/<domain>/index.ts`;
- code outside a migrated feature imports one of its internal files;
- a feature imports another feature anywhere except its `index.ts`;
- a migrated feature imports undeclared shared kernel or adapter source;
- `src/index.ts` bypasses a feature entry;
- the managed-SKU feature entry and root no longer expose identical runtime
  symbols;
- the canonical verifier or its repo-local skill is missing.

CI runs `bin/verify-inventory full` from a read-only-content workflow. No
credential, deployment, publication, or production mutation is added.

## Baseline drift repair

The pre-change baseline produced this exact focused-verifier failure after all
64 Node tests and 14 workerd tests passed:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'rejected'
- 'committed'
```

`scripts/verify-active-location-admission.mjs` still created an opening balance
without first registering its managed SKU. The minimal harness-only repair will
register the stable `sku_runtime_hat` identity before exercising active,
archived, and unknown location admission. Application source remains unchanged.

## Blast-radius report

### Symbols and paths

- Five source files import the old `src/domain/managed-sku.ts` path: the
  registration application, package root, shared store contract, and both
  SQLite adapters.
- Three consumers import the old registration-application path: package root,
  Cloudflare runtime tests, and the shared managed-SKU fixture.
- Eleven source/test files reference the managed-SKU public types or command
  factory.
- Twelve documentation, package, and verification-skill files name the focused
  verifier family.

### Risk matrix

| Surface | Risk | Reason | Required proof |
| --- | --- | --- | --- |
| managed-SKU file move | medium | exported types and factory move, but signatures remain byte-equivalent | root/feature parity, managed-SKU tests, full Node suite |
| root exports | high | future Commerce adapter consumes this public contract | exact export-name parity and strict compile |
| store imports | high | both durable adapters depend on record/result types | local reopen tests, workerd suite, Cloudflare typecheck |
| verifier consolidation | medium | contributor and CI entry point changes | red/green contract tests, quick/full smoke |
| feature-map/import audit | medium | new hard failure gate can block later PRs | rule unit tests for allowed and forbidden imports, repository clean audit |
| stale opening verifier | low | harness fixture only; product code is unchanged | observed red transcript then focused green rerun |

### Explicit exclusions

- no stock-command, result, receipt, balance, reservation, or schema change;
- no movement of opening-balance, location, read, storage, or Cloudflare files;
- no npm subpath publication contract in this private `0.0.0` package;
- no Commerce, Blocks, SmokyClub, EmDash, x-api, or review-rail source change;
- no UI, transport, authentication, account, deployment, production database,
  publication, or merge action.

## Verification sequence

1. capture the stale opening verifier failure on the exact baseline;
2. repair only its managed-SKU fixture and prove the focused verifier green;
3. add failing repository-architecture tests before any new architecture files
   or managed-SKU move;
4. add the map, rule engine, canonical verifier, CI workflow, and verification
   skill until the architecture tests pass;
5. move the managed-SKU pilot behind its feature entry, updating every caller;
6. run the focused managed-SKU and opening verifiers;
7. run `bin/verify-inventory quick` and `bin/verify-inventory full`;
8. run every retained focused verifier to prove maintenance compatibility;
9. validate GrillTrack, source manifests, and `git diff --check`;
10. review standards and confirmed intent against one immutable source identity.

## Zero-implementation review

The design preserves the sole Inventory ledger, awaited idempotent commands,
atomic store transactions, immutable stock receipts, hidden managed-SKU
identity, explicit pool/location requirements, v2-to-v3 migration, and
fail-closed provider boundary. It changes only repository navigation,
verification orchestration, import authority, and one file-placement pilot.

The compact pilot avoids a cross-repository contract change and follows the
incremental Blocks precedent: map all current ownership first, enforce the new
path, then migrate later domains one at a time with their own proof.
