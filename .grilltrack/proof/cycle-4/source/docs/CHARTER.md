# Dinkuskit Inventory — Charter

Recorded from GrillTrack cycle 1 on 2026-07-24 (product identity and home),
then extended on 2026-08-25 with the canonical architecture, operating model,
manual cutover, command/receipt boundary, CLI, public EmDash plugin, and
Commerce provider locks. Durable decision ledger: `.grilltrack/ledger.json`.
Business-sensitive rationale (figures, forecasts, tenant specifics) lives in
the operator's private planning repo — cross-referenced here by issue or path —
and is deliberately never committed to this repository.

## identity-001 — one product, EmDash-native (locked)

The successor ledger that retires the Katana subscription IS Dinkuskit
Inventory v1. One product, one ledger:

- a platform-neutral inventory kernel: SKU/variant identity, explicit
  locations, on-hand/reserved/available/expected, immutable movement
  receipts, exact decimal/unit handling;
- an in-dashboard EmDash admin plugin as the product surface;
- no storefront-shaped base code, ever.

Rationale: durable investment must survive the first tenant's storefront
migration to EmDash. The kernel/adapter split (proven in AICommerce) makes
that structural rather than aspirational.

## exit-001 — thin disposable WooCommerce adapter (superseded)

The first cycle proposed one disposable WooCommerce adapter for Katana shadow
validation and a low-volume legacy tail. That decision is preserved for
history, but it no longer authorizes implementation.

`cutover-004` supersedes it with a physical count and manually reviewed opening
balances. Dinkuskit Inventory v1 contains no WooCommerce or Katana adapter,
importer, shadow sync, or tail synchronization. Shipping labels remain on the
legacy storefront's native path and outside this ledger.

## architecture-002 — canonical Inventory service (locked)

Dinkuskit Inventory owns the sole canonical ledger for each physical inventory
pool. Its platform-neutral kernel owns inventory schema, migrations, commands,
transactions, idempotency, and immutable receipts. Clients never read or write
its tables directly.

The Cloudflare production adapter uses one SQLite-backed Durable Object per
physical pool behind an Inventory-owned service. Every location and every
EmDash site mapped to that pool uses the same object, allowing a multi-item
reservation or movement to commit atomically under one writer. Site-local CMS
storage and reporting projections may hold settings or caches, but never
authoritative balances.

EmDash is the authenticated human administration surface. Commerce consumes a
thin Inventory provider boundary for availability, reserve, commit, release,
expiry, packing, and balance reads when a product is stock-managed through
Dinkuskit Inventory. Those critical calls must be network-aware, awaited,
idempotent, and fail closed; the current AICommerce in-process synchronous
contract must not be treated as production transport. A missing or unhealthy
configured provider never falls back to a local counter.

The Durable Object topology is a locked production direction, not a deployment
claim. It must still pass bounded concurrency, idempotency, export/restore, and
provider-conformance proof before any production migration or write is
considered.

## operating-model-003 — shared pool and exact locations (locked)

- One physical inventory pool may serve multiple EmDash sites and channels.
- Each physical location has exact on-hand, reserved, available, expected, and
  in-transit quantities inside that pool.
- Each ecommerce connection maps explicitly to one fulfillment source
  location; names, domains, or matching SKUs never imply a mapping.
- Goods are received where they physically arrive.
- Transfers advance `Created -> In transit -> Received`. Origin availability
  is removed before destination availability appears, and corrections use
  explicit reversal receipts instead of rewriting history.
- Reservations, releases, fulfillment decrements, adjustments, stock-in,
  reconciliation, and visible exceptions all use the same human-administered
  ledger.

## cutover-004 — manual EmDash opening balance (locked)

WooCommerce and Katana remain untouched and canonical for the legacy
merchandise catalog until a separately approved physical cutover. Before the
EmDash storefront begins selling the migrated products, the human operator:

1. marks those products out of stock on WooCommerce;
2. performs an in-house physical count;
3. reviews and records the resulting opening balance for each SKU and location
   in Dinkuskit Inventory; and
4. explicitly makes Dinkuskit Inventory the canonical ledger for the EmDash
   storefront.

