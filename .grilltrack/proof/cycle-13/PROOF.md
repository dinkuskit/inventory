# Cycle 13 proof: repository feature foundation

Decision: `repository-feature-foundation-037`

Verified source identity:
`git:59c2713d5211bfb634cba271afc80270d8c990c6`

Stack baseline:
`git:670c539303ba77db916f50012070bdd83ead4e4e` (Inventory PR #12)

## Implemented result

- `be62fbe` repairs the stale opening-balance verification fixture by
  registering its managed SKU before testing opening admission. It changes no
  application or storage behavior.
- `59c2713` adds the complete feature ownership map, canonical quick/full
  verifier, machine-enforced architecture audit, read-only CI contract, and
  repository-local verification skill.
- Managed SKU is the only moved feature. Its domain and registration behavior
  now live behind `src/features/managed-sku/index.ts`; the package root retains
  the same public runtime symbols and types.
- Opening balance, locations, stock reads, shared storage ports, local test
  storage, and Cloudflare production storage remain in their current owned
  paths.

## TDD evidence

The exact PR #12 baseline first failed `bin/verify-opening-balance` after its
64 Node tests and 14 workerd tests passed:

```text
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
+ actual - expected

+ 'rejected'
- 'committed'
```

The fixture then registered `sku_runtime_hat`, and the focused verifier passed.

Before the architecture implementation, the new architecture contract test
failed with:

```text
ERR_MODULE_NOT_FOUND: scripts/architecture-rules.mjs
```

Before the managed-SKU move, the public-entry parity test failed with:

```text
ERR_MODULE_NOT_FOUND: src/features/managed-sku/index.ts
```

The first rule-engine run also exposed a missed `export * from` syntax form.
The parser was tightened and the rejection test then passed, proving deep
feature re-exports cannot bypass the boundary.

## Exact-source verification

All commands below ran from a clean worktree at
`59c2713d5211bfb634cba271afc80270d8c990c6`.

| Command | Result |
| --- | --- |
| `git merge-base --is-ancestor 670c539303ba77db916f50012070bdd83ead4e4e HEAD` | pass; the branch is stacked directly on PR #12 history |
| `bin/verify-inventory full` | pass; architecture audit clean, strict Cloudflare typecheck, 68 Node tests, 14 workerd tests, deployment-contract tests, and Wrangler dry-run |
| `bin/verify-opening-balance` | pass; 35 Node tests plus deterministic active/archive/unknown local SQLite transcript |
| `bin/verify-location-registry` | pass; 7 Node tests |
| `bin/verify-aggregate-stock-read` | pass; 3 Node tests, disposable local-runtime proof, 14 workerd tests, and strict typecheck |
| `bin/verify-managed-sku` | pass; 8 Node tests, 14 workerd tests, and strict typecheck |
| `git diff --check 670c539303ba77db916f50012070bdd83ead4e4e..HEAD` | pass |
| task-owned database artifact scan excluding `.git` and `node_modules` | pass; no `.sqlite`, `.sqlite3`, `.db`, WAL, or SHM artifact remained |
| `git status --short` | clean |

`npm ci` installed the locked dependency tree with zero reported
vulnerabilities. Existing npm lifecycle-policy warnings were unchanged.

## Preserved contracts

- Inventory remains the sole canonical stock ledger.
- Commands remain awaited, idempotent, and pool-scoped with stable command IDs.
- Atomic durable writes, immutable receipts, exact retry, command conflict,
  location admission, logical-zero reads, and schema-v2-to-v3 behavior are
  unchanged and covered by the cumulative suites.
- The local SQLite adapter remains disposable-test-only and is not exported as
  a production fallback.
- The Cloudflare Worker remains private, with no route, tenant default,
  deployment, or live-database mutation.

## Gates and exclusions

No Commerce, Blocks, SmokyClub, EmDash, x-api, or review-conductor source was
changed. No account, authentication, secret, deployment, publication,
production mutation, merge, or cleanup action occurred. External review rails
were intentionally not invoked because Bobby retained that work.
