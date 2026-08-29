---
name: location-registry-verification
description: Verify Inventory-owned location identity, unique names, lifecycle commands, archive safety, durable receipts, reads, and local SQLite atomicity.
---

# Location registry verification

Use this project-local skill after changing the location domain, lifecycle
application command, location read model, command/result or receipt unions,
local SQLite location storage, archive blocker query, or their Node tests.

## Run

From the repository root:

```bash
bin/verify-location-registry
```

The verifier accepts no flags. It creates task-owned SQLite files under the
operating system's temporary directory and removes them during test cleanup. It
never opens a repository database, Cloudflare resource, production service, or
user-selected file.

The suite proves permanent Inventory-minted IDs, normalized names, uniqueness
across active and archived locations, immutable actor receipts, exact replay
after reopen, rename/archive/restore state transitions, active and archived
reads, positive/negative/reserved archive blockers, durable business
rejections, global command-ID conflict behavior, input validation, and atomic
rollback when receipt persistence fails.

## Expected result

Success exits `0` with every location-registry test passing. Any failed
invariant, unexpected exception, or unavailable required Node capability exits
nonzero with the Node test runner's diagnostics.

Use the focused Cloudflare verifier to narrow adapter failures. Before review
or delivery, run the canonical repository gate:

```bash
bin/verify-cloudflare-storage
bin/verify-inventory full
```
