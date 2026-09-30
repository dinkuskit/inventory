# Accepted required_fix: site-bound release-fence identity

Reviewed source identity: `git:dc91bf628d0c25340c18fe3a83757275ee0ac19f`
Decision: `checkout-basket-001`
Classification: `required_fix`
Public PR: https://github.com/dinkuskit/inventory/pull/36

## Finding

`evaluateReserve` treated any stored `checkout.release:<operationId>` command as
a terminal fence and could persist `checkout_released` before comparing that
stored `release.commandDigest` with the current site-bound command digest.

A different site sharing one pool could therefore release first under the same
caller `operationId` and poison a later reserve for the colliding identity.

## Authoritative contract (unchanged)

- Command IDs remain globally unique. Changed contents under one ID return
  `command_id_conflict` and preserve the original result.
- Checkout operation identity already includes `operationId`, binding, basket
  contents, and stable `siteId`. A different site cannot recover or mutate an
  already-owned hold.
- This adjudication does not introduce site-namespaced command IDs and does
  not authorize reuse of a foreign operation.

## Required repair

Validate the stored release digest against the current site-bound digest before
honoring the fence or writing any reserve result. A mismatch must return a
non-persisted `command_id_conflict` and leave the original release, any original
reserve, stock, and holds unchanged. The owning same-digest reserve after
release remains durably `checkout_released`.

Assigned formal review of the repaired source is separate and is not recorded
here.
