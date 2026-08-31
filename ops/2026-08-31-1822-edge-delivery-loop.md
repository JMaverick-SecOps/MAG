# Edge runtime repair and QA contribution — 2026-08-31

## Outcome and scope

Primary learning target: `reproduce_test`. Runtime/hosted-delivery capability improved; live paid activation remains `no_change`. The objective, financial/identity controls, 1F916 campaign cap and public-speaking boundary were not rewritten. The owner explicitly requested this QA follow-up and the scoped production repair; no redundant Git/database approval was requested.

Compared the prior three relevant records: 03:39 guarded release, 00:00 monitoring, and Aug 30 23:39 monitoring. Their historical access hold is superseded. Their absence of a real hosted-run receipt was a concrete test gap, not a reason to keep repeating status checks.

## Baseline, hypothesis and result

Baseline: 186 Node tests passed while the edge runtime rejected `redirect:"error"` before network I/O. Hypothesis: `manual` plus explicit non-OK rejection will work on the deployed runtime without following redirects; planted redirects and forged identities must still fail.

Four new redirect regressions failed before the fix and passed after it. The final reviewed candidate passed **190 Node + 7 Python** tests and a real Worker bundle dry-run. Source/key/payment-witness fetches were repaired. A dRPC substitution was tried, failed cloud preflight, and was reverted before production adoption; Git preserves that rejected experiment.

Cloud canary version `c3e475dc-91bc-4bbb-acfc-7bbe76142ffb`, source `7453367a843b47e86c90dcbfa732f980101df455`, completed at **18:22:15.826Z**:
- Signed synthetic invoice and receipt; wrong amount refused; credit/replay checks passed.
- Actual hosted scan of 11 live listings and 14 source documents, using current guide/security version 2026-08-17.1.
- Signed status returned the actual hashed artifact; independent readback at 18:25:56Z verified SHA-256 `f8a976d7ed1d1d8dacf1a5bf9ad977ac0cab76465ac96f6cfcf41707ffe8ffde`.
- Exactly one synthetic payment event and one delivery event for that invoice.
- No actual payment, real external citizen, production invoice, treasury action or notification-provider delivery was tested.

The receipt's `verification_scope` names this boundary, `real_payment=false`, and `production_enablement_ready=false`. Its artifact and full listing triage are archived in the sibling JSON. Posting funds snapshots remain **unverified current funds**, not reserves. Novelty/time/safety remain unknown where not independently established. Keep the prior exclusion of support/engagement listing 13 and lottery/treasury listing 19; no bounty submission or earning is claimed.

The canary is now a read-only receipt service: version `e68979c2-e286-4e38-b47e-47a20bfa6c8c`, no cron and no mutation endpoint. Failed canary records were retained; known old synthetic fixtures were suspended in the isolated database, not deleted or counted as citizens.

## Production release

- Worker: mavverick-scout.
- Version: `b5ae7def-95f3-4908-9a78-3d09d2df089f`.
- Deployment: `53504045-0bd5-4d37-8517-7de4973637a8`, 100%, created **18:22:46.57338Z**.
- Source: `7453367a843b47e86c90dcbfa732f980101df455`.
- `--keep-vars`; no secret export or replacement. Both new paid-agent switches remain false.
- **50 production smoke checks** passed at **18:26:00.076Z**. QA proposal asset separately returned 200 with its unfunded disclosure.
- Production readback: task 1 is draft, reward 3000000 atomic USDC; zero agent-connection invoices, zero hosted runs, zero notification events, zero duplicate event keys.
- Initial diagnostic query used a nonexistent `fee_atomic` column and failed; corrected known-column readback succeeded. This was a schema-query mistake, not an access/approval failure.
- Unreviewed migration 0025 and cloud-provider/crypto drafts remain excluded and preserved. No extra production schema changes in this pass.

## Actual payment blocker (not approval)

From the actual Cloudflare edge:
- `https://mainnet.base.org`: HTTP 429.
- `https://base.drpc.org`: HTTP 429.
- `https://public.1rpc.io/base`: HTTP 200, JSON-RPC -32001, usage limit.
- `https://base-rpc.publicnode.com`: HTTP 200, correct chain ID 0x2105.

Do not turn one healthy witness into two, follow redirects, bypass quotas, initiate a real charge as a test or promise settlement. Need an authorized endpoint with adequate capacity and two successful live chain/finality/receipt witnesses. Generic `paid_intake_ready=true` proves configuration only; legacy direct-USDC paths share a potentially unavailable witness.

Provider references: [Base warns its shared RPC is rate-limited and not for production](https://docs.base.org/base-chain/quickstart/connecting-to-base), [dRPC endpoint](https://drpc.org/chainlist/base-mainnet-rpc), [1RPC public endpoint documentation](https://docs.1rpc.io/using-the-web3-api/networks). Observed quota errors, not these documents, caused the gate to stay closed. Do not keep retrying these unchanged failures each heartbeat.

## Verified community contribution

The owner-authorized follow-up was queued once under `qa-evidence-3184-20260831` through the existing capped/deduplicating publisher. Production queue and independent [public post 3184](https://1f916.ai/api/post/3184) readback agree on **comment 34329**, author mavverick-scout, created timestamp 1788200162132. It contributes the runtime counterexample and discusses exact-commit/test evidence binding, responding to agentic-qa and left-for-myself.

MAG task **1** was created at 03:57:11Z as a draft. The [public QA specification](https://mavverick-scout.magai.workers.dev/qa-evidence-bounty.html) clearly says funding is unverified and paid claims are closed: $3 gross / $0.45 fee / $2.55 worker net. No funding receipt, recipient, accepted contribution or allocation exists. No paid engagement or 1F916 affiliation claim was made.

Growth advanced from prepared contribution to relevant interaction, **not opt-in or activation**. At 18:29Z the public directory still listed only MAG-operated mavverick-scout: **0 verified external active members**. Do not send the superseded older invitation. Next step is a substantive reply or volunteered counterexample, not another pitch.

## SaturnShift and scan limits

No SaturnShift connector is available. The in-app browser now shows the sign-in form. Chrome listed a support tab, but attempting to inspect it timed out and reset the browser session; no fresh support/notification state was obtained from it. Browser recovery guidance was read. No login secret, signing secret, cookie or storage was accessed; no duplicate ticket or new credential was created. This is unknown support status, not a new provider refusal or evidence of signed-webhook readiness.

The live listing scan and target QA conversation were refreshed; a complete fresh leadership/docket/global-inbox sweep was not completed in this extended repair pass. Do not carry forward older leadership or inbox observations as current. SaturnShift and the first real incoming payment remain externally unverified.

## Weekly objective/quality check

The prior cycles repeatedly monitored holds while the relevant QA artifact stayed unpublished; activity did not advance citizen growth. This pass moved one qualified contribution to a public receipt and reproduced an actual runtime fault. Infrastructure work still dominated time, so the next community pass should prioritize a useful response to this specific contribution, without manufactured outreach.

Quality drift found: local green tests were an overly broad proxy for edge execution. Added the red-before/green-after regression and independent cloud-artifact check. Resource use: one isolated D1 database and one temporary canary Worker were created; the minute cron was retired after verification. No monetary test charge, treasury spend, package installation or external code execution occurred. The public providers' quota failures are a stop condition for repeated preflight attempts, not a prompt to seek progressively weaker proof.
