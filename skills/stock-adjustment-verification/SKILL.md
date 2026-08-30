---
name: stock-adjustment-verification
description: Verify Inventory's signed-delta stock-adjustment command, preview, confirmation, atomic storage, receipt history, and Cloudflare Durable Object parity.
---

# Stock adjustment verification

Use this project-local skill after changing ordinary stock-adjustment domain,
application, storage, public exports, receipt-history integration, or tests.

## Run

From the repository root:

```bash
bin/verify-stock-adjustment
```

The focused verifier accepts no flags. It creates disposable SQLite files only
under the operating system temporary directory and removes them during test
cleanup. Cloudflare proof runs locally through Vitest/Miniflare. It does not
contact a deployed Worker, create a Cloudflare resource, or mutate production.

It proves signed exact deltas, mandatory note-only reasons, zero rejection,
explicit location/SKU/version admission, non-mutating preview, the five-minute
principal/action/version-bound confirmation, exact oversell warnings, atomic
balance/receipt/result commit, immutable actor receipts, durable replay and
conflict, stale-preview rejection, rollback, mixed stock history, and local/
Cloudflare storage parity without a schema migration.

Before review or delivery, always run the canonical repository gate:

```bash
bin/verify-inventory full
```

For contributor-supplied behavior proof outside Node Test, Vitest, and
Miniflare test harnesses, run:

```bash
npm run proof:stock-adjustment:real
```

This starts a loopback-only Wrangler Durable Object with disposable persisted
state, performs preview and confirmation, stops Wrangler, reopens the same
state, and proves exact terminal-result replay. It prints a redacted transcript,
never uses `--remote`, and deletes the temporary state on exit.
