# Whole-transfer receipt

This contract covers the platform-neutral, Inventory-owned
`In transit -> Received` command. It completes the first stock-transfer
lifecycle without adding partial receiving, Received reversion, GUI work,
Commerce/Blocks integration, remote mutation exposure, deployment, or
production cutover.

## Command contract

```ts
type ReceiveStockTransferCommandV1 = Readonly<{
  schema: "dinkuskit.inventory.command/v1";
  commandId: string;
  type: "transfer.receive";
  context: Readonly<{ siteId: string; poolId: string }>;
  payload: Readonly<{ transferId: string }>;
  references: readonly ExternalReference[];
  expectedVersions: readonly Readonly<{
    transferId: string;
    version: string;
  }>[];
}>;
```

The payload contains exactly one permanent transfer ID. The expected-version
vector contains exactly that transfer and one positive version. A reason,
received date, line list, actual quantity, partial quantity, or discrepancy
field is invalid command input.

Receive requires an existing In-transit transfer at the exact expected version.
The transferred lines and quantities are the frozen dispatched shipment facts;
the caller cannot rewrite them during receipt. Expected dispatch and arrival
dates remain retained planning facts and never gate receipt.

## Atomic state change

One serialized pool transaction changes the complete transfer:

- every line removes its full quantity from destination in-transit;
- every line adds the same full quantity to destination on-hand;
- destination reservations and outgoing commitments remain unchanged;
- destination available is re-derived as
  `onHand - reserved - outgoingTransferCommitted`;
- destination physical stock history becomes established;
- every origin balance and version remains unchanged;
- transfer status becomes `received` under Done;
- transfer version advances once; and
- `receivedDate`, `updatedAt`, and receipt `committedAt` use the same trusted
  automatic timestamp.

The immutable receipt freezes the signed-in actor, command ID and digest,
context, before/after transfer, exact destination effects, references, and
commit time. It has `type: "transfer.receive"` and no reason property.

Receipt uses the already-dispatched frozen shipment even if an origin that sent
all of its stock was archived afterward. Revalidating that origin as active
would strand physical stock already in transit. The receiving location cannot
be archived normally because its non-zero in-transit quantity is an archive
blocker.

## Retry and failure behavior

An exact `commandId` replay returns the original terminal result, actor,
timestamp, receipt ID, transfer version, and effects without writing again. A
reused command ID with changed contents returns `command_id_conflict`. Unknown
transfers, wrong states, and stale versions reject durably without effects. A
second new receive command after success rejects because the transfer is no
longer In-transit.

Transfer record, all changed destination balances, immutable receipt, and
terminal result commit through the existing `commitStockTransfer` boundary.
Any storage failure rolls them all back. Both local-test SQLite and Cloudflare
SQLite receipt-history queries include the receive type; a location-scoped
receive receipt appears for the physical destination, not the unchanged origin.

## Physical discrepancies

V1 still receives the complete documented shipment when fewer usable units
arrive. The operator then submits a separate destination `stock.adjust` command
with its required typed reason, such as `One hat damaged during transfer`, and
may link that new receipt to the receive receipt. The adjustment is explicit,
independently version-bound, and never edits the original transfer or receipt.

Partial receiving and Received reversion remain deferred.

## Storage and verification

No schema migration is required. Cloudflare schema v4 and the local test schema
already permit `received`; transfer and receipt JSON already carry
`receivedDate` and the widened command type; balance tables already store every
affected quantity, version, and history flag.

`bin/verify-stock-transfer` proves strict normalization, multi-line effects,
automatic actor/time, reasonless receipt, history establishment and scoping,
opening-balance exclusion, separate reasoned discrepancy adjustment,
replay/conflict/rejections, archived-origin completion, local rollback and
reopen, Cloudflare rollback/parity, and unchanged migration identity.
