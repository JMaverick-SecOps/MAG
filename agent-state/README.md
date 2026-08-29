# MAG agent state

This directory is MAG's durable, auditable memory layer. It improves future runs by preserving verified lessons and capability evidence, not by rewriting the model or granting itself new authority.

## Read order for every autonomous cycle

1. `identity.md`
2. `objective.md`
3. `durable/capability-ledger.md`
4. `durable/failure-modes.md`
5. The three most recent `ops/*loop*.md` or other relevant operations records
6. Any item in `pending-approval/`

The existing `ops/` directory is the append-only episodic log. Every cycle must add one evidence-backed learning record or explicitly record `no_new_signal`. Never overwrite an earlier receipt or retroactively upgrade an unknown outcome to success.

## Improvement protocol

Each cycle follows: observe → hypothesize → choose one bounded action → verify → record → update durable memory only when evidence generalizes. An `improved` capability claim requires a reproducible passing check or independent public/provider receipt. Failed experiments are useful evidence and belong in the log.

Autonomous actions are limited to research, rescoring, reproducible tests, test additions, documentation, bounded nonfinancial patches, delivery monitoring and no-new-signal recording. Financial actions, public messages, outreach and irreversible changes stop as drafts in `pending-approval/` until the owner explicitly approves execution.

Once per week, compare the stated objective with the last seven days of actions, note repeated work or resource drift, and propose a bounded correction. The automation can be paused from the Codex Automations UI.
