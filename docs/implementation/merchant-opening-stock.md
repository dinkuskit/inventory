# Reviewed initial stock

The standard plugin now offers **Preview initial stock** for an explicitly selected,
already registered Inventory SKU at an active location with no physical history.
The hosted eligibility read validates SKU identity and location in one canonical
transaction. An absent balance row is valid first use only after those checks;
unknown SKU, inactive location, or an unavailable service offers no mutation.
A zero balance with stock history uses ordinary adjustment.

Authenticated hosted routes are `GET /v1/stock/opening/eligibility` with explicit
`sku_id` and `location_id`, and `POST /v1/stock/opening/preview` and `/confirm`.
Account identity, site and pool come from authenticated service binding. Preview
requires quantity, reason and explicit location; it invokes the existing kernel
without movement. Confirmation carries the original caller-created command ID,
preview token, normalized command and expected version. Canonical replay returns
the original receipt even after expiry or service restart.

The plugin persists an originating-admin-bound intent before confirmation send.
Delayed preview responses cannot replace a concurrent pending intent. Reload and
retry preserve the original envelope after an unknown outcome. Only matching
200 committed / 409 rejected outcomes, or documented 409 confirmation gate failures,
resolve it. Unavailable, unauthorized, malformed or mismatched responses preserve
pending state. Other administrators cannot confirm, retry, cancel, clear or replace it.

Proof: `proof/merchant-setup-20261006/`. Run `bin/verify-inventory full` and
`node tools/opening-stock-proof-host.mjs` with a fresh worktree-local
`EMDASH_OPENING_PROOF_RUN_DIR`. The proof uses a synthetic signed account and
identity-only SKU fixture, published dispatcher/workerd, and an explicit local
authority transform. It seeds no opening stock. Generated storage and packages
are preserved under the ignored run directory. Captures show actual sandbox
responses in the published Block Kit renderer, rather than a Registry installation.

This slice does not implement merchant catalog selection, SKU registration UI,
Registry signing/delivery, live hosted issuance, website integration, Commerce
transport/fulfillment composition or production stock admission. Inventory remains
concurrent and NONBLOCKING for Commerce v1. Production authorities remain
fail-closed placeholders; the self-host/hosted service uses one canonical kernel.
