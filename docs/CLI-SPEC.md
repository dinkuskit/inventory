# `dinkus-inventory` CLI Specification

Status: locked v1 interface specification. No executable is implemented or
published yet; examples in this document are contract transcripts, not runtime
proof.

## Name and purpose

Executable: `dinkus-inventory`

Package: `@dinkuskit/inventory`

One-liner: inspect and administer canonical Dinkuskit Inventory through the
same authenticated API, permissions, commands, and receipts used by EmDash and
AICommerce.

`dinkus-inventory` is a first-class client, not a second inventory engine. It
never opens the Inventory database, changes a site-local balance, or
reimplements stock rules. A future umbrella `dinkus inventory ...` command may
delegate to the same client, but the `dinkus` executable is not claimed here.

## Planned implementation shape

```text
bin/dinkus-inventory.mjs  thin executable entrypoint
src/cli/                  parsing, formatting, confirmation, exit mapping
src/client/               shared authenticated Inventory API client
```

The first implementation should use strict `node:util.parseArgs` parsing and
keep the zero-dependency ESM posture while the surface is small. Parsing and
formatting live in importable modules with tests. Changing parser frameworks
later must not change the output or safety contract.

When an executable exists, the package manifest maps:

```json
{
  "bin": {
    "dinkus-inventory": "./bin/dinkus-inventory.mjs"
  }
}
```

This specification does not add that mapping before the executable exists.

## Usage

```text
dinkus-inventory [global flags] <noun> <verb> [arguments]
dinkus-inventory status [flags]
```

`-h` and `--help` show help and ignore every other argument. `--version` prints
only the installed version to stdout. Both exit successfully.

## Command tree

```text
dinkus-inventory status

dinkus-inventory locations list
dinkus-inventory locations show <location-id>

dinkus-inventory skus list
dinkus-inventory skus show <sku-id>

dinkus-inventory stock list
dinkus-inventory stock show <sku-id>
dinkus-inventory stock set-initial <sku-id>
dinkus-inventory stock adjust <sku-id>
dinkus-inventory stock receive

dinkus-inventory transfers list
dinkus-inventory transfers show <transfer-id>
dinkus-inventory transfers create
dinkus-inventory transfers start <transfer-id>
dinkus-inventory transfers receive <transfer-id>

dinkus-inventory receipts list
dinkus-inventory receipts show <receipt-id>

dinkus-inventory commands show <command-id>
dinkus-inventory commands resolve <command-id>
```

### Read commands

- `status` reports client version, service compatibility, authenticated
  principal, and service health without claiming the database itself is healthy
  unless the service proved it.
- `locations list|show` reads the locations authorized for the resolved site and
  pool.
- `skus list|show` reads Inventory SKU identity. Catalog creation and product
  merchandising remain outside this CLI slice.
- `stock list|show` always includes resolved pool and location plus on-hand,
  reserved, available, expected/in-transit facts, and balance version.
- `transfers list|show` exposes the staged `Created -> In transit -> Received`
  workflow.
- `receipts list|show` reads the canonical receipt ledger. Filters may select
  adjustment, transfer, receiving, or fulfillment views, but never another
  ledger. A list explicitly selects one location or all locations within one
  pool; all locations is read-only and every returned receipt retains its
  affected location.
- `commands show` reads the stored result for one command identity.

### Mutation commands

- `stock set-initial` sets an opening balance only for a SKU-location with no
  committed stock history.
- `stock adjust` accepts exactly one of `--delta` or `--set-on-hand`. An
  absolute count is committed against the previewed balance version.
- `stock receive` records one or more item quantities at the location where
  they physically arrived. It may carry an external reference; it does not
  create a purchase order.
- `transfers create` stages an explicit origin, destination, and item vector.
- `transfers start` moves a `Created` transfer to `In transit` and applies the
  locked origin/in-transit effects.
- `transfers receive` moves an `In transit` transfer to `Received` and applies
  the locked destination effects.
- `commands resolve` looks up an unknown-outcome command and, only when needed,
  replays the exact locally retained envelope under the same command ID. It
  cannot edit the envelope or retry the action as new.

Routine AICommerce reservation, commit, release, expiry, and pack operations
use the shared client library rather than general-purpose CLI verbs in v1. The
CLI may inspect their receipts and command outcomes if its principal has audit
scope.

## Global flags

| Flag | Contract |
| --- | --- |
| `-h`, `--help` | Show context-appropriate help; ignore other arguments. |
| `--version` | Print only the installed version. |
| `--profile <name>` | Select non-secret endpoint/site metadata. |
| `--endpoint <url>` | Override the Inventory API endpoint; never includes credentials. |
| `--site <id>` | Explicit initiating site/operational context. |
| `--pool <id>` | Explicit canonical pool. Required as a flag for mutations. |
| `--location <id>` | Explicit location for one-location commands. Required as a flag for mutations. |
| `--json` | Emit exactly one stable JSON document to stdout. Mutually exclusive with `--plain`. |
| `--plain` | Emit stable line-oriented records with no decoration. Mutually exclusive with `--json`. |
| `--no-input` | Disable every prompt. Missing input or confirmation fails closed. |
| `--no-color` | Disable color. `NO_COLOR` and `TERM=dumb` do the same. |
| `--timeout <duration>` | Bound transport waiting; a mutation timeout produces an unknown outcome, never an assumed failure. |

