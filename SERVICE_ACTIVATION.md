# Service activation and provider handoff

Checked 2026-08-28T04:19:32.636Z. This records tested capability and remaining gates, not revenue or acceptance.

## SaturnShift

The public checkout key is connected. MAG-specific server API access and the webhook signing secret have not been issued to this deployment. A request was submitted through the authenticated merchant support page; the UI confirmed **Report received**, but supplied no ticket number. It requests a MAG-specific client/credential, minimal checkout/read/webhook permissions, secure signing-secret delivery, endpoint registration and signed fixtures. It requests no spending scope, payout change or plan upgrade.

Webhook endpoint: https://mavverick-scout.magai.workers.dev/api/webhooks/saturnshift

The provider-maintained [WordPress webhook source](https://plugins.svn.wordpress.org/saturnshift-for-woocommerce/trunk/includes/class-saturnshift-webhook.php) documents a combined `SaturnShift-Signature: t=...,v1=...` header, HMAC over the timestamp, a dot and raw body, and a `webhook.test` event. MAG now supports that **test-only** handshake with exact-byte verification, a 64 KiB body limit and a five-minute timestamp window. A valid test never writes an order, payment, task or entitlement. Real events return a retryable 503 until the payment contract is confirmed. The existing provisional financial adapter has NOT been enabled.

The [provider client source](https://plugins.svn.wordpress.org/saturnshift-for-woocommerce/trunk/includes/class-saturnshift-client.php) exposes OAuth/PKCE and authenticated webhook registration. MAG must have its own registration, not reuse the WooCommerce client identity.

When access is issued:

1. Deliver the secret securely into the Worker's `SATURNSHIFT_WEBHOOK_SECRET` binding, never chat, Git, query strings or logs. Server API credentials must likewise stay server-side.
2. Confirm secret encoding, timestamp/retry semantics, signed merchant/order IDs, amount units, fees, payment method, partial refunds and ACH returns. A payment-success event is not automatically external settlement.
3. Have SaturnShift deliver a signed test event; retain a sanitized delivery receipt. Validate fixture failures and duplicate delivery before enabling any financial event adapter.
4. Run an explicitly owner-approved sandbox or live payment end-to-end. A redirect is not payment proof.

The [published payment overview](https://www.saturnshift.io/accept-cards-ach-and-crypto/) separates card/ACH bank payouts from crypto settlement. Do not promise automatic card/ACH-to-USDC conversion. USDC reserve allocation still needs explicit owner approval.

## Selectable services and tenant signup

- All four Security Evidence Lab cards select their matching package, fixed price, repository scope and acceptance form. Architecture Threat Model is now in the catalog. Every specialized security package rejects generic-order bypasses.
- Security intake remains uncharged until an isolated reviewer/scanner is actually available. Selecting a package does not certify delivery capacity.
- RMM product navigation exposes the fictional demo, authenticated console, ScreenConnect setup and subscription signup. Each advertised plan preselects its own plan; the server remains authoritative for pricing and entitlement.
- Verified subscription payment activates a logically separate tenant in shared infrastructure. Branding, tickets and evidence remain tenant-scoped. This is not dedicated infrastructure.
- ScreenConnect has a read-only inventory adapter requiring a separately licensed instance, scoped configuration and live validation. M365/Intune and Google Workspace integrations are explicitly planned, not available or connected. Remote control and automatic remediation remain disabled.

Product information architecture was informed by the [ConnectWise platform](https://www.connectwise.com/platform) and [N-central feature overview](https://www.n-able.com/products/n-central-rmm/features-summary): demonstrate the workflow, clarify service/endpoint operations, expose integrations and make onboarding obvious. No feature parity, certification, endorsement or shared implementation is claimed.

## Community learning record

[1F916 discussion #2776](https://1f916.ai/api/post/2776) distinguishes check count from independent failure domains. `test/payment-witnesses.test.js` adds positive controls, either-observer faults, conflicting block observations, unavailable-observer failures and a jointly fabricated observation case. Run `node --test test/payment-witnesses.test.js`.

The passing fabricated case documents the verifier's upstream trust boundary. It is NOT a real transfer, a proof that RPC providers are independent, accepted work or spendable income. No production financial verification policy was weakened.

The live scan found 12 listings. Funding snapshots are not escrow. Registry-defect work (#6) is inspectable but already has 32 submissions; novelty must be established before selecting it. Small hook-regression listings (#9–12, #14–18) require isolated code review/execution and distinct acceptance evidence. The session donation (#13) is not an earning task, and the large lottery (#19) had no verified funding snapshot. None was submitted or claimed complete in this pass.

Regression result before release: **135 JavaScript tests and 7 migration-mail tests passed**. Deployment and community-publication receipts must be recorded separately; test success alone does not establish either outcome.

## Release receipts

- Code commit: `299c1268f8cd75e22f31e40bb418dbb04a291c82`, pushed to `codex/finish-mag-builds` (not merged into the default branch).
- [GitHub CI](https://github.com/JMaverick-SecOps/MAG/actions/runs/33141548799): completed successfully.
- Cloudflare deployment: `795412ef-950a-484b-aa1e-9bd90a62468e`.
- Production smoke: **47 checks passed**, observed 2026-08-28T04:21:58Z. Direct USDC intake remains configured; SaturnShift financial processing remains disabled.
- Browser check: live product navigation, sample-only labels, plan selection and integration availability rendered correctly.
- Community reply: `verification-witnesses-2776-299c126` was inserted once into the existing conversation queue. The readback remained `queued`, with no public comment receipt yet. The queued text and pinned test artifact are preserved in `ops/verification-witnesses-2776.sql`. No extra recruitment campaign was started.
- No live customer purchase, wallet transaction, migration, remote-device action, bounty acceptance or payout was performed.
