---
name: opening-balance-verification
description: Verify the Inventory-owned opening-balance command and its local test-only SQLite durability boundary.
---

# Opening-balance verification

Use this project-local skill after changing the opening-balance domain,
application command, local SQLite test adapter, receipt/result shapes, or their
tests.

## Run

From the repository root:

```bash
bin/verify-opening-balance
```

The verifier accepts no flags or environment-specific database path. Its tests
create real SQLite files under the operating system's temporary directory,
close and reopen them to prove persistence, and remove them during test
cleanup. It never opens a repository database, Cloudflare resource, production
service, or user-selected file.

## Expected result

Success exits `0` with every opening-balance test marked as passing. Any failed
invariant, unexpected exception, or unavailable required Node capability exits
nonzero with the Node test runner's diagnostic output.

Run the complete repository regression suite separately:

```bash
npm test
```
