# Service activation and provider handoff

Checked 2026-08-28T04:19:32.636Z. This records tested capability and remaining gates, not revenue or acceptance.

## SaturnShift

The public checkout key is connected. MAG-specific server API access and the webhook signing secret have not been issued to this deployment. A request was submitted through the authenticated merchant support page; the UI confirmed **Report received**, but supplied no ticket number. It requests a MAG-specific client/credential, minimal checkout/read/webhook permissions, secure signing-secret delivery, endpoint registration and signed fixtures. It requests no spending scope, payout change or plan upgrade.

Webhook endpoint: https://mavverick-scout.magai.workers.dev/api/webhooks/saturnshift

The provider's current [webhook documentation](https://docs.saturnshift.io/webhooks) specifies a combined `SaturnShift-Signature: t=...,v1=...` header, HMAC over the timestamp, a dot and raw body, a transaction payload and final `payment.paid` settlement event. MAG implements that published contract with exact-byte verification, a 64 KiB body limit, a five-minute timestamp window, event/payment replay claims and exact server-side amount matching. `payment.succeeded` is not treated as final settlement. Crypto activation additionally requires `asset=USDC` and settlement network `BASE`. A valid `webhook.test` never writes an order, invoice, task or entitlement.

The [provider client source](https://plugins.svn.wordpress.org/saturnshift-for-woocommerce/trunk/includes/class-saturnshift-client.php) exposes OAuth/PKCE and authenticated webhook registration. MAG must have its own registration, not reuse the WooCommerce client identity.

When access is issued:

1. Sign in to the SaturnShift Developers page, register `https://mavverick-scout.magai.workers.dev/api/webhooks/saturnshift`, subscribe at least to `payment.paid`, and securely deliver the endpoint secret into the Worker's `SATURNSHIFT_WEBHOOK_SECRET` binding. Never put it in chat, Git, query strings or logs.
2. Set `SATURNSHIFT_WEBHOOK_ENDPOINT_STATUS=registered` only after the dashboard shows the exact MAG endpoint. Keep `SATURNSHIFT_FIAT_WEBHOOK_STATUS` unconfirmed until provider documentation or signed fixtures establish card/ACH status, amount, return and refund fields.
3. Send a signed test event and retain a sanitized delivery receipt. Validate bad HMAC, stale timestamp, altered body and duplicate delivery failures.
4. Run an explicitly owner-approved minimum-value payment end-to-end. Confirm the signed `payment.paid` event and dashboard/REST reconciliation before treating the checkout as production-ready. A browser redirect is not payment proof.

The [published payment overview](https://www.saturnshift.io/accept-cards-ach-and-crypto/) separates card/ACH bank payouts from crypto settlement. Do not promise automatic card/ACH-to-USDC conversion. USDC reserve allocation still needs explicit owner approval.

## Selectable services and tenant signup

- All four Security Evidence Lab cards select their matching package, fixed price, repository scope and acceptance form. Architecture Threat Model is now in the catalog. Every specialized security package rejects generic-order bypasses.
- Security intake remains uncharged until an isolated reviewer/scanner is actually available. Selecting a package does not certify delivery capacity.
- RMM product navigation exposes the fictional demo, authenticated console, ScreenConnect setup and subscription signup. Each advertised plan preselects its own plan; the server remains authoritative for pricing and entitlement.
- Signup immediately activates a logically separate tenant for a 30-day free trial without a payment method. Verified payment extends access after the trial. Branding, tickets and evidence remain tenant-scoped. This is not dedicated infrastructure.
- SaturnShift is MAG's merchant payment rail, not a required tenant checkout provider. QuickBooks, Xero and NetSuite are separate provider-neutral PSA accounting connectors; none is represented as active until its tenant-scoped OAuth/integration-role flow and reconciliation tests exist.
- ScreenConnect has a read-only inventory adapter requiring a separately licensed instance, scoped configuration and live validation. M365/Intune and Google Workspace integrations are explicitly planned, not available or connected. Remote control and automatic remediation remain disabled.

Product information architecture was informed by the [ConnectWise platform](https://www.connectwise.com/platform) and [N-central feature overview](https://www.n-able.com/products/n-central-rmm/features-summary): demonstrate the workflow, clarify service/endpoint operations, expose integrations and make onboarding obvious. No feature parity, certification, endorsement or shared implementation is claimed.

## Community learning record

[1F916 discussion #2776](https://1f916.ai/api/post/2776) distinguishes check count from independent failure domains. `test/payment-witnesses.test.js` adds positive controls, either-observer faults, conflicting block observations, unavailable-observer failures and a jointly fabricated observation case. Run `node --test test/payment-witnesses.test.js`.

The passing fabricated case documents the verifier's upstream trust boundary. It is NOT a real transfer, a proof that RPC providers are independent, accepted work or spendable income. No production financial verification policy was weakened.

The live scan found 12 listings. Funding snapshots are not escrow. Registry-defect work (#6) is inspectable but already has 32 submissions; novelty must be established before selecting it. Small hook-regression listings (#9–12, #14–18) require isolated code review/execution and distinct acceptance evidence. The session donation (#13) is not an earning task, and the large lottery (#19) had no verified funding snapshot. None was submitted or claimed complete in this pass.

Current regression result before release: **153 JavaScript tests and 7 migration-mail tests passed**. Deployment and community-publication receipts must be recorded separately; test success alone does not establish either outcome.

## Release receipts

- Code commit: `299c1268f8cd75e22f31e40bb418dbb04a291c82`, pushed to `codex/finish-mag-builds` (not merged into the default branch).
- [GitHub CI](https://github.com/JMaverick-SecOps/MAG/actions/runs/33141548799): completed successfully.
- Cloudflare deployment: `795412ef-950a-484b-aa1e-9bd90a62468e`.
- Production smoke: **47 checks passed**, observed 2026-08-28T04:21:58Z. Direct USDC intake remains configured; SaturnShift financial processing remains disabled.
- Browser check: live product navigation, sample-only labels, plan selection and integration availability rendered correctly.
- Community reply: `verification-witnesses-2776-299c126` was inserted once into the existing conversation queue. The readback remained `queued`, with no public comment receipt yet. The queued text and pinned test artifact are preserved in `ops/verification-witnesses-2776.sql`. No extra recruitment campaign was started.
- No live customer purchase, wallet transaction, migration, remote-device action, bounty acceptance or payout was performed.

### 30-day trial and merchant-checkout release — August 29, 2026

- Deployed code commit: `8106acc` on `codex/finish-mag-builds`.
- Cloudflare Worker version: `62aad6fa-f208-41ad-ad98-2d858d6d2e5f`.
- Verification: **153 JavaScript tests and 7 Python migration-mail tests passed**; Wrangler production build dry-run passed.
- Production smoke: **47 checks passed** at `2026-08-29T02:08:12.043Z`; paid intake is ready and the public key is configured.
- Live readback confirms `trial_days=30`, `tenant_payment_provider_required=false`, and the preselected RMM/PSA form displays the 30-day trial.
- SaturnShift financial activation remains fail-closed: `configured=false` because the signed endpoint has not been registered and its secret has not been stored. No live hosted payment or entitlement change is claimed.
- Authenticated SaturnShift dashboard verification: the Developers page exposes the matching live public key and checkout toggles for crypto, card and bank payments. The Developers and Integrations pages do not expose webhook endpoint registration or a signing-secret control; provider support must register `https://mavverick-scout.magai.workers.dev/api/webhooks/saturnshift` or expose the account-specific control before MAG can safely enable fulfillment.
