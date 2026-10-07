# Two-store onboarding baseline

Base: git206879d9562f927f2fad00dfa9b10a5cbef796c8 (merged PR41). Scope: two synthetic customers, two isolated EmDash1.0.1 installations, one shared Inventory service, backend-owned bindings and independent persistent stock receipts. No tenancy migration or second ledger.

Storage boundary: verified JWT issuer/subject selects InventoryAccount.getByName(accountId). Each server-minted operation creates an opaque pool_id, which routes to InventoryPool.getByName(poolId). Cloudflare gives each Durable Object its own SQLite storage. Multiple sites can explicitly reconnect to the same owned operation; separate accounts cannot resolve each other's operation. No database file is copied into a Commerce client.

PR41 proves canonical no-history eligibility, reviewed initial stock, originating-admin CAS intent, lost acknowledgement and exact retry/restart. Its component runtime uses synthetic account signing and a local authority variant. PR40 has separate historical actual installed EmDash/Better Auth consent proof; its stock variant seeded an opening balance. Neither proves a fresh current two-customer hosted deployment.

Current gaps: the hosted boundary does not expose the existing sku.register kernel, and the plugin selection form asks for opaque location/SKU IDs. The next bounded source slice exposes authorized explicit visible-SKU registration with stable original command replay, lists owned SKU identities, and uses active location/registered-SKU selectors. Registration creates no stock; opening preview/confirmation remains unchanged. Commerce product activation and automatic catalog synchronization are outside this slice.

Actual test consent integration must use a separately owner-qualified Website controller/build artifact and canonical public JWKS contract. Production package origins and publisher remain fail-closed .invalid. Local installed package variants and synthetic identity substitutes must be labeled. New cloud resources, deployment, grants or Registry publication require a concrete human gate after safe preparation.
