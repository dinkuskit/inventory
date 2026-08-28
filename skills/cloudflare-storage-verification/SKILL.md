---
name: cloudflare-storage-verification
description: Verify Inventory's private Cloudflare Worker, versioned SQLite Durable Object schema, production storage adapter, pool isolation, atomic opening-balance and location-registry behavior, and deployable no-route configuration.
---

# Cloudflare storage verification

Use this project-local skill after changing the Cloudflare Worker, Durable
Object schema, production SQLite adapter, Wrangler configuration, local remote
probe, pool routing, or Cloudflare runtime tests.

## Run

From the repository root:

```bash
bin/verify-cloudflare-storage
```

The verifier accepts no flags. It type-checks the Cloudflare boundary, checks
the no-public-route deployment contract, executes the production adapter and
Durable Object tests locally, and asks Wrangler to build the exact deployment
as a dry run in a task-owned temporary directory. It never authenticates,
deploys, calls a remote service, initializes a production object, or mutates
stock.

The runtime suite proves direct fresh version-2 schema initialization, exact
idempotency, fail-closed rejection of legacy-shaped storage without mutation,
explicit not-found reads, pool isolation, atomic balance/receipt/command
commit, active-location opening-balance admission, archived/unknown rejection
without stock or receipt, exact opening-balance and location-command retry, and
rollback on immutable receipt conflict. The deployment contract
rejects committed account, tenant, pool, location, SKU, route, or
public-preview defaults.

## Expected result

Success exits `0` after TypeScript, Node, Vitest, and Wrangler all succeed. Any
failed invariant, compilation error, runtime failure, or invalid deployment
configuration exits nonzero with the owning tool's diagnostic output.

Run the complete repository regression suite separately:

```bash
npm test
```
