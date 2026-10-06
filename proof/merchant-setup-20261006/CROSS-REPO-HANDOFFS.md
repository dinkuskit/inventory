# Remaining complete-setup handoffs

Inventory remains concurrent and NONBLOCKING for Commerce v1.

- Inventory next slice: merchant-friendly catalog/registered-SKU selection and
  stock-location selection without opaque-ID entry. Preserve permanent Inventory
  identity, explicit location and reviewed opening stock; do not infer catalog
  ownership or enable production stock.
- Website/service owner: bind a separately approved hosted origin and existing
  Better Auth consent/PKCE grant contract to this package. Preserve originating
  site, fixed callback, issuer/JWKS/audience/scope, unknown outcomes and reapproval.
  Account/service activation, deployment, DNS and grants require exact human gates.
- Registry/package owner: qualify the final package through supported Registry
  transport/publisher signing. Current source is still fail-closed `.invalid`.
  Package/Registry publication or submission requires separate human approval.
- Commerce owner: compose reserve/release and fulfillment against the very same
  connected canonical pool and explicit fulfillment location in isolated synthetic
  storage. Retain grayed disabled Coming soon Manage stock for Commerce v1 and
  no fallback ledger. Inventory-owned transport/proof can advance separately.

No cross-repo source edit or chat message was sent by this worker. Trial quotas,
pricing and billing remain undecided and are not prerequisites for synthetic setup.
