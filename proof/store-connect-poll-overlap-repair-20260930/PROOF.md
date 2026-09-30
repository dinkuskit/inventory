# Store-connect poll overlap concurrency repair verification

The committed regression in `tests/store-connect/poll-cas-reread.test.mjs` verifies
that when a one-use token exchange response is delayed past the polling interval,
cadence expiry does not admit an overlapping token exchange for the same challenge.
Before the repair, a second exchange occurred, received `already_redeemed`, cleared
the challenge, and prevented the delayed success response from saving the token.
After the repair, `nextPoll` is held at `session.expiresAt` during the in-flight
exchange, ensuring mutual exclusion while preserving normal pending, slow_down, and
safe error recovery.

- [Before-repair receipt](regression-red.json): failing assertion (2 !== 1 exchanges), exit 1.
- [After-repair receipt](regression-green.json): 6 passing tests, exit 0.
- [Source and verification manifest](verification.json): exact source hashes,
  base/head lineage, and gate receipts.

Fresh `bin/verify-inventory full` passed: 194 Node tests, 29 Cloudflare tests,
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
