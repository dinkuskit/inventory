# Opening-balance local slice

Status: confirmed implementation contract for GrillTrack decision
`opening-balance-storage-019`.

## Scope and storage fence

This slice makes one Inventory-owned `stock.opening_balance` command executable
for one explicit pool, location, and SKU. It owns command normalization,
idempotency, the one-time opening-balance rule, balance versioning, immutable
receipts, stable terminal results, and a platform-neutral transaction port.

The first adapter writes a real SQLite file so tests can close and reopen the
database and prove persistence. It is named and guarded as local development
and test storage. It has no default path, rejects in-memory databases, refuses
to start under `NODE_ENV=production`, and records its test-only role in database
metadata. It is not exported from the platform-neutral package root. It is not
a production adapter, migration format, service, deployment binding, or
substitute for the separately gated Cloudflare SQLite Durable Object topology.

This slice does not own authentication, HTTP routes, Block Kit, EmDash,
SmokyClub, Commerce, Cloudflare deployment, package publication, production
configuration, or production data.

## Modules and responsibilities

| Module | Owns | Does not own |
| --- | --- | --- |
| `src/domain/opening-balance.ts` | Versioned command, quantity, terminal-result, balance, and receipt types; normalization and digest input | Persistence, authentication, transport, clocks, IDs |
| `src/application/set-opening-balance.ts` | Replay/conflict behavior, business rejection precedence, one-time opening balance, receipt/result construction | SQL, HTTP, UI, authentication |
| `src/storage/inventory-store.ts` | Platform-neutral transaction and read contracts | Business rules or storage implementation |
| `src/storage/local-sqlite-test-store.ts` | Real local-file transactions and test inspection reads | Production durability claims, Cloudflare binding, business decisions |
| `src/index.ts` | Platform-neutral domain, application, and transaction-port exports | The local SQLite test adapter, package publication, or compatibility promise |

## Types and interfaces

```ts
type ExactQuantity = Readonly<{ value: string; unit: string }>;

type SetOpeningBalanceCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
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
  references: readonly Readonly<{ kind: string; id: string }>[];
  expectedVersions: readonly Readonly<{
    skuId: string;
    locationId: string;
    version: "0";
  }>[];
}>;

type HumanCommandPrincipal = Readonly<{
  kind: "human";
  id: string;
  displayName: string;
  surface: string;
}>;

type SystemCommandPrincipal = Readonly<{
  kind: "system";
  id: string;
  surface: string;
}>;

type CommandPrincipal = HumanCommandPrincipal | SystemCommandPrincipal;

type OpeningBalanceRejectionCode =
  | "opening_balance_already_set"
  | "command_id_conflict";

type OpeningBalanceResult =
  | Readonly<{
      schema: "dinkuskit.inventory.command-result/v1";
      outcome: "committed";
      commandId: string;
      receipt: OpeningBalanceReceiptV2;
    }>
  | Readonly<{
      schema: "dinkuskit.inventory.command-result/v1";
      outcome: "rejected";
      commandId: string;
      code: OpeningBalanceRejectionCode;
      message: string;
    }>;

interface InventoryTransaction {
  getCommand(commandId: string): StoredCommandResult | null;
  getBalance(key: SkuLocationKey): BalanceRecord | null;
  storeRejection(record: StoredCommandResult): void;
  commitOpeningBalance(input: OpeningBalanceCommit): void;
}

interface InventoryStore {
  runTransaction<T>(
    poolId: string,
    operation: (transaction: InventoryTransaction) => T,
  ): Promise<T>;
  readBalance(key: SkuLocationKey): Promise<BalanceRecord | null>;
  readCommand(commandId: string): Promise<StoredCommandResult | null>;
  readCommandByReceiptId(
    receiptId: string,
  ): Promise<StoredCommandResult | null>;
  readReceipt(receiptId: string): Promise<OpeningBalanceReceiptV2 | null>;
  close(): Promise<void>;
}

type SetOpeningBalance = (
  command: SetOpeningBalanceCommandV1,
  execution: Readonly<{ principal: CommandPrincipal }>,
) => Promise<OpeningBalanceResult>;
```

