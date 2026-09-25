# Cycle 19 exact-source review

Final result: clean.

Source identity: `SOURCE_IDENTITY.txt`, changed-source manifest SHA-256
`ffa25e3975d6c401474f69499a82df004d6fd65d5fd6deb682522136fa3e278b`.

Read-only review of the reservation kernel against baseline
`61bc604d03d9b482b05daaa3647c84c77ce4fdb3` and the five locked decisions.

## Standards

- Migrated feature `dinkus.stock-reservation` with FEATURE_MAP, architecture
  rules, public entry, focused verifier, and `bin/verify-inventory full`.
- Storage adapters own SQLite/Durable Object mechanics; domain policy stays in
  the feature.
- Schema v5 initializes fresh and upgrades exact v2/v3/v4 predecessors.
- Exact decimal arithmetic uses the shared kernel, including available
  comparison.

## Source intent

- Named hold with minted ID, explicit location, managed SKU, positive quantity,
  and order/line reference. No customer data.
- Fail-closed available, including outgoing transfer commitments.
- One active hold per order/line; matching contents return existing; different
  contents conflict.
- Cancel keeps durable canceled history and restores reserved stock.
- Same order/line after cancel mints a new ID.
- No GUI, CLI, Commerce transport, packing, expiry, or deploy in this slice.

## Classifications

No `required_fix`, `defer`, or `human_gate` findings. `existing` holds store a
command result without a new receipt because they are not a stock mutation;
that matches `sku.register`.

No finding required a product-scope change, remote action, or human gate.
