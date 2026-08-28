# Dinkuskit Inventory — Command and Receipt Contract

Status: locked v1 product contract. This document defines behavior that the
future service and clients must implement; it is not a claim that a runtime or
production binding exists today.

## The rule in plain language

A stock or location-lifecycle change is finished only when Dinkuskit Inventory
has committed it and returned its receipt. Every interface — EmDash,
AICommerce, the CLI, a job, an agent, or a future Discord bot — calls the same
Inventory-owned command engine. None of them writes stock or location records
directly or keeps a fallback ledger.

```text
human or integration
        |
        | authenticated command with explicit pool and location
        v
Inventory service -> one canonical pool writer -> balances + receipt ledger
        |
        | committed receipt OR stored business rejection
        v
human or integration
```

The network call is asynchronous in the programming sense and must be awaited.
The authoritative mutation is not a background job: Inventory validates and
commits the stock effects, receipt, and terminal command result atomically
before reporting success. Notifications, reporting projections, and
reconciliation follow-up may run later because they do not own stock truth.

## Boundaries

- One SQLite-backed Durable Object is the only writer for one physical pool in
  the locked Cloudflare production topology.
- Inventory owns command normalization, transactions, balances, command
  outcomes, and immutable receipts.
- Clients use an authenticated API or shared client. They never receive
  database credentials and never write site-local stock when Inventory is
  unavailable.
- A command names one pool and every location it affects. A SKU, hostname,
  storefront, profile, or remembered default never decides the location.
- Checkout, payments, orders, purchase orders, manufacturing, and shipping
  labels remain outside Inventory. Their identifiers may appear as references
  on an Inventory receipt.
- WooCommerce and Katana remain untouched until the separately approved manual
  cutover. This contract creates no adapter, importer, or synchronization path
  for either system.

## Command envelope

Every authoritative mutation has a versioned, normalized envelope. The exact
wire encoding may be JSON, but the following information is mandatory:

| Field | Rule |
| --- | --- |
| `schema` | Versioned command-envelope schema. |
| `commandId` | Globally unique, opaque ID created and persisted by the initiating client before its first submission. |
| `type` | One explicit Inventory operation; never a generic arbitrary patch. |
| `context.siteId` | Site or operational context that initiated the action. It is not allowed to imply pool or location. |
| `context.poolId` | Canonical physical pool. Required for every stock command. |
| `context.locationId` | Required for a one-location command. A transfer instead names both `fromLocationId` and `toLocationId`. `location.create` omits it because Inventory mints the permanent ID. |
| `payload` | Typed SKU, quantity, reservation, transfer, or fulfillment facts for this operation. |
| `reason` | Stable reason code plus the required public-safe human-readable note for an opening balance. Other command types define their reason requirement before implementation. |
| `references` | Optional typed external references, such as an order or receiving reference; never an embedded customer record. |
| `expectedVersions` | Balance or workflow versions observed during preview when compare-and-set protection is required. |

Authentication is outside the envelope. Inventory derives the actor, calling
system, granted scopes, and allowed pools/locations from the authenticated
principal; it does not trust a caller-supplied actor name. Trace IDs, timeouts,
and other transport metadata do not change the business contents of a command.
For a human action, the trusted principal supplies a stable user ID, a
public-safe display-name snapshot, and the originating surface. Email is not
required. The display name is receipt metadata, not stable identity.

Quantities cross the boundary as exact decimal strings plus a unit, never as
binary floating-point values. A merchandise count can therefore be represented
as `{ "value": "5", "unit": "each" }` without making the product model
merchandise-only.

Illustrative opening-balance envelope:

```json
{
  "schema": "dinkuskit.inventory.command/v1",
  "commandId": "cmd_01JEXAMPLE0000000000000000",
  "type": "stock.opening_balance",
  "context": {
    "siteId": "site_demo",
    "poolId": "pool_demo",
    "locationId": "location_north"
  },
  "payload": {
    "skuId": "sku_keychain",
    "quantity": { "value": "5", "unit": "each" }
  },
  "reason": {
    "code": "physical_count",
    "note": "Set Initial Stock"
  },
  "references": [],
  "expectedVersions": [
    { "skuId": "sku_keychain", "locationId": "location_north", "version": "0" }
  ]
}
```

Identifiers and values above are fictional contract examples.

## Command identity and retries

The initiating client creates one command ID before the first send and freezes
the normalized envelope. It reuses both for every retry and status lookup.

Inventory stores a digest of the normalized envelope with the command result:

