---
name: stock-reservation-verification
description: Verify Inventory's named order-line reservation holds, fail-closed available checks, uniqueness, cancel-to-history release, and Cloudflare Durable Object parity.
---

# Stock reservation verification

Use this project-local skill after changing reservation domain, application,
storage, public exports, schema v5, or tests.

## Run

From the repository root:

```bash
bin/verify-stock-reservation
```

The focused verifier accepts no flags. It creates disposable SQLite files only
under the operating system temporary directory and removes them during test
cleanup. Cloudflare proof runs locally through Vitest/Miniflare. It does not
contact a deployed Worker, create a Cloudflare resource, or mutate production.

It proves named holds, fail-closed available checks, one active hold per
order/line, cancel-to-history release, command replay, and local/Cloudflare
schema v5 parity.

Before review or delivery, always run the canonical repository gate:

```bash
bin/verify-inventory full
```
