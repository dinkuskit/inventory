# Inventory shared-store v2 verification

## Scope and dependency

Inventory consumer change based on `ef328845e65eb67e7d53ec3bccdfded287ae9ff5`.
Uses website [PR #21](https://github.com/dinkuskit/dinkuskit/pull/21) at
`c0e871e3b2b63a511c78669cb78b29bd810c51f3`; that dependency retains its human merge gate.
No merge, deployment, Registry publication, live account or external provider traffic.

## Automated proof

`bin/verify-inventory full` passed using Node 22.23.2: 275 Node tests,
29 Cloudflare tests, 16 hosted-runtime tests, architecture audit, typechecks and bundle.
The seven independently authored v2 tests passed, covering both ordering models,
exact public receipt fields, start validation, returned polling intervals, terminal
unknown/malformed/lost exchanges, obsolete session read-only behavior, and signed
wrong-service/wrong-store rejection. Existing CAS and stock tests passed.
GrillTrack validation and `git diff --check` passed.

An isolated real website fixture plus the actual Inventory source dispatcher passed
both Inventory-first and Payments-first connections, shared canonical ID, separate
consent, proof-route fetch, and wrong-service/wrong-store denial. The Payments peer
was a synthetic protocol driver, not installed Payments plugin proof.

## Installed sandbox browser proof

Installed the built npm plugin into a fresh local EmDash site as a sandboxed plugin.
The real admin dispatcher, Block Kit UI, workerd runtime and local Inventory backend
completed Connect Inventory, normal synthetic merchant signup/sign-in, explicit
Inventory consent, callback, first location creation and connected status. The backend
verified actual website-signed tokens against website JWKS. Status, locations and SKU
requests succeeded. No connection session was injected.

The session was stored as an EmDash v1 `plugin-setting` encrypted envelope with
ciphertext; safe SQL predicates found no plaintext credential field names. Neither
stored values, keys nor tokens were extracted into proof.

This is local transport proof, not production transport or hosted Registry proof.
The installed test variant maps only the reserved default origins to the canonical
website origin. The website harness returns its loopback approval origin; the adapter
accepts only the exact configured loopback origin, `/account/connect`, one matching
`connection_id`, and no fragment or userinfo, then changes only that origin. Browser
navigation reverses that explicit mapping. Product validation is unchanged. The
website owner confirmed this adapter limitation against the immutable dependency.

Artifact SHA-256:

- npm tarball: `bd06454f41c888817f4f2028fe351f1a48e4f56391e09cecca4ecd547c4e18bc`
- source plugin bundle: `c90b37ab419e8be336a014c288f1f8b5adced1f3ba7fdaf0d98cc0c60823c24b`
- local transport bundle: `577da3b63e413d94fedb180b080145a2444a65fce951db36bcac252ee9c6582e`

Local harness source SHA-256 (untracked diagnostic harnesses):

- `browser-run.mjs`: `acfb6ee7fa90b209f6c8eb8653cfd1c81f7ad913547ed516f20d6a42b2e39f8c`
- `prepare-browser.mjs`: `3b0ebcf26c8a8917cd55d9fbbda7fed76abc4f01fadadc51a5ed6373dca1a362`
- `integration/run.mjs`: `c4263f5e9f578fc32b30d63641ba4fe280f4821d936a7eb84953ad6f5a370c5b`

Sanitized screenshots are stored outside this source repository at immutable asset commits:

- [ui-pending.jpg](https://raw.githubusercontent.com/dinkuskit/dinkus-pr-assets/ed51e61567df42121a78b0edc7f6f97935ec269f/inventory/shared-store-v2-20261009/13609f477ffefe6216d8db54d367efff74133ce4bbe2348337a88f9cf32f6602-ui-pending.jpg) — SHA-256 `13609f477ffefe6216d8db54d367efff74133ce4bbe2348337a88f9cf32f6602`
- [ui-consent.jpg](https://raw.githubusercontent.com/dinkuskit/dinkus-pr-assets/cfe3923b82d97369fbba650adc7d635bbc910f92/inventory/shared-store-v2-20261009/34ee80e3555e373dd96617e392586a357ec87165f64c47b141a8d78044236c79-ui-consent.jpg) — SHA-256 `34ee80e3555e373dd96617e392586a357ec87165f64c47b141a8d78044236c79`
- [ui-connected.jpg](https://raw.githubusercontent.com/dinkuskit/dinkus-pr-assets/248312fac08755b857686c88eeedb8928589eb92/inventory/shared-store-v2-20261009/bca52a281d57d82f6db612d8136f95dfd3e923ec41ef77c118ad6d1c593584c8-ui-connected.jpg) — SHA-256 `bca52a281d57d82f6db612d8136f95dfd3e923ec41ef77c118ad6d1c593584c8`

## Review boundary

CI, comprehensive exact-tuple OpenClaw and native ClawSweeper evidence is recorded
on the pull request after this commit. Submission alone does not establish clearance.
Human approval is still required for merging and deployment.
