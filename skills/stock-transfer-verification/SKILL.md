---
name: stock-transfer-verification
description: Verify Inventory's transfer lifecycle, contextual detail and Open/Done list reads, atomic durable storage, bounded keyset pagination, and Cloudflare v4 parity.
---

# Stock transfer verification

Use this project-local skill after changing Created, dispatch, reopen, or receive
transfer commands; transfer records; balance planning or in-transit quantities;
transfer receipts; detail or list reads; location scope; lifecycle ordering;
pagination; storage adapters; Cloudflare migrations; public exports; or tests.

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
reason; atomic whole-line destination receipt; automatic received timestamp;
destination physical-history establishment; reasonless receive plus separate
reasoned discrepancy adjustment; immutable actor receipts; destination-scoped
receive history; exact replay, conflict, rejection, rollback, and close/reopen
read-back; explicit Open/Done membership; incoming and outgoing active-location
scope; unique All Locations rows; one-archived-endpoint visibility and
both-archived exclusion; compact row projection; lifecycle ordering; default
50, maximum 100 opaque keyset pagination; selected-location rejections;
Cloudflare runtime parity; and unchanged exact v3-to-v4 and v2-to-v4 migration.

Before review or delivery, run the canonical repository gate:

```bash
bin/verify-inventory full
```
