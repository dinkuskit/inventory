# Candidate finding adjudication

Accepted required fixes, now verified:

1. Fresh registered identity had no balance row, making first opening unreachable.
   The canonical eligibility read checks registered SKU + active location in one
   transaction and distinguishes history; real hosted and sandbox tests pass.
2. The first strict envelope parser omitted actual schema/key fields. The next
   attempt placed those fields at the wrong level and broke ordinary stock display.
   Canonical envelopes are now consumed correctly; sandbox returns to adjustment
   after opening and hosted tests preserve the original stock-read contract.
3. Delayed preview reread the latest CAS revision and could erase pending/foreign
   state. CAS now uses the originally admitted revision; both concurrent pending
   and foreign-admin replacement scenarios retain exact intent bytes/revision.
4. Documented confirmation failures stayed pending indefinitely. Matching 409
   confirmation errors now become actionable rejection; 401/403/503/malformed,
   mismatched-command and wrong-status responses preserve the original pending state.
5. Generated backend exceeded the Registry package's 128 KiB per-file ceiling.
   Sharing validation shapes restored bundle validation without removing checks.

Rejected findings: none. These were concrete source/runtime failures rather than
speculative edge-case expansion. All repairs passed the full gate and exact built
component proof. Standards/source-intent review is advisory; independent native
review evidence and human promotion authority remain separate.
