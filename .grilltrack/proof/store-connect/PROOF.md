# Registry store-control local proof (independent final local pass)

Base: `57aa9521fdfbddcbde0bf79a70708fdd8e771582`
Branch: `codex/inventory-store-connect`
Track: `gt-20260930005601-551c1b`
Decision: `store-control-004`
Review: `.grilltrack/proof/store-connect/FIRST-PASS-REVIEW.md`

## Required-fix disposition

1. Expired challenge restart: reproduced, then fixed. Direct Connect after expiry without reinstall or poll now starts a usable new challenge. Pre-fix failure: `.grilltrack/proof/store-connect/expired-challenge-direct-connect-failure.json`.
2. Public proof orphan: start deletes the exact receipt if session CAS loses. Token session is written before proof delete. Concurrent starts in the real sandbox left one published receipt (`published: 1`). Public GET additionally requires the active encrypted challenge and exact matching receipt fields, so orphan or pre-CAS receipts return 404. Expired restart fails if its deletion CAS loses; it never adopts a competing revision.
3. Verification URI: frozen to `/account/connect` plus the exact `connection_id`. Userinfo, fragment, extra/duplicate query fields, and unrelated same-origin paths are rejected.
4. Authoritative `expires_at` epoch-ms is required on start, bound exactly into the receipt, and mismatched/too-far-future values fail closed with no clock-tolerance bypass. Website accepted this field as the integration target; implementation remains pending.
5. Proof wrapper discovers Node 24 from `NODE24`, PATH, or the current executable and reports honest absence. No workstation-specific paths.

## Verified bounded slice

- `bin/verify-inventory full`: passed in 12.99s. Architecture, Cloudflare and plugin typecheck, 163 Node tests (including 11 store-connect tests), 24 kernel workerd tests, 3 hosted provisioning tests, and standard plugin build/bundle all passed.
- Plugin bundle SHA-256: `020859b4e25535b0e2cc57de31a3f9c0f96784103c6859f46030abf839e35b3f`. Routes probed: `admin`, `store-proof`.
- EmDash 1.0.1 private dispatcher + sandbox-workerd 0.9.1 + the built standard plugin: passed store-control start, public proof GET/no-store, PKCE/origin/callback/challenge/expiry tamper, expired-challenge direct Connect restart, concurrent-start CAS publication, authoritative `expires_at`, orphan receipt refusal, one-use redeem, two merchants/two sites including ownership conflict, originating-admin bind, anonymous 401, CSRF 403, editor 403, lost Inventory `/v1/connect` retry, frozen intent, reinstall, owned reconnect, and foreign-account refusal.
- Website/account transport in this harness is a labeled local simulation. It is not live Better Auth, hosted ownership, or Registry delivery.
- Synthetic ES256 signing keys stayed in memory. Proof JSON contains no access tokens, PKCE verifiers, or admin emails.

## Commands

```text
npm ci
npm run typecheck:plugin
npm run build:plugin
node --experimental-strip-types --test tests/store-connect/*.test.mjs
node tools/run-hosted-onboarding-proof.mjs
bin/verify-inventory full
```

Runtime prerequisites: Node 22+ on PATH for npm/plugin build. Proof host needs Node 24+ via `NODE24` or PATH (`registerHooks`). A runtime that cannot load signed native bindings (for example some bundled worker Nodes) is an honest environment limit, not a faked sandbox pass.

## Browser

The sidebar owner drove the actual Block Kit renderer through Connect, labeled synthetic consent, return to Inventory, stock-location entry, and Create Inventory. Visible result: `Inventory connected` and `Stock location: Proof stock room`. Two screenshots remain local under ignored `.grilltrack/work/store-connect/` (`challenge.jpg`, `connected.jpg`); they are not public hosted artifacts. Reproduce with:

```text
node tools/run-hosted-onboarding-proof.mjs --serve
```

URL: `http://127.0.0.1:4329`

Steps: Connect Inventory → Proof fixture: approve synthetic website consent → I’ve approved this site — continue → name `Proof stock room` → Create Inventory. Expect `Inventory connected` and `Stock location: Proof stock room`. The approve button is synthetic website consent, not live Better Auth.

## Fidelity

- Real: EmDash 1.0.1 dispatcher, workerd sandbox, Block Kit validation, host CSRF/user binding, plugin public `store-proof`, local Inventory SQLite Durable Objects, original provisioning retry/reconnect.
- Two-site fidelity: the originating site uses the actual sandbox; the second site binding and ownership conflict use the website simulation, not a second hosted sandbox.
- Simulated: website `/api/store-connections` start/token, merchant consent, ownership map, JWT minting, start `expires_at`.
- Unproven: live Better Auth, production `https://dinkuskit.com`, deployed HTTPS site origin, Registry install, renewal, agreed lost-token recovery.

Website `CONTRACT.md` is present and was reconciled in
`.grilltrack/work/store-connect/CONTRACT.md`. The website owner accepted the
v1 route names, public receipt fetch, fixed callback, strict token response
and authoritative epoch-ms `expires_at`. The accepted target is not an
implemented claim yet. Website Workers-safe HTTPS fetch, persistent consent,
atomic redemption and real account integration remain that owner's work.
Inventory does not call merchant-session `/account/tokens`.

## Independent review

See `REVIEW.md` and `source-snapshot.json` for exact reviewed source hashes. Earlier hosted-default, account-connect and trial-access locks remain represented. Local review is not a Spark or native ClawSweeper receipt. Website implementation, deterministic CI, comprehensive Spark review and native ClawSweeper remain delivery gates.
