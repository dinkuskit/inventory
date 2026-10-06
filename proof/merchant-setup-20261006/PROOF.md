# Reviewed opening-stock proof

Base: `ea957d7418ff4dbfeb859967d82349d84456fb94` (merged PR40).
Branch: `codex/inventory-merchant-setup-20261006`.
Source hashes: `source-manifest.json`. Package retained in the ignored exact run.
Plugin code SHA-256: `1316ab408621c5d2b4e1bca21237347ab688036d7389dfaba877453eb02b578a`.
Final package SHA-256: `cc31e69ac5ead7356d88673e387a1cc1f4b9a0f237cc851f2fb9056ea686d76a`.

The standard plugin now exposes reviewed opening stock for an already registered
SKU at an explicit active location. The canonical eligibility read distinguishes
unknown identity, no physical history, and existing history (including zero).
Preview invokes the existing kernel without movement. Confirmation commits one
immutable receipt and balance. The plugin persists one originating-admin-bound
command before send, preserves it through unknown outcomes, and uses the admitted
CAS revision so a late preview cannot replace a pending request.

`bin/verify-inventory full` passed: 235 Node tests, 29 Cloudflare tests and
7 hosted tests, with architecture/type checks, Worker dry-run build and plugin
bundle validation. The 5 new plugin tests cover replay, admin isolation, delayed
preview races, authoritative expiry versus uncertain outcomes, and fail-closed
eligibility. Hosted tests use real SQLite Durable Objects and no seeded balance.
Actual command log hashes are retained in `verification.json`; raw logs remain
in the ignored worktree-local run, not model-written PASS summaries.

`node tools/opening-stock-proof-host.mjs` passed with published EmDash 1.0.1
private dispatcher and workerd 0.9.1 sandbox. Identity-only registration leaves
stock absent. The actual built plugin offers opening stock, previews without
movement, confirms 7 synthetic each, loses its acknowledgement, preserves the
original intent on page reload, retries to the original receipt, and returns to
ordinary adjustment after history. Foreign admins send zero final mutations.
Normal canonical service disposal/restart retains the same balance, receipt
bytes and original-envelope replay result. Both owned runtimes shut down normally.
See `runtime-verification.json` for exact public synthetic identities, snapshots
and artifact hashes.

Visible captures show the real published Block Kit renderer displaying those
sandbox responses. They are static component captures, not a config-managed
merchant GUI install or Registry transport. The first Vite/WASI renderer crashed;
an esbuild static capture server succeeded and was inspected through native CUA.
Media is retained immutably in the designated asset repository:
[preview](https://raw.githubusercontent.com/dinkuskit/dinkus-pr-assets/27d41b7657bda1e4e86cba3e99e04dd2eab736ba/inventory/merchant-setup-20261006/1316ab408621c5d2b4e1bca21237347ab688036d7389dfaba877453eb02b578a/preview.jpg) and [stock](https://raw.githubusercontent.com/dinkuskit/dinkus-pr-assets/27d41b7657bda1e4e86cba3e99e04dd2eab736ba/inventory/merchant-setup-20261006/1316ab408621c5d2b4e1bca21237347ab688036d7389dfaba877453eb02b578a/stock.jpg).
Asset commit: `27d41b7657bda1e4e86cba3e99e04dd2eab736ba`. Sizes, redaction and hashes: `assets.json`.

Limits: authentication here is a synthetic signed account fixture, and one
explicit in-memory local authority transform preserves declared-host validation
before finite test transport. No Registry signing/delivery, hosted issuance,
production activation, catalog-selection UX or Commerce transport/fulfillment
composition is claimed. PR40 installed merchant proof is preserved as historical
exact evidence; it is not relabeled as this package's installation proof.
Inventory remains NONBLOCKING for Commerce v1; Manage stock remains with Commerce.

Native Cursor Luna Medium was attempted with verified approve-all permissions.
Both jobs terminated with canonical cleanupReady=true. The second stopped at
bundle/proof blockers, admitting the already-authorized owning Codex fallback.
Fallback repaired the remaining paths, completed actual proof and full verification.
No protected storage, foreign process, production setting, deployment, Registry
publication or merge was changed. Separate maintainer review and human promotion
remain required.
