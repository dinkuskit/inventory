# GrillTrack cycle 4 proof

- track: `dinkuskit-inventory-v1`
- domain: public EmDash administration and Commerce stock-provider boundary
- baseline: `git:ac5686f3d0395ab9b061515f83967bf61abd8280`
- reviewed source identity: recorded in `SOURCE_MANIFEST.sha256`
- implementation: public-safe charter, repository contract, README, and
  durable GrillTrack state only
- runtime code, plugin artifact, provider binding, or GUI: none
- production access or mutation: none

## Confirmed scope

The operator confirmed a docs/spec-only slice that:

- makes one generic standard-format sandboxed EmDash plugin with a real
  host-rendered Block Kit GUI the public Inventory administration path;
- proves the same artifact first in pinned fixtures and then in SmokyClub,
  without a SmokyClub-specific fork;
- gives Commerce a per-product `Manage stock?` choice;
- uses Dinkuskit Inventory as the default and only first-party v1 provider for
  managed products;
- preserves one advanced site-level escape hatch for a user-supplied conforming
  provider, with no fan-out, automatic fallback, or Commerce-local production
  ledger; and
- leaves runtime code, external provider implementations, exact settings UI,
  accounts, publication, deployment, merge, and production changes outside the
  slice.

## Accepted locks

- `emdash-plugin-distribution-016`: one Marketplace/experimental Registry
  compatible standard-format plugin supplies the real Block Kit Inventory GUI;
  native React is not the public distribution path.
- `commerce-stock-provider-017`: `Manage stock?` controls whether a product is
  inventory-constrained; a managed product uses exactly one site-configured
  provider, defaulting to Dinkuskit Inventory, and fails closed when that
  provider is missing or unhealthy.

The exact advanced provider-settings screen and every external-provider
implementation remain owned by the future Commerce track. The Inventory
repository records only the provider/default/no-fallback handoff.

## Implementation references

- `docs/CHARTER.md`
- `README.md`
- `AGENTS.md`
- `.grilltrack/ledger.json`
- `.grilltrack/events.jsonl`

The prior command/receipt, location, CLI, and Discord decisions delivered in
the same follow-up branch retain their independent cycle-3 proof under
`.grilltrack/proof/cycle-3/`.

## Exact-source grounding

Upstream EmDash source was inspected read-only before this lock. Its standard
plugin format is the one-click Marketplace/experimental Registry path, while
native React plugins require npm/configuration/redeployment and are not
registry-installable. Standard plugins render real admin controls through
Block Kit and may use authenticated plugin routes with declared network access
to call an external service. This proof records an intended product contract,
not a successful plugin installation or compatibility result.

Current AICommerce source was also inspected read-only. It retains an
`InventoryProvider` seam but has no live Inventory binding; its current
provider and checkout flow are synchronous and do not carry location identity.
The new lock therefore preserves the seam while requiring the Dinkuskit
Inventory production adapter to become awaited, explicitly location-bound,
idempotent, and fail closed. No external adapter is implemented here.

## Verification

Commands and results:

- GrillTrack `validate` -> passed.
- decision-state assertions -> the focus is confirmed, the eleven cycle-3
  decisions remain verified, and decisions 016/017 reached implementation.
- JSONL parse -> every event record parsed.
- every JSON contract example -> parsed successfully (six examples).
- local Markdown link existence check -> passed.
- package gate -> still private `0.0.0` with no executable mapping.
- public-safe guard -> no private facility name/address or business-loss figure
  was introduced.
- `node --test tests/workflows/clawsweeper-comment-admission.test.mjs` -> 6
  passed, 0 failed.
- `git diff --check` -> passed.

## Fidelity limits and gates

This is contract proof. No Durable Object, database schema, service route,
shared client, EmDash plugin, Block Kit screen, Commerce checkbox, advanced
settings screen, provider adapter, CLI executable, Discord bot, credential,
deployment, or inventory write was created or exercised.

Exact service hosting/authentication, package identity, minimum EmDash version,
MCP timing, Marketplace/Registry listing, external provider conformance,
runtime compatibility, and visual GUI proof remain unresolved. Publication,
deployment, production mutation, physical cutover, merge, and rollback remain
separate human gates.

## Review and delivery

Independent standards and source-intent review is recorded in `REVIEW.md` and
bound to `SOURCE_MANIFEST.sha256`. The operator separately authorized a commit,
push, and follow-up pull request. This proof authorizes and claims no merge,
publication, deployment, or production change.

## Recommended next focused grill

Create the federated `SmokyClub First Sale` program across the existing
Inventory track, a Commerce-owned track, and the paused SmokyClub trajectory.
Keep one plain acceptance story: edit product -> set stock -> see storefront ->
buy -> pack -> audit. The first shared decision is Commerce's durable public
identity/home; the first Inventory implementation checkpoint is the real
`Set initial stock` service action plus its genuine Block Kit GUI.
