# First-pass source review (bounded local review, not external rail receipt)

Required fixes against this source snapshot:

1. Expired challenge restart: startStoreConnect deletes connectionSession with stored.revision, then writes the new session using that deleted revision. CAS must use the current empty/versioned state, not the stale deleted revision. Add a real sandbox regression: expire the transaction then click Connect directly without reinstall or poll; require a usable new challenge on that first click.
2. Public proof orphan: start publishes receipt before winning session CAS. If saveSession loses a concurrent start or throws, remove that exact unpublished/orphan receipt. Prefer reserve-before-network or prove only the winner remains publishable. Also save token state before deleting its proof; avoid losing receipt on failed session CAS. Test concurrent starts deterministically and clean failed winner/loser states.
3. Verification URI helper checks origin only despite contract claiming origin/path checks. Freeze /account/connect with the exact connection_id; reject userinfo, fragment, duplicate/conflicting query fields and unrelated same-origin paths. Add meaningful negative tests.
4. Proof expiry field is relative to a later local timestamp; the website simulation ignores mismatched future expiry. Propose an authoritative absolute expires_at epoch-ms in start response, bind exact receipt value and fail mismatches (including too-far-future) without clock-tolerance bypass. Update CONTRACT explicitly; website remains a dependency until it accepts fields.
5. Proof wrapper must not ship workstation-specific hardcoded paths. Use a portable runtime discovery strategy or explicit NODE24 + PATH, report honest absence.

Known scope limits, not substitute fixes: website has not adopted plugin reachable PKCE routes; live Better Auth, live HTTPS, Registry install and remote site-control proof remain unproven. Keep these explicit. Callback path is confirmed in pinned admin renderer index.js:15050-15056. Current website CONTRACT is present; clear stale absent claims in product docs/proof.

Final review rails: CI + comprehensive Spark OpenClaw + native ClawSweeper required on final tuple before maintainer gate; migration owner manages Inventory #34; don't edit rail files or merge.

Snapshot SHA-256s:
- `plugins/emdash-inventory/src/plugin.ts`: `81be0920cdf29d674b4a45116a79bc5b155738fbab77b5aff31b046d3b4f3c03`
- `src/features/store-connect/protocol.ts`: `83bd016bcc0db0f40b7bb174650db0be50b4ac4e51a397ab68b9d9dcdef92372`
- `tools/hosted-onboarding-proof.mjs`: `8fdbbc16b568df0326345ab243f93048ea27cc170f300e8b79f72cfae58ea06f`
- `tools/run-hosted-onboarding-proof.mjs`: `418d4bacff686ff2b72f278ba75bad21df59bb861dab69d297f782dedd047691`
