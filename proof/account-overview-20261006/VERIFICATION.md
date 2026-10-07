# Account overview verification

Base: `c565c984d4635bdb6a20194d58a39bd74b3f50fe`.

The canonical `bin/verify-inventory full` passed: architecture checks, Cloudflare
and plugin type checks, 256 Node tests, 29 Cloudflare tests, 12 hosted tests, and
plugin bundle validation. Two workerd notices (`sku_not_registered` and
`location_not_active`) came from existing opening-eligibility rejection paths;
the hosted suite completed with no failed tests. A parent correction then reran
all 13 overview JWT tests successfully using matched signing keys for malformed
claims. No package or lockfile changes were needed.

The local macOS run used Node 22.22.2, locked Rolldown 1.2.6 and Vite 8.2.2,
with the matching official Rolldown WASI binding after native signature loading
failed. The bundle runtime measured 131006 bytes against the 131072-byte limit
(66 bytes remaining); validation passed without a size-limit change. Runtime
SHA-256: `f88120a6f824ec4333b8e04d2fa1a6b283b120b59956a75816ea6ec1a979147b`.

Proof covers real signed ES256/RS256 tokens, wrong signer/issuer/audience/scope,
claim omissions and types, lifetime boundaries, canonical identifiers,
organization isolation, refusal of browser selectors, merchant mutation denial,
shared and separate pools, retained SQLite relationships after actual Durable
Object eviction, empty observed zero, broken metadata, missing configuration and
failed RPC. Metadata reads preserve stock record counts. Live health is not read.

Parent review accepted and repaired multiple-audience admission, whitespace
account-key ambiguity, unknown provisioning state, unavailable reason routing,
and negative-test signing-key/claim fixture gaps. Speculative live telemetry and
provider health are excluded by the locked scope. Website origin/admission joins
and independently authorized token issuance require their own integration proof.
These are local source tests, not evidence of deployed service access or grants.

Exact external review and CI must qualify the final PR base/head tuple before a
maintainer approves merge. No merge, deployment or publication is included.
