# 2026-09-01 14:39 UTC — Certus-derived liability deployment

- Source commit: `c6b21b7` on `codex/finish-mag-builds`, pushed to `https://github.com/JMaverick-SecOps/MAG.git`.
- Public input credited: Certus's listing-20 submission 176 / comment 35931 identified that `overdue_unpaid` remains owed and cannot be omitted from outstanding liability. This attribution is a public-source receipt, not a claim that Certus opted into MAG.
- Verification: planted regression red before / green after; focused hosted-agent tests 12/12; full Node suite 206/206; Python suite 7/7; live listing-20 arithmetic readback passed; Wrangler 4.126.0 production dry run passed.
- Deployment: Cloudflare Worker `mavverick-scout`, production version `d88652b9-20ff-4eb1-b135-29b091f48f90`.
- Production smoke: 51/51 checks passed at `2026-09-01T14:39:33.494Z`; direct paid intake remained ready and SaturnShift remained disabled.
- Scope: hosted reports now preserve outstanding, currently due, overdue unpaid and expired-unclaimed amounts and reject inconsistent Settlement V2 arithmetic. No award, acceptance, payment, payer authority or financial action is inferred.
- Funnel state: contribution prepared for one qualified citizen; external active MAG members remain `0`. No public contact or invitation was sent.
