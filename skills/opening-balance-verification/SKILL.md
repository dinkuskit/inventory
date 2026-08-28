---
name: opening-balance-verification
description: Verify the Inventory-owned opening-balance command, active-location admission, required editable reason, preview/confirmation flow, location-scoped receipt history, authoritative read-back, actor receipts, and local test-only SQLite durability boundary.
---

# Opening-balance verification

Use this project-local skill after changing the opening-balance domain,
application command, preview/confirmation boundary, local SQLite test adapter,
receipt/result shapes, balance/mutation reads, actor identity, expiry/retry
behavior, receipt-history location scope, opening-balance reason behavior, or
their tests.

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
durability. It also covers the exact `Set Initial Stock` GUI default, required
and editable final reason text, reason-confirmation binding, one-location and
all-location history, bounded paging, and durable history after reopen. It
never opens a repository database, Cloudflare resource, production service, or
user-selected file.

After the test suite, the verifier runs one deterministic public-safe behavior
scenario against a fresh temporary SQLite file. Its JSON transcript proves an
active location commits, archived and unknown locations create neither balance
nor receipt, and both durable rejections replay exactly after restore or later
location creation. The temporary file is closed and removed before the
transcript is printed.

## Expected result

Success exits `0` with every opening-balance test marked as passing. Any failed
invariant, unexpected exception, or unavailable required Node capability exits
nonzero with the Node test runner's diagnostic output.

Run the complete repository regression suite separately:

```bash
npm test
```
