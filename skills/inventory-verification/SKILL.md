---
name: inventory-verification
description: Run Inventory's canonical repository verification gate before review or delivery.
---

# Inventory verification

Install locked dependencies with `npm ci` using a Node version supported by
`package.json`. Use the repository-owned verifier from the repository root:

```bash
bin/verify-inventory quick
bin/verify-inventory full
```

Use `quick` while implementing. It validates the feature map and import
boundaries, runs strict Cloudflare and EmDash plugin typechecking, and runs every
platform-neutral Node test.

Use `full` before review or delivery. It includes `quick`, the real Cloudflare
workerd Durable Object tests, deployment-contract tests, Wrangler dry-run, hosted Worker tests, and the
EmDash plugin bundle. Hosted tests are local workerd fixtures, not production
service requests. The bundle is built locally and is not published.

Success returns exit code `0` and prints `verify-inventory <scope> passed`.
The default scope is `quick`; unsupported scopes exit 64.
Any child failure returns non-zero. Read the first failing command's diagnostic,
repair that contract, and rerun the same scope. Existing focused
`bin/verify-*` scripts remain useful for narrowing a failure, but they do not
replace the canonical full gate.

If Vitest or the sandbox bundler reports a missing platform-native binding,
repeat the locked install with a compatible npm and `--include=optional`.
Use the CI-pinned Node 24.22.0 with its bundled npm (a clean `npm ci` under
it installs the native runtime dependencies); an older host npm 11 install
once omitted them. Preserve the lockfile and pins.
