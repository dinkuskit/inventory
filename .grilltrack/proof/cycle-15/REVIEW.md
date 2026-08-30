# Cycle 15 exact-source review

Result: clean after two required repairs.

Source identity: `SOURCE_IDENTITY.txt`, source diff SHA-256
`a696c63b05df9b98ec63d7d270891e2b6ce6f9c6c93efb806aa2f1712c0e261a`.

## Required repairs adjudicated

1. `required_fix` — metadata-only Created edits returned no oversold warning
   because warning derivation inspected only changed effects. Repaired to
   inspect complete post-command origin balances; exact replay remains stable.
2. `required_fix` — destination expected stock created a no-history balance row
   that opening preview rejected and opening commit could overwrite. Repaired
   with version-bound preview/confirmation, compare-and-set opening update, and
   preservation of outgoing/expected/in-transit quantities in both SQLite
   adapters.

## Final inspection

- Command normalization is exact-keyed and rejects same-location endpoints,
  duplicate SKUs, negative quantities, unsupported units, invalid dates, and
  malformed version vectors before storage.
- One pool transaction owns replay/conflict detection, active-location and SKU
  admission, unique reference enforcement, transfer persistence, every balance
  effect, immutable receipt, and terminal result.
- Create/update/cancel effects are exact replacements, so multi-SKU moves and
  destination changes release old planning facts before applying new facts.
- Cancellation is durable history and does not release the human reference for
  reuse.
- Local SQLite is still explicit-path test-only. Cloudflare schema v4 has a
  separate exact v3-to-v4 migration; v2 still advances through v3. No live
  database, route, deployment, account, or production state changed.
- Public exports remain platform-neutral and feature import barriers are clean.
- The updated PR #14 proof baseline is incorporated without changing transfer
  behavior; the only overlapping source conflict retained both package scripts.

No unresolved required finding remains in the reviewed source diff. Official
PR review rails still need to bind their verdict to the eventual PR head SHA.
