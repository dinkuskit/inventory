# Organization Inventory metadata overview

`GET /v1/account-overview` returns retained InventoryAccount control metadata for
one organization. It reads operations and site bindings together in the existing
SQLite transaction. It does not read InventoryPool stock or health, create a
second ledger, or alter pool allocation and reconnect behavior.

## Signed read contract

Website must authorize the independent caller for metadata access to the selected
organization before issuing a token. Merchant membership or CMS administration
alone does not establish this permission. Inventory verifies the existing
configured HTTPS `ACCOUNT_ISSUER` and `ACCOUNT_JWKS_URL`, using ES256 or RS256.

| Claim | Required value |
| --- | --- |
| `aud` | Scalar `inventory-account-overview` only |
| `scope` | Exactly `inventory:account-overview:read` |
| `sub` | Independent admitted caller identity |
| `organization_id` | One selected Website organization ID |
| `organization_subject` | That organization's stable account authority subject |
| `iat`, `exp` | Integer seconds; positive lifetime at most 300 seconds; current validity and no future issuance |

Identity strings must be nonempty, at most 200 characters, and have no surrounding
whitespace. Inventory derives the existing account key as
`JSON.stringify([configuredIssuer, signedOrganizationSubject])`; `sub` remains the
caller identity and does not select an account. The trusted issuer is responsible
for verifying the organization ID to authority-subject mapping. Browser query
selectors are rejected. No site header is needed for this organization read.
Merchant `inventory:admin` tokens cannot read this endpoint, and these read tokens
cannot use merchant or stock mutation routes.

## Response and availability

The response contains `organizationId` and an `overview` with schema
`dinkuskit.inventory.account-overview/v1`. It reports distinct allocated pools,
retained site count, per-pool site count, site-to-pool relationships, and explicit
`pending`, `ready`, or `failed` provisioning. Retained relationships do not imply
current Website access grants. Website joins returned site IDs to its own verified
origins, membership and admission state.

`sampledAt` and `asOf` are service-generated observation times for the metadata
snapshot. Live pool health is explicitly unavailable with reason
`live_pool_health_not_read`; provisioning readiness is not a health check.
Available empty metadata returns HTTP 200 with observed zero counts. Missing
service configuration, read failure, or invalid metadata returns HTTP 503 with
`service_unconfigured`, `read_unavailable`, or `invalid_metadata` and null counts
and rows. Authentication failure returns 401; query selectors return 400;
non-GET methods return 405. Responses use `Cache-Control: no-store`.

The response excludes product/SKU records, stock quantities, catalog, contacts,
location details, commands, operation identities, and failure detail. There is no
organization directory or bulk read. Website token issuance, real operator
principals and grants, key configuration, hosted activation and deployment remain
separate work. Local synthetic signed-token and SQLite runtime proof is recorded
in [verification](../../proof/account-overview-20261006/VERIFICATION.md).