There is no dual-writer interval. A production count, opening-balance entry,
WooCommerce change, canonical-writer switch, deploy, or rollback remains a
separate human gate; this charter authorizes none of them.

## command-outcome-005 through command-result-007 — awaited, replay-safe commands (locked)

Every authoritative mutation is an awaited command. It succeeds only when the
canonical pool writer atomically commits its effects and immutable receipt. A
timeout or transport failure is an unknown outcome: callers look up or replay
the exact original command, never assume failure or create a replacement.

The initiating client creates and persists one command ID before first send.
The same ID and normalized contents return the original terminal result; changed
contents under that ID conflict. Inventory stores either one committed receipt
or one structured business rejection. A new attempt after rejection receives a
new ID. Full contract: [COMMAND-RECEIPT-CONTRACT.md](COMMAND-RECEIPT-CONTRACT.md).

## receipt-audit-008 — one immutable audit ledger (locked)

Every committed stock mutation produces one machine-stable, human-readable
receipt with command/actor/type/time/reason identity, explicit pool and
locations, exact SKU effects, relevant typed references, and resulting balance
versions. It excludes unnecessary customer data. Corrections create linked
reversal or compensating receipts; receiving, transfer, adjustment, and
fulfillment histories are filtered views of the same receipt ledger.

## location-balance-009 through command-location-011 — explicit independent locations (locked)

An active SKU is logically visible at every active location with zero stock,
but each SKU-location balance is independent. Commands affect only their named
location; transfers explicitly name both endpoints. Neither a site, hostname,
SKU, profile, nor remembered default may imply physical location.

For a SKU-location with no committed stock history, EmDash offers `Set initial
stock`. It previews one opening-balance adjustment for human confirmation and
then creates the immutable receipt. Once history exists, ordinary adjustment
replaces that affordance even if the current balance is zero. Later corrections
never rewrite the opening receipt.

## surface-permissions-012 — one engine, scoped clients (locked)

EmDash administrators may receive, adjust, transfer, reconcile, establish
opening balances, and inspect audit views. AICommerce receives only its
configured location's availability, reservation, release, commit, expiry, and
fulfillment capabilities. Jobs, CLIs, bots, and agents receive named operations,
pools, and locations. Every surface uses the same command identities, results,
and receipts without direct database access or hidden powers.

AICommerce's present in-process provider is not the production integration. Its
provider and checkout saga must become promise-based; gain explicit location
binding; freeze stable command contents before first send; reject changed
replay contents; and preserve terminal business rejections. The existing
atomic reservation, compensation, fail-closed provider, and exactly-once pack
conformance behavior must remain proven through that migration.

## emdash-plugin-distribution-016 — one public Block Kit admin plugin (locked)

Dinkuskit Inventory ships its human administration surface as one generic
standard-format sandboxed EmDash plugin. EmDash renders the real GUI through
Block Kit; authenticated plugin routes call the canonical Inventory service
through declared network access. A native React plugin is not the public
distribution path because it would require npm/configuration/redeployment and
could not use EmDash's one-click Marketplace or experimental Registry path.

The first proof sequence is:

1. run the plugin against one pinned current EmDash fixture;
2. run the exact same artifact against the pinned SmokyClub EmDash version; and
3. install that unchanged artifact in SmokyClub for the first real inventory
   workflow.

SmokyClub is the first user, not the source of Inventory product rules. Exact
service hosting and authentication, package identity, minimum EmDash version,
MCP timing, listing, publication, deployment, and production configuration
remain separate grills or gates.

## commerce-stock-provider-017 — simple product choice, advanced provider choice (locked)

Commerce exposes one plain `Manage stock?` setting on each product:

- **Off:** Inventory does not constrain that product and Commerce sends no
  availability, reservation, release, commit, or packing commands for it.
  Other product rules may still apply, but no stock quantity is enforced.
- **On:** Commerce uses exactly one inventory provider configured for that
  EmDash site/store. Dinkuskit Inventory is the default and only first-party v1
  provider, giving humans and agents the EmDash-administered experience.

