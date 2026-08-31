# Agent daily connection: guarded production release

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
