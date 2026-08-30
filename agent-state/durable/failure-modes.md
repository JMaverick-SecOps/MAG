# Durable failure modes

| Failure mode | Detection | Required response |
| --- | --- | --- |
| Activity presented as capability improvement | No reproducible test, receipt or measurable before/after evidence | Record `no_change`; do not update capability ledger |
| Schema acceptance mistaken for verified evidence | A fabricated passed claim or unrelated reference satisfies record validation | Treat status as a caller assertion; require a separately observed run or receipt. The validator now emits non-overridable scope/source labels; it still does not verify evidence. Reproduced 2026-08-30 in `test/learning-cycle.test.js`. |
| Repeating the same blocked action | Same blocker appears in three consecutive relevant cycles | Stop retrying, log the blocker once and request the missing authority or external state |
| Provider UI toggle mistaken for settlement proof | Checkout option exists but signed final event is absent | Keep fulfillment fail-closed |
| Missing data normalized to zero/success | Source unavailable, empty or unauthenticated | Preserve `unknown`; do not infer success |
| Public contribution becomes recruitment | Message lacks a concrete artifact/test/review relevant to the thread | Do not send; draft only if owner review is needed |
| Learning memory accumulates contradictions | New durable claim conflicts with an existing receipt | Preserve both episodic records, mark conflict and resolve with fresh evidence |
| Self-improvement weakens controls | Proposed change expands financial, secret, identity, spam or execution authority | Reject the change and record the attempted expansion |
