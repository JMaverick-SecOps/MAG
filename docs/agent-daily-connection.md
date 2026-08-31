# Agent daily connection: runtime repaired, payment capacity blocked

## Current checkpoint — 2026-08-31 19:35 UTC

Worker `af110acf-4be8-432e-b497-74f2ef17becd` includes shared, durable two-witness RPC recovery and separate Alchemy development reads for Base, Ethereum and Robinhood. Source `250fff5e1a0c362904a2b3c71ed90e2c936c4933` is pushed; 204 Node tests, 7 Python tests and 53 production smoke checks passed. Alchemy and free OnFinality apps exist, but their rotated credentials still require the hidden local handoff in `scripts/configure-rpc-secrets.ps1`; authenticated production diagnostics report `alchemy_credential_missing`. Both agent-day activation flags remain false. There is no pending Git/database approval. See [release evidence](../ops/2026-08-31-1935-alchemy-chain-infrastructure.md).

## Previous checkpoint — 2026-08-31 18:26 UTC

Runtime repair is deployed as Worker version `b5ae7def-95f3-4908-9a78-3d09d2df089f` (100% traffic), source `7453367a843b47e86c90dcbfa732f980101df455`. Both paid-agent flags remain false. There is no outstanding Git, database or deployment approval.

An actual Cloudflare canary found that this runtime rejects `redirect: "error"` before network I/O. The scan, identity-key lookup and payment-witness requests now use `manual` and still reject non-OK/redirect responses. Four added regression tests failed before this patch and pass afterward; the full suite passed 190 Node and 7 Python tests, plus 50 production smoke checks.

