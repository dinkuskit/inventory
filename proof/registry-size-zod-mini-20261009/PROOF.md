# Registry plugin size: zod/mini — 2026-10-09

Repository: `dinkuskit/inventory`. Base: `fd2df02` (main).
Branch: `claude/inventory-shrink-registry-plugin-u8zphd`.

## Problem

The EmDash Registry rejects any plugin file over 131,072 bytes (128 KiB,
`MAX_FILE_SIZE` in `@emdash-cms/plugin-cli` 0.13.3). On `fd2df02` the sandbox
backend (`backend.js` in the tarball, `dist/plugin.mjs`) was 131,060 bytes,
12 bytes under. Building the same entry with zod left out gives 49,354 bytes,
so full zod was about 81.7 KB, 62% of the file.

## Change

`plugins/emdash-inventory/src/plugin.ts` and
`src/features/store-connect/protocol.ts` (the only shared module the plugin
imports) now use `zod/mini`, zod's small edition. It runs the same validation
core as full zod; only the way schemas are written changes
(`z.optional(x)` instead of `x.optional()`, `z.strictObject` instead of
`.strict()`, `.check(z.minLength(1))` instead of `.min(1)`). The hosted
service's own schemas keep full zod; nothing there has a size limit.

`build:plugin` and `bundle:plugin` now run from the plugin directory, the
same directory `emdash-plugin publish` runs from. From the repository root
the bundler reads the root `package.json`, treats `zod/mini` as an external
production dependency and leaves it out of the sandbox file, which then fails
the plugin probe. From the plugin directory it is bundled like `zod` was.

## Size

| | `backend.js` bytes | headroom under 131,072 |
| --- | ---: | ---: |
| `fd2df02` | 131,060 | 12 |
| this branch | 76,051 | 55,021 |

`npm run bundle:plugin`: "Bundle size: 75.2 KB across 2 files", validation
passed, tarball contains `backend.js` (76,051) and `manifest.json` (988), and
the bundle has no `import` of any package.

## Same behaviour

`node --experimental-strip-types proof/registry-size-zod-mini-20261009/compare-validation.mjs fd2df02`
loads all 45 named schemas from the base and from this branch:

```
Base fd2df02: 45 schemas; 0 missing; 0 differ rule by rule
135000 random inputs: 57617 accepted, 77383 rejected, 0 differ in result, data or error details
```

The rule-by-rule check compares every type, field, strictness setting,
default, length and number limit, trim and URL check. A deliberate one-rule
change (strict to loose, max 60 to 61, length 1 to 2) was confirmed to be
reported before relying on it. The random inputs compare accepted data and
the full list of error issues (code, path, message).

The one difference that remains is the class of a thrown error
(`ZodMiniError` instead of `ZodError`). Nothing the plugin or Store Connect
schemas feed checks that class; the hosted worker's `instanceof z.ZodError`
only wraps its own full-zod schemas.

## Checks

`bin/verify-inventory full` on Node 22.22.0: PASS. 268 Node tests plus the
3 + 3 workflow tests, 29 Cloudflare tests, 16 hosted tests, architecture
audit, both TypeScript checks, Wrangler dry-run and plugin bundle.

The sandbox proof hosts `tools/emdash-stock-admin-host.mjs` and
`tools/opening-stock-proof-host.mjs` were run in the real workerd sandbox
against both bundles. Both already fail on `fd2df02` at the same later step
(the admin page shows "Connection could not be confirmed"); with this branch
they produce identical output to the base, line for line after removing
hashes, ids and timestamps. That failure predates this change and is not
fixed here.

No product behaviour, API, stock rule or Registry manifest changed.
GrillTrack: proposed decision `registry-plugin-validation-001`.