The service/authentication adapter will eventually derive `CommandPrincipal`
from an authenticated principal. This local slice receives that trusted context
as an application dependency and does not pretend to authenticate it.

The later read-back slice advances human receipts to v2 with a trusted
display-name snapshot and the disposable local schema marker to
`opening-balance-local/v3`. Those additions do not turn this schema into a
production migration format.

## State and invariants

1. Structural validation and normalization happen before storage. Malformed
   requests are request failures and do not become terminal command results.
2. The normalized command digest covers the versioned business envelope, not
   transport metadata or the derived principal.
3. A transaction first checks the globally unique `commandId`:
   - same digest returns the original stored result;
   - different digest returns `command_id_conflict` while preserving the
     original stored result.
4. A new command for a SKU-location with stock history stores a stable
   `opening_balance_already_set` rejection with no balance or receipt effect.
5. The command must carry the one exact expected version-0 entry for its
   SKU-location. Other shapes are malformed request failures. General stale
   preview handling remains deferred with the preview/confirmation flow.
6. A valid first opening balance stores the new version-1 balance, immutable
   receipt, and committed terminal result in one SQLite transaction.
7. An opening balance affects only its explicit pool/location/SKU key. No site,
   hostname, SKU, or remembered default may infer pool or location.
8. Exact replay remains byte-stable after closing and reopening the database.
9. Competing distinct command IDs serialize: exactly one can create the
   opening balance; every other accepted command receives a stored rejection.
10. Quantity is a canonical non-negative decimal string with an explicit unit.
    This slice sets on-hand from logical zero and does not introduce general
    arithmetic or adjustment behavior.

## Local SQLite schema boundary

The disposable local adapter uses these logical tables:

- `inventory_storage_metadata`: records schema version and
  `storage_role=local-development-test-only`;
- `inventory_command_results`: globally unique command ID, normalized digest,
  and the exact terminal-result JSON;
- `inventory_balances`: one row per pool/location/SKU with exact quantities,
  unit, version, and stock-history marker;
- `inventory_receipts`: one immutable row per committed command with receipt
  JSON.

Foreign keys, uniqueness constraints, `BEGIN IMMEDIATE`, and one transaction
bind receipt, balance, and result. This schema is test proof, not the promised
Cloudflare migration format.

## Blast-radius report

Exact-source search at baseline
`d1603797aef020224c4a7d6dc8f215a1cea51820` found:

- runtime callers: `0`;
- Inventory source modules: `0`;
- existing database migrations or production bindings: `0`;
- existing tests affected by imports: `0`;
- public contract references: `AGENTS.md`, `README.md`, `docs/CHARTER.md`,
  `docs/COMMAND-RECEIPT-CONTRACT.md`, and `docs/CLI-SPEC.md`;
- unrelated workflow tests retained: `2` files under `tests/workflows/`;
- external runtime dependencies: none; `emdash@0.35.0` remains a development
  scaffold dependency and is not imported by the kernel.

Risk classification:

- domain/application exports: medium, because they create the future shared
  client boundary even though no caller exists yet;
- local SQLite schema: high, because persistence contracts are sticky, reduced
  by its explicit test-only fence and lack of production compatibility claim;
- test-runner and verification-script additions: low, provided both existing
  workflow suites remain green;
- Blocks, Commerce, SmokyClub, EmDash runtime, and scheduler/index
  materialization: no dependency and no changed file.

## Verification plan

Tests must be written and observed failing before implementation. Green proof
must cover:

- first commit and complete receipt/balance agreement;
- exact replay before and after database reopen;
- changed content under the same command ID;
- a stored second-opening rejection remaining rejected after reopen;
- explicit pool/location isolation;
- competing command IDs producing one commit and one stable rejection;
- atomic rollback on an injected failure between planned writes;
- production-mode and in-memory storage refusal;
- refusal to claim unrelated or schema-incompatible SQLite files; and
- all pre-existing workflow tests.

`bin/verify-opening-balance` is the non-interactive repo-owned verification
entry point. It creates no persistent repository data and exits nonzero on any
failure.