Profiles may make reads convenient, but mutation commands require `--site` and
`--pool` on that invocation. A one-location mutation also requires
`--location`; a transfer requires both `--from-location` and `--to-location`.
The CLI never derives any of them from a hostname, SKU, current directory, or
last-used location. Every preview and result repeats the resolved context.

## Mutation flags

| Flag | Contract |
| --- | --- |
| `--reason <code>` | Required stable reason for opening balances, receiving, adjustments, and corrections. |
| `--note <text>` | Public-safe human-readable reason text; required for opening balances and not a place for customer or payment data. A future interactive opening-balance surface starts it as `Set Initial Stock`. |
| `--reference <type:id>` | Repeatable typed external reference. |
| `--dry-run` | Request server validation and preview, print the exact proposed effect and confirmation value, then stop without a command, receipt, or stock mutation. |
| `--confirm <value>` | Submit only when the opaque value matches a fresh preview of the exact normalized action and current versions. |
| `--no-input` | Never prompts. A real mutation additionally needs a valid `--confirm`. |

There is no generic `--force` in v1. Automated callers use the exact,
short-lived `--confirm` value returned by `--dry-run`; it proves which preview
they approved without bypassing authorization, versions, or business rules.

Human mode requests the same preview, prints it, and asks the operator to type
the displayed confirmation value. A refusal or end-of-input sends no command.

Command-specific quantity flags use exact strings:

- `--quantity <decimal> --unit <unit>` for opening balance and receiving;
- exactly one of `--delta <signed-decimal>` or
  `--set-on-hand <decimal>`, plus `--unit`, for adjustment; and
- repeatable `--item <sku-id>=<decimal>:<unit>` for a transfer or multi-item
  receipt.

Negative opening balances and receipts are rejected. Whether an adjustment may
produce negative on-hand is a server policy, never a CLI-side loophole.

## Preview and confirmation flow

The safe non-interactive pattern is two calls with the same business arguments:

1. run with `--dry-run --json`;
2. inspect the proposed context, effects, warnings, and versions;
3. run again with `--no-input --confirm <returned-value> --json` before the
   preview expires.

The confirmation value is bound to the normalized action and versions. It is
not an authentication credential and cannot approve a changed location,
quantity, SKU, reason, or transfer line. An opening-balance confirmation may be
used immediately and expires exactly five minutes after preview. Its
`expiresAt` lets an interactive client display the remaining approval window.
An unconfirmed expired preview or changed action is blocked at the confirmation
gate; the caller must preview a genuinely new attempt.

Immediately before its first authoritative send, the CLI creates a command ID,
freezes the envelope, and writes both to its operator-local pending-command
store. It then awaits the terminal result. The local store is recovery
metadata, not inventory truth and contains no credential.

On a transport failure after send, the CLI:

- prints `outcome=unknown` and the command ID;
- keeps the frozen envelope;
- exits `3`; and
- directs the operator to `commands show` or `commands resolve`.

`commands resolve` reuses the exact frozen bytes and command ID. A terminal
receipt or rejection closes the local pending record. A missing local envelope
allows lookup but blocks replay; the CLI never fabricates a replacement
command.

If the first response is lost, exact recovery resends the same confirmation,
command ID, frozen contents, and principal context. Once the first valid
confirmation bound that command ID, this exact retry returns the original
terminal result even when the five-minute preview window has since elapsed. A
different command ID cannot reuse the consumed confirmation.

The pending store follows the platform state directory, for example
`$XDG_STATE_HOME/dinkuskit/inventory/commands/`, with user-only permissions.
It may retain IDs, envelope digests, frozen public-safe envelopes, and terminal
references. It never stores bearer credentials or becomes an offline balance
cache.

## Output contract

Default output is concise human-readable text. Progress, warnings, prompts, and
diagnostics go to stderr. Requested data goes to stdout. Piped stdin never
causes a prompt.

`--json` emits one versioned document and nothing else on stdout:

```json
{
  "schema": "dinkuskit.inventory.cli/v1",
  "command": "stock.set-initial",
  "outcome": "committed",
  "context": {
    "siteId": "site_demo",
    "poolId": "pool_demo",
    "locationId": "location_north"
  },
  "commandId": "cmd_01JEXAMPLE0000000000000000",
  "receipt": {
    "receiptId": "rcpt_01JEXAMPLE000000000000000"
  }
}
```

The envelope always contains `schema`, `command`, `outcome`, and resolved
`context`. A mutation result includes `commandId` and exactly one of:

- `receipt` when `outcome` is `committed`;
- `rejection` when `outcome` is `rejected`; or
- `unknown` when transport did not establish a terminal result.

A preview uses `outcome: "preview"`, includes proposed effects, versions,
expiry, and `confirmation`, and has no command ID or receipt. Read commands use
`outcome: "ok"` and `data`.

