# Opening-balance preview and confirmation boundary

Status: confirmed implementation contract for GrillTrack decision
`opening-balance-confirmation-020`.

## Scope

This slice adds a platform-neutral preview and confirmation boundary around the
Inventory-owned `stock.opening_balance` command. Preview reads the current
SKU-location state, returns the exact proposed effect and a five-minute opaque
confirmation, and performs no stock mutation. Confirmation may happen
immediately. The first valid confirmation binds the token to one caller-created
`commandId` and evaluates the opening-balance command.

This slice returns `expiresAt` so a future GUI can calculate and display a
countdown. It does not implement a GUI, authentication, transport, Cloudflare
binding, deployment, package publication, or production storage. The local
SQLite adapter remains development/test-only and is not exported from the
package root.

## Public application boundary

```ts
type PreviewOpeningBalanceInputV1 = Readonly<{
  schema: "dinkuskit.inventory.opening-balance-preview-input/v1";
  type: "stock.opening_balance";
  context: Readonly<{
    siteId: string;
    poolId: string;
    locationId: string;
  }>;
  payload: Readonly<{
    skuId: string;
    quantity: ExactQuantity;
  }>;
  reason: Readonly<{ code: string; note: string }>;
  references: readonly ExternalReference[];
}>;

type OpeningBalancePreviewV1 = Readonly<{
  schema: "dinkuskit.inventory.opening-balance-preview/v1";
  type: "stock.opening_balance";
  context: PreviewOpeningBalanceInputV1["context"];
  effect: Readonly<{
    skuId: string;
    locationId: string;
    onHandDelta: ExactQuantity;
    reservedDelta: ExactQuantity;
    balanceBefore: Readonly<{
      onHand: ExactQuantity;
      reserved: ExactQuantity;
      available: ExactQuantity;
      version: "0";
    }>;
    balanceAfter: Readonly<{
      onHand: ExactQuantity;
      reserved: ExactQuantity;
      available: ExactQuantity;
      version: "1";
    }>;
  }>;
  reason: PreviewOpeningBalanceInputV1["reason"];
  references: readonly ExternalReference[];
  warning: string;
  confirmation: Readonly<{ value: string; expiresAt: string }>;
}>;

type PreviewOpeningBalance = (
  input: PreviewOpeningBalanceInputV1,
  execution: Readonly<{ principal: CommandPrincipal }>,
) => Promise<OpeningBalancePreviewV1>;

type ConfirmOpeningBalance = (
  confirmation: string,
  command: SetOpeningBalanceCommandV1,
  execution: Readonly<{ principal: CommandPrincipal }>,
) => Promise<OpeningBalanceResult>;
```

The proposal intentionally has no command ID, receipt, or caller-supplied
expected version. Preview observes logical version `0` and the authoritative
command created for confirmation carries the derived version-0 precondition.
The authenticated service adapter will eventually supply the trusted principal;
this slice only validates and binds the provided principal identity.

## Confirmation state and lifecycle

The storage port persists a confirmation record containing only a SHA-256
digest of the opaque token, the normalized action digest, stable principal
identity digest, issue/expiry timestamps, and an optional bound command ID.
The identity digest covers kind, ID, and surface—not the mutable display-name
snapshot. Plaintext tokens are returned once and are never stored.

1. Preview normalizes the proposal and principal inside the application
   boundary, reads the explicit pool/location/SKU in a transaction, and accepts
   only logical version `0` with no stock history.
2. Preview stores the confirmation record in that transaction but writes no
   balance, receipt, or command result.
3. The token expires exactly 300,000 milliseconds after issue. Confirmation is
   valid immediately and unconfirmed use fails when `now >= expiresAt`.
4. First confirmation requires the same normalized action and principal. It
   binds the token to the supplied command ID and stores either the committed
   result or stable business rejection in the same transaction.
5. An exact retry with the same token, command ID, normalized command, and
   principal returns the original terminal result even after token expiry or a
   database reopen.
6. A changed action or principal fails closed. A consumed token presented with
   another command ID fails closed. Those gate failures create no command
   result, balance, or receipt.
7. Changed contents under an already-used command ID retain the existing
   `command_id_conflict` behavior and never replace its stored result.

Confirmation gate failures are typed request errors with codes
`confirmation_not_found`, `confirmation_expired`, `confirmation_mismatch`, and
`confirmation_already_used`. They are not business command outcomes because the
command was never accepted for evaluation.

## Atomic storage boundary

`InventoryTransaction` gains confirmation lookup, insertion, and binding
operations. The opening-balance business evaluator is reusable inside an
already-open transaction so validation, first-use binding, balance/receipt
commit or stable rejection, and command-result persistence share one atomic
boundary. The public low-level `createSetOpeningBalance` entry point remains for
non-human engine use; future human-facing adapters must use the confirmation
boundary.

This slice introduced `opening-balance-local/v2` and
`inventory_opening_balance_confirmations`. The later read-back/actor slice
advances the current disposable marker to `opening-balance-local/v3` because
stored human receipt JSON is now receipt v2. Older test databases remain
deliberately incompatible; this adapter is neither a production migration
format nor the final storage layer.

## Blast radius

Exact-source inspection at stacked baseline
`2f100e3c94c60a8a154110d7db9da12b247ef9d9` found:

- runtime callers of the current command kernel: `0`;
- existing preview/confirmation implementation: none;
- production database bindings or migrations: none;
- affected Inventory modules: domain types, application command, storage port,
  local SQLite test adapter, and root exports;
- affected docs/tests: Inventory-owned opening-balance contracts and verifier;
- Blocks, SmokyClub, Commerce, EmDash, x-api, and shared review-conductor code:
  no dependency and no changed file.

The public contract and atomic state transition are medium risk. Persistence is
high risk in general but fenced here by the adapter's explicit test-only role,
absolute-path requirement, production refusal, metadata, and absence from root
exports.

## Verification plan

Tests are written and observed failing before source implementation. Green
proof must cover:

- exact preview shape, normalization, five-minute expiry, and zero stock effect;
- immediate confirmation and atomic balance/receipt/result persistence;
- preview persistence across database close/reopen;
- exact expiry-boundary rejection before first use;
- exact retry after expiry returning the byte-stable original result;
- action, principal, and consumed-token command-ID conflicts;
- stable business rejection and replay after first valid confirmation;
- changed content under one command ID preserving the original result;
- the local adapter remaining absent from the root API; and
- the complete existing opening-balance and workflow regression suites.

`bin/verify-opening-balance` remains the repo-owned focused entry point and is
extended through its existing test glob rather than replaced.
