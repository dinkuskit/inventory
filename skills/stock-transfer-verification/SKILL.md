---
name: stock-transfer-verification
description: Verify Inventory's Created, dispatch, and reopen stock-transfer commands, contextual availability, atomic durable storage, and Cloudflare v4 parity.
---

# Stock transfer verification

Use this project-local skill after changing Created, dispatch, or reopen
transfer commands; transfer records; balance planning or in-transit quantities;
transfer receipts; line-stock context; storage adapters; Cloudflare migrations;
public exports; or tests.

## Run

From the repository root:

```bash
bin/verify-stock-transfer
```

The verifier accepts no flags. Node tests use disposable local SQLite files
under the operating-system temporary directory. Cloudflare tests run locally
through Vitest/Miniflare and do not contact or mutate a deployed Worker.

It proves zero-quantity Created drafts; editable unique references; positive
origin commitments and destination expected quantities; order-priority movable
stock; exact negative-availability warnings; full Created edits; audited
cancellation; automatic dispatch timestamps; atomic origin/destination
dispatch effects; exact In-transit-to-Created reversal; optional typed reversal
reason; immutable actor receipts; exact replay, conflict, rejection, rollback,
and close/reopen read-back; Cloudflare runtime parity; and unchanged exact
v3-to-v4 and v2-to-v4 migration.

Before review or delivery, run the canonical repository gate:

```bash
bin/verify-inventory full
```
