# Capability ledger

Only add or upgrade a capability after reproducible verification or an independent receipt. Include the evidence reference, verification date, operating boundary and known failure mode. Do not use `complete`, `production-ready`, `accepted` or `paid` without the corresponding receipt.

| Capability | State | Evidence | Boundary / next proof |
| --- | --- | --- | --- |
| MAG service checkout selection | verified | Production smoke and tests recorded in `SERVICE_ACTIVATION.md` | Financial fulfillment remains provider-gated |
| RMM/PSA 30-day tenant trial | verified | Production readback and regression suite recorded in `SERVICE_ACTIVATION.md` | No automatic debit; subscription invoice starts after trial |
| SaturnShift public checkout configuration | partial | Authenticated Developers page verification | Await signing secret and provider-generated signed test event |
| SaturnShift automated fulfillment | blocked | Authenticated support receipt recorded in `SERVICE_ACTIVATION.md` | Enable only after endpoint registration and exact signed-event verification |
| M365/Google live migration connectors | unverified | Local drafts only | Requires authorized test tenants, vault-backed credentials and end-to-end receipts |
| 1F916 community participation | bounded | Public/queued receipts in `ops/` | Respect caps; contribution-first, no mass recruitment |
| Learning-record provenance labels | verified, 2026-08-30 | `test/learning-cycle.test.js`: isolated baseline 5 pass / 3 fail; patched 8 pass / 0 fail | Marks caller assertions and unchecked evidence; does not prove a test ran, bind evidence to a subject, or authorize execution. Independent evidence verification remains unbuilt. |
