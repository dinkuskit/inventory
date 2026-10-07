# Parent review and adjudication

- Accepted: registration response validation incorrectly required `unit`, which the existing kernel's identity result does not contain. A failing regression reproduced a successful registration remaining pending. Separate identity/list schemas now match the canonical contract.
- Accepted: an existing SKU registration must not claim zero stock. Its success notice states that registration left stock unchanged.
- Accepted: a fresh pool must not render a stock select with no choices. Registration remains available and the empty selector is omitted.
- Accepted: a stale stored SKU selection must resolve through the current owned list before fetching or rendering stock. The selected identity now comes from that list.
- Verification gap repaired: the worker's first two-store test injected principals. Final tests verify signed ES256 JWTs through the real authenticator, independent stock/receipt boundaries, explicit same-account sharing and refusal to silently migrate a connected store.
- Rejected: separate customers require a database-topology rewrite. Existing account and pool Durable Objects already enforce independent SQLite storage; the bounded change preserves that topology.
- Local proof limitations retained: two Website test controllers, synthetic CMS admin, unsigned local authority variants, five-minute JWT lifetime, per-host standalone sandbox port allocation and scoped native-child cleanup. These are documented rather than represented as hosted or Registry proof.

Reviewed code and test identities are bound by source-manifest.json. Automated external review adjudication is recorded separately at the exact PR tuple.
