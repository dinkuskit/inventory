# Owned SKU registration during onboarding

The hosted service exposes authenticated `GET /v1/skus` and `POST /v1/skus/register`. Registration accepts only `commandId`, visible `sku`, and `displayNameIfNew`; the server supplies account, site, pool and unit `each`. The existing `sku.register` kernel returns a registered or existing permanent identity without creating stock. Matching command replay returns the original result; changed contents conflict.

The installed plugin provides explicit registration, owned SKU choices and active-location choices before initial stock. It saves the original administrator and registration payload in revisioned KV before sending. Unknown or unqualified responses remain pending; retry sends the same command. Another administrator cannot replace, retry or clear it. Initial stock still requires the existing preview and explicit confirmation before an immutable receipt is created.

An account can own several pools. Creating Inventory for a new store defaults to its own pool. Joining an existing operation is explicit and account-authorized; an already bound store cannot silently migrate a populated separate pool.

[Two-store proof](../../proof/two-store-onboarding-20261006/PROOF.md) distinguishes source/API guarantees from actual installed local flows and the remaining hosted/Registry gates.
