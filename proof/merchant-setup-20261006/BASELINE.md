# Merchant setup baseline and first gap

Repository: `dinkuskit/inventory`. Base: `ea957d7418ff4dbfeb859967d82349d84456fb94` (PR40 merge).
Branch: `codex/inventory-merchant-setup-20261006`.
Worktree: `/Users/bobbybones/Developer/dinkus/inventory-merchant-setup-20261006`.

| Step | Current evidence | Remaining gap |
| --- | --- | --- |
| Install | PR40: real EmDash 1.0.1 Astro host, installed non-symlink local npm package | Signed Registry delivery/publication and production authorities are unproven |
| Sign-in/consent | PR40 installed merchant variant: real local Website Better Auth runtime, explicit consent, PKCE, canonical public JWKS | Live hosted issuance/HTTPS and current website integration owned elsewhere |
| Binding | Merchant account provisions one canonical Inventory pool/location, persistent across normal child restart and renewal | Production admission remains separately gated |
| Reviewed stock | Existing preview/confirm opening kernel; installed adjustment proof 10→7 with immutable receipt | Plugin has no opening-stock action; earlier stock proof seeded initial stock through harness |
| Commerce | First-party whole-basket reserve/release kernel and earlier synthetic port/concurrency proof | Same merchant-created canonical pool end-to-end transport/fulfillment needs later Inventory slice and Commerce-owner handoff |

Historical evidence: `proof/emdash-stock-admin-20260930/PROOF.md`, `installed-flow.json`, `review-repair.json`. Earlier GUI package evidence is not repaired-head GUI or Registry proof. Current source: `plugins/emdash-inventory/src/plugin.ts`, `src/cloudflare/hosted-worker.ts`, `src/cloudflare/worker.ts`, `src/application/preview-confirm-opening-balance.ts`.

First bounded slice: expose canonical opening preview/confirm RPC and authenticated hosted endpoints; offer Set initial stock in the standard plugin only after an authoritative read proves no physical history for a registered SKU; retain originating-admin binding and original command identity through unknown outcomes/reload/retry. Unknown/missing/unregistered/read-failed stock must not be converted into known empty stock. Existing adjustment and one-writer invariants remain.

Registration/catalog selection is a later explicit integration gap; no invented or automatically registered SKU. No Commerce source changes, production stock, hosted activation, publication or merge authority. Inventory remains NONBLOCKING for Commerce v1.
