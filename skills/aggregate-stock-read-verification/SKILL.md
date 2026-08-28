---
name: aggregate-stock-read-verification
description: Verify Inventory's read-only one-location and all-active-locations SKU stock contract across local SQLite and Cloudflare Durable Object storage.
---

# Aggregate stock read verification

Use this project-local skill after changing the aggregate SKU stock domain,
application read, exact-decimal arithmetic, active-location snapshot storage,
Cloudflare Durable Object RPC method, public exports, or their tests.

## Run

From the repository root:

```bash
bin/verify-aggregate-stock-read
```

The verifier accepts no flags. It creates task-owned local SQLite files under
the operating system's temporary directory and removes them during test
cleanup. Cloudflare tests use the local Miniflare/Vitest Durable Object
environment. It never opens a user-selected database, contacts a deployed
Worker, creates Cloudflare resources, or mutates production data.

The verifier proves:

- one caller-supplied SKU and explicit pool are required;
- location scope returns that active location only;
- all-locations scope returns exact totals plus every active location;
- active locations without a balance row appear as explicit zero;
- archived and unknown locations do not appear;
- missing SKUs return `not_found` without inventing a unit;
- signed decimals are summed exactly and available is derived from on-hand
  minus reserved;
- mixed units fail closed;
- local SQLite survives close/reopen;
- the Cloudflare Durable Object and private service expose the same result;
- Cloudflare TypeScript contracts compile.

## Expected result

Success exits `0` after the Node tests, Cloudflare tests, and Cloudflare
typecheck all pass. Any invariant failure, unavailable required runtime, or
compile error exits nonzero with diagnostics.

Run the complete repository regression suite separately:

```bash
npm test
```
