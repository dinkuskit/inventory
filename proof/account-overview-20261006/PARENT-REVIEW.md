# Exact-source parent review

Source: `6f52ae1ad07595009bd02658bbf965a1728b20fb` against base
`c565c984d4635bdb6a20194d58a39bd74b3f50fe`.

Standards review: the projection belongs to the hosted-onboarding public entry;
Cloudflare owns storage/auth/routing. Existing account storage and stock kernel
are preserved. No new inventory writer, private configuration or customer
records were added. The canonical verifier and corrected auth tests passed.

Intent review: one signed organization selects retained metadata, with the caller
separate from organization authority. The fixed scalar audience, sole read scope
and at-most-300-second lifetime enforce the human-selected boundary. Responses
exclude stock/product/contact data and report unavailable reads honestly. Website
retains origin and grant authority. Local proof does not claim live admission.

Accepted findings: broader audience admission, whitespace identity ambiguity,
unknown provisioning state, coarse failure reasons and ineffective negative JWT
fixtures were repaired and independently verified. The final source has no
remaining actionable finding in the assigned slice. Live health, bulk reads,
telemetry and real operator grants were rejected as outside the locked scope.

Result: clean parent review. Independent CI, comprehensive OpenClaw and native
ClawSweeper must still qualify the final PR head; merge remains human-gated.
