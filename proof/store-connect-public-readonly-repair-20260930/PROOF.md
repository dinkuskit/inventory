# Store-connect public proof read-only session inspection repair verification

The committed regression in `tests/store-connect/legacy-device-session.test.mjs` verifies
that public unauthenticated `store-proof` GET requests cannot mutate private admin
state when a legacy device session or malformed session is stored.

Before the repair, `plugin.routes["store-proof"].handler` invoked `readSession(ctx)`,
which executed `clearSession(ctx, stored.revision)` (`compareAndDelete`) upon encountering
a legacy `phase: "device"` session. This allowed unauthenticated public GET requests
to delete private admin session state. Malformed session JSON also threw an
unhandled SyntaxError; the public handler now returns 404 for that state.

After the repair, `store-proof` invokes `inspectSession(ctx)`, an explicit read-only
session inspection helper that never mutates settings or KV and fails closed if
session state is absent, non-current, or malformed. Authenticated private admin cleanup
in `readSession(ctx)` remains intact for admin routes. Additionally, `readProof(ctx)`
uses `proofReceiptSchema.safeParse` to fail closed without unhandled exceptions.

- [Before-repair receipt](regression-red.json): failing assertion (legacy session deleted, revision undefined !== 'r1', uncaught SyntaxError), exit 1.
- [After-repair receipt](regression-green.json): 5 passing tests, exit 0.
- [Source and verification manifest](verification.json): exact source hashes,
  base/head lineage, and gate receipts.

Fresh `bin/verify-inventory full` passed: 198 Node tests, 29 Cloudflare tests,
three hosted tests, architecture checks, both typechecks, and plugin bundle.
Fresh `tools/run-hosted-onboarding-proof.mjs` passed through the actual EmDash
1.0.1 dispatcher and sandbox bundle, public proof, simulated website consent,
local DO provisioning, retry/reinstall/reconnect, and authorization boundaries.
Full gate used Node 22.23.1; dispatcher runner used Node 24.16.0; focused
regression used Node 24.19.0.

No visual layout changed; handler/proof state and actual dispatcher evidence
cover this repair, so no new screenshot was required. No live website consent,
credentials, account mutation, Registry install, deployment, or publication is
claimed. Independent qualification and formal code-review rails remain separate
from this author verification. Full local command output stays in the ignored
run packet; public receipts remove only local machine path prefixes.
