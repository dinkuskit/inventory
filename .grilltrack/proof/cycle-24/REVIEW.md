# Cycle 24 review — Packed to Delivered

Standards: matches reservation feature-local shape (`pack_all` all-or-none, empty balance effects). Schema v9 CHECK includes `delivered`. Unique open-hold index still `not_shipped` / `partially_packed`. No Woo/Katana/ShipTheory code.

Source intent vs locks:

- Marked Delivered is a command, not a carrier scan.
- Whole packed ticket; no quantity; no partial deliver.
- Fully packed only; not shipped / partial / canceled / already delivered reject.
- One command, one or more ticket IDs Commerce already has. No order number.
- Status only.

Findings: none required. Review identity waits on an explicit commit; working tree is not an immutable source.
