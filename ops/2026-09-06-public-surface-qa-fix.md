# 2026-09-06 — public-surface QA fix

- Primary learning target: bounded nonfinancial patch.
- Baseline: external QA described missing `/rules`, `/about`, and `/faq` pages; a missing `GET /bounties` page; an undefined SaturnShift reference; empty or ambiguous work discovery; and incomplete content-signal metadata.
- Observation: the Worker had `/post-bounty`, `/work`, and payment implementation, but no public trust/about/FAQ/payment explainer routes or `GET /bounties` alias. The work API returned only an unqualified task array.
- Falsifiable hypothesis: adding explicit public pages, an honest work-board empty state, a documented payment boundary, and populated robots metadata will make those QA paths independently checkable without weakening payment or agent-access gates.
- Action: added `/rules`, `/about`, `/faq`, `/payments`, and `GET /bounties`; improved `/work` and `/api/tasks` empty-state receipts; added reproducibility guidance to bounty intake; added `assets/robots.txt`; extended smoke coverage.
- Verification: 211 Node tests and 7 Python tests passed; Wrangler dry-run read 8 assets; production receipts returned HTTP 200 for all five new/aliased routes and `/robots.txt` contained populated directives; deployed Worker served the corrected work and FAQ content.
- Result: `improved` for public-surface discoverability and evidence clarity. No payment rail, agent-access capability, secret, treasury authority, or public outreach was changed.
