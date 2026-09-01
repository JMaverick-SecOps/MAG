# Citizen-agent growth ledger

This ledger makes MAG's 1F916 growth objective measurable without turning community participation into spam.

## Activation funnel

1. **Qualified match** — a public citizen agent has current work that maps to a real MAG task.
2. **Contribution prepared** — MAG has a useful test, artifact, counterexample, review or scoped work opportunity for that specific work.
3. **Relevant interaction** — the contribution is shared in the existing relevant conversation or direct reply, subject to platform rules and approval controls.
4. **Explicit opt-in** — the agent clearly chooses to continue the work with MAG.
5. **Working** — a scoped task, acceptance condition and evidence path exist and the agent has begun or claimed it.
6. **Activated** — the agent produces a verifiable artifact or accepted contribution linked to the task.

Only stages 4–6 are conversions. Only stage 6 counts as an external active MAG member. Deduplicate by the agent's verified public identity; do not count multiple replies or tasks from the same agent as multiple members.

## Per-cycle priority

When a lawful relevant 1F916 interaction is available, prefer the next highest-value step for one qualified agent over generic posting. If no suitable match or useful contribution exists, record `no_new_signal`; do not manufacture outreach.

Track: qualified matches, contribution artifacts prepared, explicit opt-ins, working agents, activated external members, accepted outputs and drop-off reason. Every count requires a public or auditable receipt.

## Boundaries

- No mass outreach, repeated pitches, private-message campaigns, paid engagement or link-dropping.
- No implication that MAG is affiliated with or endorsed by 1F916.
- Respect platform caps and the existing spacing requirement for curated comments.
- Public recruitment or marketing drafts remain gated; useful work-specific interaction must still comply with the active platform and approval rules.
- Stop active introductions when two external active MAG members are verified; continue retention, useful replies and requested work collaboration.

## Current evidence checkpoint — 2026-08-30

External active members: **0 verified**, based on the public directory containing only the MAG-operated account. Unseen pending applications remain unknown.

`agentic-qa` (public citizen ID 1654) was at stage 2 at the August 30 checkpoint. See `ops/2026-08-30-1654-loop.md` for that earlier evidence.

## Current evidence checkpoint — 2026-08-31 18:30 UTC

`agentic-qa` is now at stage 3, relevant interaction. The owner explicitly requested engaging the QA conversation and announcing the scoped bounty. MAG comment **34329** on [post 3184](https://1f916.ai/api/post/3184) was published through the capped conversation queue and independently read back. It supplies a real edge-runtime counterexample, the learning-oracle limitation and a linked, explicitly unfunded $3-gross proposal. It is not the completed August 26 campaign. The earlier unsent invitation is superseded; do not post it as another pitch.

Production task 1 exists as a **draft**, not an open funded bounty. The public specification is at https://mavverick-scout.magai.workers.dev/qa-evidence-bounty.html. Economics: $3 gross / $0.45 fee / $2.55 worker net. No recipient, allocation, payment, accepted contribution or work claim is known.

External active members: **0 verified**. The fresh public directory still contains only MAG-operated `mavverick-scout`. No explicit opt-in or activation is inferred from this comment, and isolated canary identities are excluded. Next useful step: respond to a substantive direct reply or review a volunteered counterexample. Do not send repeated invitations merely because this post has no response.

## Current evidence checkpoint — 2026-09-01 14:10 UTC

`cassian` (public citizen ID 1597) is a qualified stage-2 match, contribution prepared. Their listing-20 submission 175 / comment 35923 identified that legacy "funder picks by paying" copy is false for Settlement V2 verifier and automatic decision modes. MAG reproduced the design mismatch in its own hosted scanner: the report preserved payout and funding fields but omitted the declared settlement version, decision mode and award cap, leaving downstream readers room to apply legacy payment semantics. A planted regression failed before the patch and passes after the scanner emits those fields and describes the receiving-wallet signature separately from listing-specific decision and payer requirements.

This is not an opt-in, claim, accepted MAG contribution or activation. No public reply or invitation was sent. The concrete patch and regression are the contribution-first artifact available for a future relevant interaction if separately authorized; external active members remain **0 verified**.
