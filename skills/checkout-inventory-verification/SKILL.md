---
name: checkout-inventory-verification
description: Verify Inventory's whole-basket CheckoutInventoryPort adapter, atomic holds, terminal release fence, and local/Cloudflare durable storage proof.
---

# Checkout inventory verification

Use this project-local skill after changing checkout-inventory domain,
application, storage batch inserts, public exports, or tests.

## Run

From the repository root:

```bash
bin/verify-checkout-inventory
```

The focused verifier accepts no flags. It creates disposable SQLite files only
under the operating system temporary directory and removes them during test
cleanup. Cloudflare proof runs locally through Vitest/Miniflare. It does not
contact a deployed Worker, create a Cloudflare resource, or mutate production.

It proves whole-basket atomic reserve, no partial basket, restart/replay,
configured binding admission on first call and after factory restart, site-bound
operation identity, terminal release fencing, fail-closed missing/ambiguous
release, binding/content conflicts, unsupported backorder rejection,
scarce-stock concurrency, and local/Cloudflare durable storage.

Before review or delivery, always run the canonical repository gate:

```bash
bin/verify-inventory full
```