The scheduled isolated-cloud test completed signed synthetic accounting, a live scan of 11 listings / 14 source documents, signed artifact retrieval, hash verification, replay rejection, forged-signature rejection and exactly one payment event plus one delivery event. [Read-only receipt](https://mag-agent-day-canary-20260831.magai.workers.dev); independent verifier: `node scripts/verify-agent-canary.mjs`. Its settlement and identity are explicitly synthetic, no production invoice was created, and notification-provider delivery was not tested. The canary cron is retired; retained evidence cannot execute new work.

The remaining activation blocker is live RPC capacity from Cloudflare: Base's shared public endpoint returned HTTP 429; dRPC's public endpoint also returned 429; 1RPC returned HTTP 200 with JSON-RPC usage-limit error -32001. PublicNode responded with the correct chain ID, but one witness is insufficient. The failed replacement was not adopted. Do not retry unchanged limits, rotate identities to evade quotas, or enable intake using only the healthy witness.

Next proof requires an authorized Base RPC service with adequate capacity, two valid read-only chain/finality/receipt observations from the actual Worker, and a verified configuration rollout. Account-specific credentials must use a secure secret path, never chat or committed source. No real charge is authorized as a test. Paid activation remains `no_change` despite the verified hosted-execution improvement.

The generic `paid_intake_ready` field is a configuration indicator, not live witness health or settlement evidence; other direct-USDC paths may share the same unavailable public witness. SaturnShift remains a separate unverified merchant webhook integration.

## Earlier guarded release (retained context)

Deployed on 2026-08-31 at 03:39 UTC as Worker version `13b281b6-408a-4886-9c75-c5ed4dbb07eb` (100% traffic). Production migrations 0026 and 0027 are applied. The public manifest is live; both new activation flags are explicitly false. This release does not establish a real payment or hosted production run. See `../ops/2026-08-31-0339-production-release.md` for the receipt and verification boundaries.

## Implemented path

An already approved MAG citizen signs an invoice request with an active public 1F916 Ed25519 key. MAG constructs an immutable invoice for exactly 1,000,000 native USDC atomic units on Base, one prepaid 24-hour period. The user or agent's wallet approves a normal transfer, never a token allowance. MAG does not hold the citizen private key or debit the wallet.

The caller submits the resulting hash in a second signed request. Scheduled processing requires two configured Base RPC witnesses to agree on chain 8453, a finalized successful transfer, exact native USDC asset, recipient, amount and invoice-specific calldata. Receipt claim, credited period and payment notification are one atomic D1 batch. Replays and cross-purpose hash reuse cannot credit twice.

After verification, the scheduled work-watch runner reads the current 1F916 guide and security guide, then the entire bounded live listing population and each condition. It emits a hashed, source-linked JSON research artifact. The signed status response returns the latest three runs, including failures. Retries use leases and unique citizen/time-slot identities. One delivery event per paid invoice is separate from the payment event and never counts as citizen activation.

This is a deterministic read-only research recipe, not a general-purpose AI agent. It does not execute repository code, accept arbitrary URLs, post publicly, claim bounties, perform customer migrations, or sign/spend. A fee is not a grant of those permissions. Existing paid service orders still go to the marketplace; this recipe does not fulfill all services.

## API

- GET /api/agent-connections: public manifest, honest enablement and scope.
- POST /api/agent-connections/signing-payload: JSON action (invoice, receipt or status), handle, invoice_id (client UUID), and tx_hash only for receipt. Returns server time, terms and exact message.
- Sign the returned preimage locally with the active citizen Ed25519 key.
- POST /api/agent-connections: return the exact signed fields and base64url signature. Never send a private key or citizen bearer secret.
- Retry the same invoice ID after an uncertain response. Once a receipt is pending, payment instructions are withheld to discourage double payment.
- Status includes connection eligibility separately from hosted_runs. connected does not mean a worker is currently running; examine the actual run status and artifact.

## Deployment gates

1. Completed for the guarded release: the owner's "then make it production" instruction authorized this scoped deployment. Fresh Cloudflare authentication and production D1 reads succeeded. The historical access error is not an outstanding approval requirement.
2. Completed: the reviewed schema was applied to isolated local D1, then exactly migrations 0026 and 0027 were applied to production. Unreviewed 0025_cloud_integrations.sql was excluded. Do not indiscriminately apply that draft later.
3. Completed for disabled rollout: 186 Node tests, 7 Python tests, actual Worker bundle build, local Workers HTTP checks and 50 production smoke checks passed. Signed API integration tests use synthetic keys and simulated payment witnesses; they are not provider or hosted-production receipts.
4. Use a provider sandbox or explicitly approved non-monetary test mechanism to observe an actual hosted run and retrieve/hash its artifact. Never invent a paid production invoice or activate a synthetic citizen to obtain this receipt.
5. Only after that evidence, enable MAG_AGENT_CONNECTIONS_ENABLED and MAG_HOSTED_WORK_WATCH_ENABLED in reviewed configuration and deploy. Both are explicitly false in this release, so no new charge path is enabled. Preserve existing environment and secret values.
6. Check the deployed manifest, scheduled run/lease/failure records, artifact retrieval, and notification delivery status. A cron configuration or passing local fixture is not this evidence.
7. Verify the first legitimate incoming payment independently; record its public receipt and actual resulting hosted deliverable. Do not initiate a real charge as a test.

The recipe reads up to 40 listings, with four concurrent detail reads and a 128 KiB maximum per response. Larger/partial populations fail explicitly rather than reporting a complete scan. Five eligible identities per cron are served oldest-first, sharing one scan. This bounded capacity is not a general compute SLA. Keep paid intake disabled if capacity or source health cannot satisfy the offer.

## SaturnShift

Direct Base verification does not replace the user's requested SaturnShift merchant checkout. The authenticated developer page currently shows the public widget and redirects, not a server-side payment-proof control. Keep SaturnShift settlement disabled until the final event contract, registered MAG webhook and provider-generated signed test are independently verified. The signing secret must go through Wrangler's hidden prompt; never paste it into chat, source, logs or visible browser fields. No real payment has been made for these tests.

## Validation boundary

The end-to-end test uses synthetic Ed25519 keys, in-memory SQLite and simulated finalized RPC responses, then executes the report runner and retrieves the artifact over the route handler. A separate live public-source check tested the actual listing schema. The guarded release also passed local Workers runtime checks and production HTTP readback. Production readback found zero connection invoices, zero hosted runs and zero notification events. None of this is a live settlement, delivered notification or hosted production execution receipt.
