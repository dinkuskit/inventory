# Installed Inventory proof

The standard sandboxed plugin was installed as a non-symlink npm package in
an actual EmDash 1.0.1 Astro host, then driven through its Block Kit admin UI.
`installed-flow.json` binds the separate local test packages, component hashes,
synthetic site/pool identities, screenshots and verification results.

The host observer ran first. An installed connection failed in SSRF target
validation because the declared `.invalid` authority had no DNS addresses;
the request never reached transport. The explicit local package variant uses
a resolving declared authority and supported finite `httpFetch` transport.
Allowed-host, DNS, private-address, redirect and signed account checks remain
in place. Observational host/SSRF modules were restored to original hashes.
Production authorities remain placeholders.

In the stock variant, the installed UI showed Clean Central Depot and all six
canonical quantities. A reasoned synthetic adjustment moved on-hand stock
from 10 to 7 each. Normal host restart retained 7 each at version 2 and the
byte-identical immutable receipt. Opening stock was created only by the
explicit synthetic stock harness. That older stock package used the origin
as its site binding; the separate merchant package uses a fresh opaque UUID.

In the merchant variant, the real Website owner-qualified runtime handled
normal merchant signup and magic-link verification through its local mailbox.
The browser showed explicit Inventory consent for the exact test site. Approval
returned through the unchanged callback, and installed PKCE redemption produced
scoped account access authenticated against the actual public canonical JWKS.
Creating Merchant Proof Depot through the plugin provisioned the merchant's own
Inventory pool. Normal Inventory child restart retained the same UUID, pool and
location under the surviving Website controller, without seeding or rewriting
the session. Normal token expiry/reapproval retained that pool. The genuine
public receipt returned 200 with ten public fields and `no-store` before
redemption, then 404 after successful redemption.

Each new proof parent bootstraps a separate CMS database through normal build
and 88 migrations. An old encrypted challenge cannot be resumed after its
memory-only parent key ends. Earlier databases and observations were preserved;
no challenge, receipt, account session or consent was injected. Normal BetterAuth
session records persist in isolated ignored D1. Private signing/encryption keys
remain in parent memory. Both owned listeners were closed at final stop.

Final `bin/verify-inventory full` passed: 224 Node tests, 3 merchant-worker tests,
29 Cloudflare tests and 5 hosted tests, plus type, architecture and bundle checks.
Generated run output and local screenshots remain outside the Git change.

This proves explicit local test variants. It does not approve Registry publisher
signing or establish hosted HTTPS/DNS, deployment, a live merchant grant, real
inventory activation, billing or merge readiness. Exact-source review and human
merge authority remain separate.

The subsequent PR40 review repairs are recorded in `review-repair.json`.
They bind stock intents to the trusted initiating EmDash administrator and
repair exact-envelope replay verification. A real old-head regression sent
one unauthorized final mutation; the repaired handler suite passes 14 tests.
The actual dispatcher/workerd/Inventory Durable Object component run verifies
zero foreign final mutations, unchanged intent revisions and canonical
balances/receipts, originating-admin lost-acknowledgement recovery, and replay
of the original envelope returning the original receipt without another
movement. Full runtime shutdown completes and the helper exits normally.

The repair gate passes 230 Node, 3 merchant-worker, 29 Cloudflare and 5 hosted
tests. This component run explicitly transforms only its in-memory authority
and uses a public synthetic site binding. Earlier installed GUI packages and
screenshots above remain historical exact artifacts; they do not prove the
repaired package's config-managed GUI install. Fresh official review of the
repaired head remains required. The shared hosted account principal is unchanged.
