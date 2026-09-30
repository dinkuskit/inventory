# Hosted onboarding draft proof

Base: `1228ed5f0ff74b8e5a6e303a1fe54698b04de441`
Branch: `codex/inventory-hosted-onboarding`
Track: `gt-20260930005601-551c1b`

Actual checks obtained before draft publication:

- Node onboarding and JOSE authorization tests: 7 passed, 0 failed.
- Local Cloudflare workerd / SQLite Durable Object tests: 3 passed, 0 failed.
- Cloudflare and plugin typechecking: passed.
- Standard plugin build with exact EmDash 1.0.1 toolchain: passed.
- EmDash sandbox flow: **failed** at device-grant startup. The sandbox loads
  the built artifact and returns the truthful unavailable status; successful
  sign-in/setup through the sandbox has not yet been proven.
- Canonical full verifier and bundle validation: not yet completed at draft
  publication.

The device-flow fixture uses synthetic identity, reserved `.invalid` origins
and ephemeral keys. It is not real account integration, remote deployment,
Registry installation or publication. No DinkusKit account service was found
in the organization repository inventory. Receiving and adjustment screens
remain outside this setup slice.

Bobby explicitly authorized committing, pushing and opening a draft with
formal review pending while the review rails are repaired separately.
No clean independent review, merge or deployment is claimed.
