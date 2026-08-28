# Authoritative balance and receipt read-back

Status: confirmed implementation contract for GrillTrack decisions
`read-back-021` and `receipt-actor-022`.

## Scope

This slice adds two platform-neutral, read-only application operations over the
verified opening-balance kernel:

1. read one current balance using an explicit pool, location, and SKU; and
2. read one stored mutation outcome using exactly one receipt ID or command ID.

A receipt is the immutable audit proof created with a committed stock mutation.
For an opening balance it records the signed-in actor, reason, exact quantity
effect, affected pool/location/SKU, resulting balance/version, time, command
identity, and receipt identity. A later correction creates another receipt and
does not edit the opening receipt.

This slice also makes human actor identity readable: the trusted execution
principal contains a stable user ID, public-safe display-name snapshot, and
originating surface. The future EmDash adapter derives those facts from its
authenticated session; command payloads cannot supply or override them.

No history list, search, pagination, GUI, EmDash session integration,
authentication implementation, service transport, Cloudflare binding,
deployment, publication, or production storage is added.

## Module boundaries

| Module | Owns | Does not own |
| --- | --- | --- |
| `src/domain/inventory-read.ts` | Versioned read inputs/results and strict normalization | Persistence, authorization, SQL, UI |
| `src/application/read-inventory.ts` | One balance read and one mutation-result lookup | Database layout, authentication, inferred context |
| `src/domain/opening-balance.ts` | Versioned receipt and human/system principal shapes | EmDash session validation or name resolution |
| `src/storage/inventory-store.ts` | Platform-neutral read ports for command and receipt identity | Query presentation or auth policy |
| `src/storage/local-sqlite-test-store.ts` | Durable local test reads and disposable schema fence | Production durability or migration claims |
| `src/index.ts` | Platform-neutral read, receipt, and command contracts | Local SQLite test adapter |

## Public types and signatures

```ts
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

type ReadSkuLocationBalanceInput = Readonly<{
  poolId: string;
  locationId: string;
  skuId: string;
}>;

type SkuLocationBalanceReadResult =
  | Readonly<{
      schema: "dinkuskit.inventory.balance-read-result/v1";
      outcome: "found";
      key: SkuLocationKey;
      balance: BalanceRecord;
    }>
  | Readonly<{
      schema: "dinkuskit.inventory.balance-read-result/v1";
      outcome: "not_found";
      key: SkuLocationKey;
    }>;

type InventoryMutationLookup =
  | Readonly<{ receiptId: string; commandId?: never }>
  | Readonly<{ commandId: string; receiptId?: never }>;

type InventoryMutationReadResult =
  | Readonly<{
      schema: "dinkuskit.inventory.mutation-read-result/v1";
      outcome: "found";
      lookup: Readonly<{ receiptId: string } | { commandId: string }>;
      result: OpeningBalanceResult;
    }>
  | Readonly<{
      schema: "dinkuskit.inventory.mutation-read-result/v1";
      outcome: "not_found";
      lookup: Readonly<{ receiptId: string } | { commandId: string }>;
    }>;

type ReadSkuLocationBalance = (
  input: ReadSkuLocationBalanceInput,
) => Promise<SkuLocationBalanceReadResult>;

type ReadInventoryMutation = (
  lookup: InventoryMutationLookup,
) => Promise<InventoryMutationReadResult>;
```

Read inputs reject blank identifiers. Mutation lookup rejects both identifiers
or neither identifier. Missing records return explicit `not_found`; the
application never guesses a latest balance, command, or receipt.

## Actor and receipt invariants

The receipt schema advances to `dinkuskit.inventory.receipt/v2` because a human
principal now requires `displayName`. The package is private and has no runtime
callers, but versioning still prevents a silent incompatible shape change.

- A human receipt freezes `kind`, stable user `id`, `displayName`, and
  `surface` at commit.
- A system receipt retains `kind`, stable system `id`, and `surface` without a
  fabricated human display name.
- The application receives trusted execution context. Any actor-like field in
  a command payload has no authority and cannot affect the receipt.
- Preview confirmation binds to stable principal identity (`kind`, `id`, and
  `surface`), not `displayName`. A rename during the confirmation window does
  not change who the principal is.
- A receipt captures the display name presented at the successful commit.
  Later exact replay returns that original receipt even if the account has
  since been renamed.
- Email is neither required nor stored by this contract.

## Read invariants

1. Balance read requires the complete explicit pool/location/SKU key and
   returns only that key.
2. Receipt-ID lookup resolves only a committed result, because rejections have
   no receipt.
3. Command-ID lookup resolves either the original committed result with its
   receipt or the original stable business rejection.
4. Both lookup paths return the exact stored terminal JSON and never rebuild a
   receipt from current account or balance state.
5. Reads are side-effect free and do not create command results, receipts,
   confirmations, or balances.
6. Existing command replay, confirmation, and one-writer transaction behavior
   remains unchanged.

`InventoryStore` gains `readCommand(commandId)` and
`readCommandByReceiptId(receiptId)`. The local adapter uses the existing
command-result and receipt tables; no second ledger or history table is added.
Its disposable schema metadata advances to `opening-balance-local/v3` because
stored receipt JSON now uses receipt schema v2. Old local test files remain
deliberately incompatible and are not production migration inputs.

## Blast-radius report

Exact-source inspection against reviewed source identity
`sha256:74007db421e3580441bd90d282ba3189b3af2135103caa29aa2563987d6344b8`
found:

- runtime callers outside Inventory: `0`;
- internal application callers: tests only;
- `CommandPrincipal` consumers: opening-balance command, confirmation boundary,
  root exports, tests, and contracts;
- low-level `readBalance`/`readReceipt` consumers: tests only;
- production database bindings or migrations: `0`;
- package status: private `0.0.0`, unpublished;
- unrelated Blocks, SmokyClub, Commerce, EmDash, x-api, and review-conductor
  source: no dependency and no changed file.

Risk classification:

- receipt/principal schema: medium/high because it is exported and immutable,
  reduced by explicit v2 versioning, no runtime callers, and complete tests;
- read application functions: medium because they become public contracts;
- SQLite read queries and disposable v3 metadata: medium, fenced test-only;
- verifier/docs changes: low.

## Verification plan

Tests are written and observed failing before implementation. Green proof must
cover:

- explicit balance found and not-found results with location isolation;
- committed mutation lookup by receipt ID and command ID;
- stable rejection lookup by command ID with no receipt;
- explicit not-found for missing command and receipt identity;
- rejection of blank, both, or neither mutation identifiers;
- durable read-back after database close/reopen;
- receipt v2 actor ID, display-name snapshot, and `emdash` surface;
- actor-like command fields failing to override trusted execution context;
- display-name change preserving confirmation by stable ID and exact replay of
  the original historical name;
- every existing opening-balance/confirmation invariant; and
- the complete workflow regression suite.

The existing `bin/verify-opening-balance` glob remains the repo-owned focused
entry point. Its skill description is updated rather than creating another
verification surface.