Advanced site/plugin settings may replace the default with one user-supplied
provider that conforms to Commerce's inventory contract. Provider selection is
not repeated on every product page. Commerce never fans one product out to
multiple providers, automatically fails over, or keeps its own production
stock ledger. A managed product with a missing, incompatible, or unhealthy
configured provider fails closed.

Commerce owns the checkbox, provider setting, and conformance seam. Inventory
owns only its provider implementation, service, ledger, and admin surface. The
exact advanced-settings screen and any external-provider implementation remain
for the Commerce-owned track; this charter does not claim they exist today.

## cli-interface-013 — first-class thin CLI (locked)

Inventory v1 plans one standalone `dinkus-inventory` executable from the
`@dinkuskit/inventory` package. It uses the shared authenticated client and
never opens the database or duplicates business rules. It provides human,
stable JSON, and stable plain output; explicit context; preview plus exact
confirmation; fail-closed non-interactive operation; retained command identity
for timeout recovery; small stable exit codes; and no credential flags or
logs. Exact interface: [CLI-SPEC.md](CLI-SPEC.md).

The package has no executable mapping yet because this cycle defines a
specification, not a runtime implementation. A future `dinkus inventory`
umbrella alias requires its own product decision.

## discord-sequencing-014 and discord-topology-015 — supported later, not launch-blocking (locked)

The contract supports one future multi-site Discord bot application and adapter
service. Each installation, server, or approved channel binds to explicit site,
pool, locations, Discord roles, and Inventory capabilities. The bot displays
context, previews and confirms human mutations, submits one command identity,
and returns its receipt or rejection through the shared client.

Discord follows proof of EmDash administration, AICommerce sales flow, and the
CLI. It is not a first-launch requirement, has no implicit all-sites authority,
does not read the database, and does not shell out to the CLI. These locks
authorize no account, token, installation, server mutation, or message send.

## home-001 — dinkuskit/inventory, born public (locked, amended)

This repository is the permanent home; npm namespace `@dinkuskit/*`. Born
public per the Dinkus org default ("dogfooding in the open"); publish gates
are releases, not repository visibility. Amendment note: an initial
private-until-release preference was revised on discovering the existing
public stub and the fact that git history survives any later visibility
flip — the public-safe content discipline is mandatory regardless, so
privacy added nothing.

## Banked (not locked) — storage schema and migration mechanics

The public command behavior, results, receipt facts, explicit location rules,
CLI surface, public plugin format, and Commerce consumer policy are locked. The
executable vertical slice still needs exact TypeScript schemas, persistence
tables/indexes, migration numbering, Durable Object export/restore mechanics,
service authentication, and pinned EmDash compatibility proof. Purchase orders
remain out of scope.

## v1 scope fence (inherited)

In: tenant/site-scoped SKU/variant identity; explicit locations;
on-hand/reserved/available/expected; immutable movement receipts; exact
decimal/unit handling; explicit site-to-pool and site-to-source-location
mappings; manual opening balances; operator-visible exceptions; one generic
standard-format EmDash admin plugin; the first-party Commerce provider; a thin
first-class CLI; scoped support for jobs and agents.

Out: manufacturing orders, recipes/BOM, materials/batches, purchasing,
production scheduling, costing, forecasting, general MRP; WooCommerce/Katana
adapters, imports, shadow synchronization, and tail synchronization; Commerce
product settings and external inventory-provider implementations.

## Next focused grill

Coordinate the first visible SmokyClub sale across three product-owned tracks.
Inventory's first checkpoint is one real `Set initial stock` service action and
the genuine Block Kit GUI that previews, confirms, persists, refreshes, and
shows its receipt. Commerce owns the product checkbox/provider setting and the
awaited reserve/commit/release/pack adapter. SmokyClub owns the exact-product
identity bridge and the final edit -> stock -> storefront -> buy -> pack ->
audit proof. Keep each implementation and proof in its owning repository.

## Cross-references

- Control document: saari-co/x-api
  `plans/product/commerce-critical-path-20260713.md`
- Decision ledger issue: saari-co/x-api#399
- Business north star: saari-co/x-api `BUSINESS_NORTH_STAR.md`
