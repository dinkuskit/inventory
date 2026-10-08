---
name: inventory-cli
description: Read and change DinkusKit Inventory stock through the dinkus-inventory CLI instead of hand-written API calls.
---

# Inventory CLI

Use `bin/dinkus-inventory.mjs` (installed name `dinkus-inventory`) for every
Inventory read or stock change. The CLI owns the mechanics: authentication,
context checks, preview and confirmation, the pending-command store, and exit
codes. Do not rebuild those with `curl` or ad hoc scripts. The contract is
[docs/CLI-SPEC.md](../../docs/CLI-SPEC.md).

The caller's environment must already provide `DINKUS_INVENTORY_TOKEN`. Never
print, paste, or write the token anywhere, and never put it in a profile.
Set the endpoint with `--endpoint`, `DINKUS_INVENTORY_ENDPOINT` or user
config: the CLI refuses (exit `4`, `untrusted_endpoint`) to send the token to
an endpoint from the working directory's `.dinkuskit/inventory.json`.

## Reading

1. Start with `dinkus-inventory --site <id> status --json` and stop if the
   status is not `ready`.
2. Use `--json` for anything you parse. Read `outcome` and `context` before
   `data`.

## Changing stock

1. Run the change with `--dry-run --json`, passing `--site`, `--pool` and
   `--location` explicitly. Never guess a location from a SKU or hostname.
2. Read the preview: before and after quantities, warnings such as overselling.
   If the effect is not what the operator asked for, or any warning appears,
   stop and ask the human.
3. Commit with the same arguments plus `--no-input --confirm <value>` from that
   preview, before it expires.

## Exit codes

- `0` done. `1` a business rejection or a planned command: report the code,
  do not retry as new.
- `2` fix the invocation. `4` an authorization or confirmation gate: ask the
  human; previewing again is the only retry.
- `3` with `outcome: "unknown"`: run `dinkus-inventory commands resolve <commandId>`.
  Never submit the change again as a new command.
- `5` the service broke its contract: stop and report.
