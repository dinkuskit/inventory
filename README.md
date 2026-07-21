# inventory

`* * *`

Advanced inventory operations for AICommerce on EmDash: pools, locations,
movements, reservations, imports, reconciliation, and operator-visible
exceptions. Planned package: `@dinkuskit/inventory`.

AICommerce will ship a safe single-pool inventory provider for new stores. This
extension deepens that same provider contract for merchants who need
multi-location or shared stock, migration tooling, and operational controls. It
does not create a second stock ledger and it is not an MRP.

## Planned boundary

- one active inventory provider per pool;
- atomic vector reserve, commit, release, and reversal receipts;
- immutable stock movements and explicit tenant/site/pool identity;
- multi-location and shared-pool administration;
- imports, reconciliation, exceptions, and Katana migration;
- the same audited application services behind EmDash admin, REST, and MCP.

## Status

Public design stub. There is no installable plugin or published npm package yet.
The package manifest is private at `0.0.0` to prevent accidental publication.

Part of [Dinkus](https://github.com/dinkuskit): blocks, AICommerce, commerce
extensions, and templates for [EmDash](https://github.com/emdash-cms/emdash)
sites. Commerce extensions depend on AICommerce; blocks and templates remain
independently usable.

Under construction, dogfooding in the open. MIT.