- same command ID and same normalized contents: return the original result;
- same command ID and different contents: return `command_id_conflict` and
  preserve the original result;
- new business attempt after a rejection: create a new command ID;
- timeout or lost response: look up or retry the original command ID, never
  create a replacement action.

Expiry times and other time-sensitive payload values are frozen before the
first submission. A retry must not recompute them from the current clock.

## Results and observed outcomes

Inventory stores exactly one terminal result for every structurally valid,
authenticated command it accepts for business evaluation:

| Result | Meaning | Stock effect |
| --- | --- | --- |
| `committed` | The transaction and immutable receipt were committed together. | Exactly the effects named by the receipt. |
| `rejected` | A stable business rule rejected the command. The rejection code and safe details are stored. | None. |

A client may also observe `unknown` after a timeout, disconnect, or malformed
transport response. `unknown` is not a terminal Inventory result and does not
mean failure. The client must expose the original command ID and resolve it by
lookup or exact replay.

Authentication failures, malformed envelopes, and unavailable transport are
request failures rather than stored business rejections. They do not authorize
a second writer or a fresh command ID.

Typical stable business rejection codes include:

- `invalid_context` or `unauthorized_context`;
- `sku_not_found`, `sku_not_registered`, `sku_unit_mismatch`,
  `location_not_found`, or `location_not_active`;
- `sku_already_registered`;
- `location_name_conflict` or `location_not_empty`;
- `opening_balance_already_set`;
- `insufficient_available`;
- `stale_version`;
- `invalid_workflow_state`; and
- `command_id_conflict` for changed contents under an existing ID.

Codes are machine-stable. Messages are for humans and may improve without
becoming a parsing interface.

## Atomic execution

For one accepted command, the canonical pool writer performs one serialized
transaction:

1. authenticate and authorize the principal for the operation, pool, and every
   affected location;
2. normalize the envelope and compare its digest with any existing command;
3. return an existing terminal result on an exact replay;
4. validate business invariants and expected versions;
5. store a terminal rejection, or apply all balance/workflow effects and create
   one immutable receipt;
6. store the terminal result; and
7. return that stored result.

A multi-line reservation or transfer is all-or-nothing. A location lifecycle
command likewise commits its location record, immutable receipt, and terminal
result in one transaction. There is no interval where only some facts are
authoritative. A receipt, its effects, and the command's `committed` result
cannot disagree.

## Managed SKU registration

`sku.register` is the Inventory-owned enrollment boundary called after Commerce
turns `Manage stock` on. It names an explicit site context and physical pool,
plus one opaque Commerce-owned SKU. V1 accepts only the literal unit `each` and
stores no copied catalog presentation data.

The first command atomically inserts the pool-scoped SKU identity, an immutable
actor-bearing receipt, and the terminal result. The receipt has a null `before`
and the complete registered record as `after`; it has no free-text reason. An
exact retry returns that original result. A new command ID for an existing SKU
stores `sku_already_registered`, creates no receipt, and is replayable. Opening
preview or commit cannot bypass registration, and the opening quantity unit
must match the registered unit.

## Location lifecycle

Inventory owns a permanent opaque ID for each location. `location.create`
mints that ID; `location.rename`, `location.archive`, and `location.restore`
name it explicitly. A rename changes only the display name and version. Archive
and restore retain the same identity and never rewrite history.

Names are unique inside one pool across both active and archived locations.
The normalized uniqueness key trims, Unicode-normalizes, and lowercases the
display name, so casing or surrounding whitespace cannot create a duplicate.
Archiving never releases a name for reuse.

Archive succeeds only when every balance at that location has exactly zero
on-hand and zero reserved. Positive on-hand, negative on-hand, or any reserved
quantity returns the durable `location_not_empty` rejection with the exact SKU
blockers. The active location list supplies ordinary selectors and later
zero-stock breakdowns. Archived locations leave those lists but remain
available in the explicit archived list and can be restored.

Every new stock mutation resolves its explicit location against this registry
inside the serialized mutation transaction. The opening-balance command is the
first enforced path: an unknown location durably rejects as
`location_not_found`, and an archived location durably rejects as
`location_not_active`. Neither rejection creates a balance or stock receipt.
Exact command replay precedes the current-state check, so the original terminal
result does not change after later creation, archive, or restore.

## Preview and confirmation

Human-initiated mutations first request a server-validated preview. A preview:

