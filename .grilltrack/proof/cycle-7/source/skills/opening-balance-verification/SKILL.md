---
name: opening-balance-verification
description: Verify the Inventory-owned opening-balance command, preview/confirmation flow, authoritative read-back, actor receipts, and local test-only SQLite durability boundary.
---

# Opening-balance verification

Use this project-local skill after changing the opening-balance domain,
application command, preview/confirmation boundary, local SQLite test adapter,
receipt/result shapes, balance/mutation reads, actor identity, expiry/retry
behavior, or their tests.

## Run

From the repository root:

```bash
bin/verify-opening-balance
```

The verifier accepts no flags or environment-specific database path. Its tests
create real SQLite files under the operating system's temporary directory,
close and reopen them to prove command and unconfirmed-preview persistence, and
remove them during test cleanup. It covers the exact five-minute expiry,
immediate confirmation, action/principal binding, one-command token use, and
post-expiry exact retry. It also covers explicit balance found/not-found,
mutation lookup by receipt and command ID, stable rejection read-back,
historical display-name snapshots, actor spoof resistance, and restart
durability. It never opens a repository database, Cloudflare resource,
production service, or user-selected file.

## Expected result

Success exits `0` with every opening-balance test marked as passing. Any failed
invariant, unexpected exception, or unavailable required Node capability exits
nonzero with the Node test runner's diagnostic output.

Run the complete repository regression suite separately:

```bash
npm test
```
