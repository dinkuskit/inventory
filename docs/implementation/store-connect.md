# Registry store connection

Inventory starts a Registry-compatible store-control challenge from the
sandboxed EmDash plugin. The existing hosted Inventory service remains stock
authority. Website Better Auth owns accounts, merchant sessions, explicit site
consent, grants and JWT issuance.

## Plugin boundary

Private `plugins:manage` Connect requires host-attested `routeCtx.user`. The
plugin derives canonical site origin from `ctx.site.url`, loads or mints
`state:site-id`, freezes the initiating administrator, and POSTs

`/api/store-connections`

with `client_id`, `service`, `site_id`, `site_origin`, frozen callback, and
PKCE S256. The start response must include an authoritative `expires_at`
epoch-ms; the plugin binds that exact value to the public receipt and rejects
already-expired or more-than-10-minute future values. Verification URI must be
exactly `/account/connect?connection_id=<id>` on the configured website origin.
Loopback HTTP origins are allowed only when the host site URL is
loopback. Userinfo, query and fragment are rejected.

A public GET `/_emdash/api/plugins/dinkus-inventory/store-proof?connection_id=`
returns the receipt created by that private start. It has no PKCE verifier,
access token, email or admin id. One-use applies to website redemption, not
the first public read.

Page load on the frozen callback
`/_emdash/admin/plugins/dinkus-inventory/inventory` resumes polling for the
originating administrator only. Another local admin cannot poll or overwrite
an active challenge.

## Website proposal

This repository does not own website routes. The published plugin handoff is
this file plus the strict schemas in `src/features/store-connect/`. The website
owner has accepted `/api/store-connections`, `/api/store-connections/token`,
public `store-proof` fetch, the fixed callback and authoritative epoch-ms
`expires_at` as the v1 integration target. Those schemas are the auditable
contract; website implementation remains pending.
These routes are not yet an implemented website claim. The plugin cannot use
website cookies and does not call merchant-session `/account/tokens`. Lost token
success is not silently replaced; the plugin retries the original
`connection_id` and verifier. If the website returns `already_redeemed`
without the original token, Connect must restart.

## Inventory retry

After a token is present, `POST /v1/connect` still uses the frozen operation
and request identity. Unknown provisioning outcomes retry the original command.
Owned reconnect and foreign-account refusal are unchanged.

## Proof

`node tools/run-hosted-onboarding-proof.mjs` selects a Node 24 executable when
needed for `registerHooks`, then runs the published dispatcher, workerd sandbox
and Block Kit renderer. Website/account transport in that harness is a labeled
local simulation, not live Better Auth or hosted ownership.

See [hosted onboarding](hosted-inventory-onboarding.md).