- performs no stock mutation and creates no receipt;
- repeats site, pool, location, SKU, quantity, reason, and resulting balance;
- returns current versions and an opaque confirmation value bound to the
  normalized proposed action and authenticated principal, plus an exact
  `expiresAt`; and
- warns when the action is irreversible in place, while explaining that a
  correction creates another receipt.

For opening balances, the confirmation expires exactly five minutes after the
preview is issued and may be used immediately. A future GUI can derive a visible
countdown from `expiresAt`; the five minutes are a maximum approval window, not
a delay.

Commit presents that confirmation value with the same proposed action. The
first valid confirmation atomically binds the value to one caller-created
command ID and evaluates that command. An exact retry with the same
confirmation, command ID, normalized contents, and principal returns the
original terminal result even after preview expiry, including after a lost
response. An unconfirmed expired preview, changed action, different principal,
or different command ID after first use is blocked and requires a fresh
preview. Those confirmation-gate failures are request failures, not stored
business rejections.

A stale version is rejected and must be previewed again. Preview is a safety
and usability step, not a reservation and not a promise that later commit must
succeed.

AICommerce's checkout operations do not prompt a human. Their deliberate action
is the already-authorized saga step with a stable command identity and scoped
provider credential; the same server invariants still apply.

## Immutable receipt

Every committed mutation creates one machine-stable, human-readable receipt.
At minimum it records:

- receipt, command, schema, and command-content-digest identity;
- authenticated actor or calling system and originating surface;
- command type and committed time, plus a reason when the command semantics
  require one;
- pool and affected location identities;
- each SKU and exact quantity effect;
- resulting balance facts and monotonically advancing version for every
  affected SKU-location;
- relevant transfer, reservation, fulfillment, receiving, order, or other
  external references; and
- predecessor, reversal, or compensation links when applicable.

A location lifecycle receipt uses the same identity, actor, context, and retry
contract and freezes the location record before and after the change. A create
receipt has a null `before` snapshot. Lifecycle receipts share the canonical
receipt and command-result tables with stock receipts so command IDs remain
unique across mutation types.

A managed-SKU registration receipt uses the same identity, actor, context, and
retry contract and freezes the new SKU record with a null `before` snapshot. It
deliberately has no location, quantity effect, catalog data, or free-text
reason.

An effect records deltas for the balance dimensions it changes and the complete
post-commit balance needed for audit. `available` is derived from on-hand and
reserved; it is not an independently writable counter.

Illustrative receipt fragment:

```json
{
  "schema": "dinkuskit.inventory.receipt/v2",
  "receiptId": "rcpt_01JEXAMPLE000000000000000",
  "commandId": "cmd_01JEXAMPLE0000000000000000",
  "commandDigest": "sha256:example",
  "status": "committed",
  "type": "stock.opening_balance",
  "committedAt": "2026-01-01T12:00:00Z",
  "principal": {
    "kind": "human",
    "id": "emdash_user_demo",
    "displayName": "Demo Operator",
    "surface": "emdash"
  },
  "context": {
    "siteId": "site_demo",
    "poolId": "pool_demo"
  },
  "reason": { "code": "physical_count", "note": "Set Initial Stock" },
  "effects": [
    {
      "skuId": "sku_keychain",
      "locationId": "location_north",
      "onHandDelta": { "value": "5", "unit": "each" },
      "reservedDelta": { "value": "0", "unit": "each" },
      "balanceAfter": {
        "onHand": { "value": "5", "unit": "each" },
        "reserved": { "value": "0", "unit": "each" },
        "available": { "value": "5", "unit": "each" },
        "version": "1"
      }
    }
  ],
  "references": []
}
```

The human display name above is frozen at commit. A later account rename never
rewrites this receipt. Preview confirmation and retry bind to the stable
principal kind, ID, and surface rather than mutable display text, so a rename
does not break recovery.

## Authoritative read-back

Clients read a current balance only by supplying the complete explicit pool,
location, and SKU key. Absence returns explicit `not_found`; Inventory never
guesses a location or substitutes the latest known item.

A mutation outcome can be resolved by exactly one identity:

- receipt ID for audit and receipt viewing; or
- command ID for timeout and lost-response recovery.

A committed lookup returns the exact stored terminal result including its
immutable receipt. A stable business rejection can be resolved by command ID
and has no receipt. Missing identity returns explicit `not_found`. Read-back
never rebuilds historical actor or balance facts from current state and never
creates a stock effect.

