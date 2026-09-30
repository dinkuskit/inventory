# Store-connect polling repair verification

The post-CAS/pre-read delay regression invokes the actual plugin admin and
public-proof handlers with simulated identities. Before the repair, an old
`expired_token` response deleted the replacement session and `slow_down`
overwrote it. After the repair, both cases preserve the replacement connection,
originating administrator, and published public proof (HTTP 200).

- [Before-repair receipt](regression-red.json): two failing assertions, exit 1.
- [After-repair receipt](regression-green.json): two passing tests, exit 0.
- [Source and verification manifest](verification.json): exact source hashes,
  original PR35 identities, current-main base, and full-gate receipt hashes.

Fresh `bin/verify-inventory full` passed: 189 Node tests, 29 Cloudflare tests,
three hosted tests, architecture checks, both typechecks, and plugin bundle.
Fresh `tools/run-hosted-onboarding-proof.mjs` passed through the actual EmDash
1.0.1 dispatcher and sandbox bundle, public proof, simulated website consent,
local provisioning, retry/reinstall/reconnect, and authorization boundaries.
Full gate used Node 22.23.1; dispatcher runner used Node 24.16.0; focused
regression used Node 24.19.0.

GrillTrack reconciliation plan
`42f7bb6da7a34ed32ceed850c064516d222cc3f82179215293aab43d62db353f`
preserves both approved store-control and checkout-basket lineages. Both test
globs remain in the manifest. Five joined decisions were reverified against
the fresh checks; composed review is still pending.

No visual layout changed; handler/proof state and actual dispatcher evidence
cover this repair, so no new screenshot was required. No live website consent,
credentials, account mutation, Registry install, deployment, or publication is
claimed. Independent qualification and formal code-review rails remain separate
from this author verification. Full local command output stays in the ignored
run packet; public receipts remove only local machine path prefixes.
