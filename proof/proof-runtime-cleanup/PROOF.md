# Local proof runtime cleanup — Inventory #64

Base: `4bfb8ff05f8fd20b3f92a07293210483b1ff38cf`, checked 2026-11-02 UTC.
Node `24.22.0`; clean `npm ci --include=optional` from the unchanged lockfile.
No product, stock, provider, auth, deployment or publication changes.

## Reproduction and scoped repair

On unchanged main, `bin/prove-stock-adjustment-real` returned **0**, but five
live descendants remained: Wrangler's launcher/CLI, esbuild, and two workerd
processes. An external observer tracked the proof's PID descendants while it
ran, inspected their identities after the proof exited, then explicitly cleaned
only those leaked processes. No detached process group or production process
was used or killed. The original output and process identities are retained by
the contributor; no synthetic session or stock data is needed in this note.

All four real proof runners now source one small PID-lineage shutdown helper.
It recursively terminates children before their parent, waits for the owned
background root, and clears that PID. Both explicit stop/restart and EXIT
cleanup use the same helper. Wrangler stdin is explicitly `/dev/null`.
HUP/INT/TERM exit with the conventional status and invoke EXIT cleanup once,
rather than removing state and then continuing the proof after a signal.
The server stays in the outer runner's process group; no `setsid` or negative
process-group kill is introduced.

## Acceptance-to-proof

| Requirement / authority | Observed proof | Refusal / limit |
| --- | --- | --- |
| Issue #64 AC1: close background server stdin | All four launch sites explicitly redirect stdin; lifecycle fixture checks EOF at each of three descendant depths | Fixture parent input remains an open pipe |
| Issue #64 AC2: terminate complete PID lineage without escaping the outer runner | Three-level non-forwarding wrappers all exit; same process group asserted; unrelated sibling survives explicit stop/restart | Repeated stop is safe; failed proof preserves status17; TERM preserves143; output pipes close |
| Issue #64 AC3: existing real proofs and canonical gate | Adjustment, reservation and checkout real proofs return0 with **zero live tracked descendants** after natural exit; canonical quick and full pass | Aggregate proof remains a pre-existing fixture failure **before Wrangler launches**, not a passing real-runtime proof |

The fixture is only a process-lifecycle regression, not Inventory domain or
installed-plugin proof. All product assertions in the existing proof programs
remain unchanged.

## Checks and exact limits

- `sh -n` on the helper and four runners: PASS.
- Focused lifecycle regression: **4 PASS** (wiring/stdio, restart, failure, TERM).
- `bin/verify-inventory quick`: PASS, **302 Node tests**, both typechecks and
  architecture checks.
- `bin/verify-inventory full`: PASS, **80.82s**; includes 302 Node tests,
  29 Cloudflare/workerd tests, 16 hosted Worker tests, Wrangler dry-run and plugin
  bundle validation. It ran in a systemd service; service teardown alone is not
  evidence of natural descendant cleanup. The separate proof observations above
  establish that for the three successful directly observed runners.
- Real adjustment: baseline exit0/**5 live leftovers** -> candidate exit0/**0**.
- Real reservation: candidate exit0/**0 live leftovers**.
- Real checkout: candidate exit0/**0 live leftovers**, with its required exact
  Commerce `31427206f834418ac4573f3fccca1771e27dbc42` source supplied through
  existing `DINKUSKIT_COMMERCE_CHECKOUT_ROOT`. The first attempt without that
  sibling source failed before Wrangler with ENOENT; that failure is retained.
- Real aggregate: base and candidate both exit1 before Wrangler. The unchanged
  SQLite fixture's opening balance is rejected where it expects committed
  (`tools/aggregate-stock-read-local-sqlite-proof.mjs:100`); it does not register
  its SKU before the opening command. This change does not repair or bypass that
  separate fixture/read-model qualification gap. No assertion was weakened.

Thus this repairs and covers process cleanup, but **does not claim all four
real domain proofs are green or that every acceptance condition of #64 is
complete**. No full-suite retry, live provider, production or Registry-installed
qualification. No dependency pin or metadata edits; npm reported existing
locked-dependency advisories, not a security-clean bill of health.

Material AI assistance: pi / OpenAI gpt-6.1-sol generated this change and proof.