Stock receipt history uses an explicit scope inside one pool. A location scope
returns only receipts with an effect at that location. An `all_locations` scope
returns receipts across the pool while preserving the affected location on
every receipt. Results are bounded and newest first, with a stable continuation
cursor. `all_locations` is read-only and is never accepted as a command
location. Location lifecycle receipts remain available through direct mutation
lookup; adding them to a combined GUI history is a separate read-model decision.

Receipts contain the minimum facts needed for inventory audit. Customer names,
addresses, payment details, message bodies, and unrelated order data do not
belong in them.

Receipts are never edited or deleted to correct stock. A correction is a new,
authorized reversal or compensating command whose receipt links to the earlier
receipt. Adjustment, transfer, receiving, and fulfillment histories are
filtered views over this one receipt ledger, not separate ledgers.

## Location and workflow invariants

- An active SKU is logically visible at every active location with zero stock,
  even if no physical balance row has been materialized.
- A SKU becomes active only through committed `sku.register` state. Opening
  preview and commit fail closed when that state is absent or its unit differs.
- Each SKU-location balance is independent. A change at one location does not
  change any other location.
- `Set initial stock` is available only when that SKU-location has no committed
  stock history. Zero after prior activity is not an opening balance.
- An opening balance changes one location, requires review and confirmation,
  and produces an `opening_balance` receipt. Its editable human reason starts
  as `Set Initial Stock`, must remain non-empty, and is frozen on that receipt.
  Later corrections use ordinary adjustment or reversal commands.
- A transfer explicitly names origin and destination and progresses
  `Created -> In transit -> Received`. Stock cannot appear at the destination
  before the receive command commits.
- Receiving records goods at the location where they physically arrived. It
  may reference an external purchase order, but Inventory does not become a
  purchase-order system.
- Reservations atomically hold the complete SKU vector or reject it. Commit
  binds the reservation to one order without decrementing it. Release or expiry
  restores availability. Packing is the exactly-once fulfillment decrement.

## Surface capabilities

All surfaces share the command engine but receive only named capabilities:

| Surface | Intended v1 capabilities |
| --- | --- |
| EmDash admin | Locations and stock reads; opening balances; receiving; adjustments; staged transfers; reconciliation; receipt and exception views. |
| AICommerce | Availability and reservation reads; reserve, commit, release, expire, and exactly-once pack at its configured fulfillment location. |
| `dinkus-inventory` CLI | The authenticated principal's explicitly granted read/admin operations; the executable itself grants no extra authority. |
| Jobs and agents | Named operations, pools, and locations only; same IDs, results, and receipts as human actions. |
| Future Discord adapter | Same shared client, with each installation/channel bound to explicit site, pool, locations, roles, and capabilities. Not a launch requirement. |

The future Discord adapter is one permission-isolated multi-site service. It
must preview and confirm human mutations, display site/location context, and
return the receipt or rejection. It neither reads the database nor shells out
to the CLI. No Discord account, token, installation, or send is authorized by
this contract.

## AICommerce migration contract

AICommerce already supplies useful reservation and checkout semantics, but its
current in-process provider cannot be presented as the production Inventory
binding. Before integration:

1. every provider call that can reach Inventory becomes promise-based and is
   awaited by the checkout saga;
2. the configured provider reference supplies both canonical pool and explicit
   fulfillment location;
3. each saga step freezes one command envelope and command ID before its first
   send, including a stable reservation expiry;
4. replay compares normalized contents instead of accepting changed contents
   under the same idempotency key;
5. business rejections become stable stored command results;
6. the richer Inventory audit receipt remains distinct from, or explicitly
   versions, AICommerce's checkout receipt; and
7. conformance continues to prove atomic vector reserve, crash/resume,
   compensation, no double reserve or pack, and fail-closed provider gating.

The runtime must inject the resulting Inventory provider explicitly. Missing,
unhealthy, incompatible, or unauthorized Inventory remains a hard failure; it
never enables a local fallback.

## Implementation acceptance gates

The first executable slice is not complete until tests prove:

- exact replay returns the byte-stable terminal result;
- changed content under one command ID conflicts;
- a stored business rejection cannot later become a success;
- timeout recovery reuses the original command ID;
- opening balance is allowed once per SKU-location history and affects no other
  location;
- opening balance admits only an existing active location, and archived or
  unknown locations create neither balance nor receipt;
- concurrent commands preserve one-writer balance invariants;
- receipts, effects, and resulting versions match committed balances;
- auth scopes reject unapproved operations and locations;
- unavailable clients fail closed; and
- export/restore preserves command identities, results, receipts, and balances.
