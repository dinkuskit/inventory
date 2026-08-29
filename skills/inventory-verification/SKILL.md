---
name: inventory-verification
description: Run Inventory's canonical repository verification gate before review or delivery.
---

# Inventory verification

Use the repository-owned verifier from the repository root:

```bash
bin/verify-inventory quick
bin/verify-inventory full
```

Use `quick` while implementing. It validates the feature map and import
boundaries, runs strict Cloudflare typechecking, and runs every
platform-neutral Node test.

Use `full` before review or delivery. It includes `quick`, the real Cloudflare
workerd Durable Object tests, deployment-contract tests, and Wrangler dry-run.

Success returns exit code `0` and prints `verify-inventory <scope> passed`.
Any child failure returns non-zero. Read the first failing command's diagnostic,
repair that contract, and rerun the same scope. Existing focused
`bin/verify-*` scripts remain useful for narrowing a failure, but they do not
replace the canonical full gate.
