# Review — Undo Delivered

Source: git:1563ac30f9f6c564498dccc4ab016b33649ef92b

- Standards: clean. The command remains inside the stock-reservation feature, preserves the public-entry boundary, updates the feature map and charter, and has a focused owner-boundary test.
- Source intent: clean. One Commerce-named Delivered ticket returns to Packed; balances remain unchanged; missing/non-Delivered tickets durably reject; exact command-ID retry returns the original result. Partial and bulk paths remain deferred.
- Verification: `bin/verify-inventory full` passed on Node 22.23.1. Local SQLite runtime transcript is `REAL_RUNTIME_TRANSCRIPT.txt`.