`--plain` emits one record per line. Fields are ordered and documented per
command as tab-separated `key=value` pairs; tabs, newlines, and backslashes in
values are escaped. It contains no headings, color, spinner, prompt, or
diagnostic text. The first fields are always `schema`, `command`, and `outcome`.

JSON and plain field names are compatibility surfaces. New optional fields may
be added within v1; existing meaning or types require a schema version change.
Human prose is not a parsing interface.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Successful read, viable dry-run preview, committed command, or terminal command lookup. |
| `1` | Stable business rejection or ordinary command failure with no mutation. |
| `2` | Invalid usage, missing argument, invalid non-secret configuration, malformed input, or client-side validation error. |
| `3` | Service/dependency/network unavailable, or an authoritative mutation has an unknown transport outcome. |
| `4` | Authentication/authorization/confirmation/human gate blocked the action. |
| `5` | Service response violated the advertised contract or required behavior could not be verified safely. |

If Ctrl-C arrives before submission, the CLI sends no command and exits `4`.
If it arrives after submission began and the terminal result is not known, the
CLI preserves the command envelope, reports unknown, and exits `3`.

## Configuration and authentication

Non-secret configuration precedence is:

```text
flags > process environment > project config > user config > built-ins
```

Supported sources:

- flags: the global context and endpoint flags above;
- environment: `DINKUS_INVENTORY_PROFILE`,
  `DINKUS_INVENTORY_ENDPOINT`, and optional read-context values;
- project config: `.dinkuskit/inventory.json`, containing only intentional,
  non-secret shared metadata;
- user config: `$XDG_CONFIG_HOME/dinkuskit/inventory/config.json` or the
  platform-equivalent user config directory; and
- built-ins: output and timeout defaults only, never an inferred production
  endpoint, pool, or location.

V1 service authentication uses a bearer credential supplied through the fixed
`DINKUS_INVENTORY_TOKEN` environment variable by the caller's secret manager or
attended shell integration. There is no `--token` flag, token-bearing URL,
checked-in token, plaintext profile credential, or debug print of an
authorization header. Error output may name the selector but never its value.

The service, not the CLI, maps the credential to actor identity and capabilities.
Possessing the executable grants no pool, location, or mutation permission.

## Contract transcripts

The following examples use fictional IDs and demonstrate the intended
interface only.

### Read one balance

```sh
dinkus-inventory --site site_demo --pool pool_demo --location location_north \
  stock show sku_keychain --json
```

```json
{
  "schema": "dinkuskit.inventory.cli/v1",
  "command": "stock.show",
  "outcome": "ok",
  "context": {
    "siteId": "site_demo",
    "poolId": "pool_demo",
    "locationId": "location_north"
  },
  "data": {
    "skuId": "sku_keychain",
    "onHand": "5",
    "reserved": "1",
    "available": "4",
    "unit": "each",
    "version": "8"
  }
}
```

### Preview initial stock

```sh
dinkus-inventory --site site_demo --pool pool_demo --location location_north \
  stock set-initial sku_keychain --quantity 5 --unit each \
  --reason physical_count --note "Set Initial Stock" --dry-run --json
```

```json
{
  "schema": "dinkuskit.inventory.cli/v1",
  "command": "stock.set-initial",
  "outcome": "preview",
  "context": {
    "siteId": "site_demo",
    "poolId": "pool_demo",
    "locationId": "location_north"
  },
  "data": {
    "skuId": "sku_keychain",
    "before": "0",
    "after": "5",
    "unit": "each",
    "expectedVersion": "0"
  },
  "confirmation": {
    "value": "confirm_example",
    "expiresAt": "2026-01-01T12:05:00Z"
  }
}
```

### Commit the exact preview

```sh
dinkus-inventory --site site_demo --pool pool_demo --location location_north \
  stock set-initial sku_keychain --quantity 5 --unit each \
  --reason physical_count --note "Set Initial Stock" \
  --no-input --confirm confirm_example --json
```

The successful JSON shape is the committed example in the output contract. A
second opening-balance attempt returns `outcome: "rejected"`, code
`opening_balance_already_set`, and exit `1`; it never edits the first receipt.

### Resolve an unknown outcome

```sh
dinkus-inventory commands show cmd_01JEXAMPLE0000000000000000 --json
dinkus-inventory commands resolve cmd_01JEXAMPLE0000000000000000 --json
```

Neither command creates a new business attempt. `resolve` can replay only the
locally frozen original envelope under the original identity.

## Acceptance checks for the executable slice

Before this specification may be described as implemented, tests must prove:

- help and version behavior at every command depth;
- byte-clean JSON and deterministic plain output;
- stdout/stderr separation and no credential disclosure;
- strict context requirements and no inferred mutation location;
- TTY-only prompting plus fail-closed `--no-input` behavior;
- preview/confirmation binding and stale-preview rejection;
- pending-envelope persistence before send and exact-ID recovery after timeout;
- stable exit-code translation for committed, rejected, unavailable, blocked,
  and malformed-response cases; and
- no database import, direct table access, hidden fallback, or duplicated
  inventory-rule implementation in CLI modules.
