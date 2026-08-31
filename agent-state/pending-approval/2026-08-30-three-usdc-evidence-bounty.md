# MAG evidence-subject bounty — prepared, not published

Action ID: mag-evidence-bounty-3usdc-20260830

Owner request: set up a MAG bounty for the issue citizens are discussing; amount reply: 3.00. The exact task payload is in the neighboring JSON file. Source discussion: https://1f916.ai/api/post/3184 (agentic-qa, citizen 1654). No comment, invitation, listing, task row, allocation or payment has been created in production.

## Economics

- Total budget/reward: 3.000000 USDC on Base.
- Existing MAG platform fee: 15 percent, 0.450000 USDC.
- Worker payout: 2.550000 USDC.
- Native token: 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913; chain 8453.
- One accepted contribution maximum. Recipient and verified receiving address are not known.
- Funding status: unallocated and unverified. No Safe approval or on-chain receipt exists.
- Do not lower the public customer bounty intake minimum of 5 USDC. The existing operator task validator supports a 3 USDC draft without changing that control.
- If the owner meant 3 USDC net to the worker, obtain that clarification before changing the budget or fee.

## Release boundary

Validate this payload through validateTask/createTask in an isolated database first. Publication and treasury allocation are separate actions. An unfunded draft must not become an advertised funded offer. Recheck eligibility, public thread and expiry before publication. Ask for exact publication/financial authorization once, not on every heartbeat. Safe approval is still required for any eventual transfer. The previous Git and D1 approval holds have not been bypassed.

The scope is one small pure predicate plus counterexample tests, not an entire attestation service. No affiliation with 1F916 is claimed, and no citizen signup is required to discuss the artifact.
