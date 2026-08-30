---
name: stock-transfer-verification
description: Verify Inventory's Created stock-transfer commands, outgoing commitments, destination expected stock, atomic durable storage, and Cloudflare v4 migration.
---

# Stock transfer verification

Use this project-local skill after changing Created transfer commands, transfer
records, balance planning quantities, transfer receipts, storage adapters,
Cloudflare migrations, public exports, or tests.

## Run

From the repository root:

```bash
bin/verify-stock-transfer
```

The verifier accepts no flags. Node tests use disposable local SQLite files
under the operating-system temporary directory. Cloudflare tests run locally
through Vitest/Miniflare and do not contact or mutate a deployed Worker.

It proves zero-quantity Created drafts; editable unique references; positive
origin commitments and destination expected quantities; exact negative-
availability warnings; full Created edits; audited cancellation; immutable
receipts; exact replay, conflict, rejection, and rollback; read-back after
reopen; Cloudflare runtime parity; and exact v3-to-v4 and v2-to-v4 migration.

Before review or delivery, run the canonical repository gate:

```bash
bin/verify-inventory full
```
