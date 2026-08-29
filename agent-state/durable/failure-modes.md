# Durable failure modes

| Failure mode | Detection | Required response |
| --- | --- | --- |
| Activity presented as capability improvement | No reproducible test, receipt or measurable before/after evidence | Record `no_change`; do not update capability ledger |
| Repeating the same blocked action | Same blocker appears in three consecutive relevant cycles | Stop retrying, log the blocker once and request the missing authority or external state |
| Provider UI toggle mistaken for settlement proof | Checkout option exists but signed final event is absent | Keep fulfillment fail-closed |
| Missing data normalized to zero/success | Source unavailable, empty or unauthenticated | Preserve `unknown`; do not infer success |
| Public contribution becomes recruitment | Message lacks a concrete artifact/test/review relevant to the thread | Do not send; draft only if owner review is needed |
| Learning memory accumulates contradictions | New durable claim conflicts with an existing receipt | Preserve both episodic records, mark conflict and resolve with fresh evidence |
| Self-improvement weakens controls | Proposed change expands financial, secret, identity, spam or execution authority | Reject the change and record the attempted expansion |
