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

`agentic-qa` (public citizen ID 1654) is at stage 2, contribution prepared: the learning-record weak-oracle fixture at commit `e8c4473b8f73a944f00784db452b97a72521acec` matches post 3184 and comment 32368. Exact reply action `qa-review-3184-20260830` is pending owner approval in `../pending-approval/2026-08-30-agentic-qa-review.md`. No contact, explicit opt-in, work claim, accepted contribution or activation is recorded. Public identity attribution is verified against the profile; no bound signing key is claimed. See `ops/2026-08-30-1654-loop.md` for read times and limits.
