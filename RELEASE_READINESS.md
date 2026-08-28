# MAG release candidate — 2026-08-27

This is a tested release candidate, not a claim that every service is operational.
No wallet was signed, no funds were moved, and no provider payment was fabricated.

## Implemented and locally verified

- Clickable service cards prefill the scoped invoice form. Customers retain a private order token, can submit an exact Base-USDC receipt, and can view progress and a delivery artifact. The token never appears in a URL or on the page that loads the SaturnShift script.
- Independently verified direct payment publishes one funded task. Active agents use domain-separated Ed25519 claims and submissions. Operator acceptance atomically creates an acceptance receipt, one payout proposal, and one deduplicated notification event. Payout remains owner-signature-only.
- Custom funded bounties follow the same acceptance/evidence boundary. An unlinked or unfunded task cannot manufacture a payout proposal.
- White-label operations demo at `/ops`; live tenant console at `/ops/console`. Authorized tenants can create/update service-desk tickets and branding. Ticket versions prevent stale updates and the audit trail is append-only.
- ScreenConnect integration at `/ops/screenconnect`: read-only Access-session inventory and health. The operator must pin each tenant's origin, exact filter, transport, and credential reference. No remote command, session launch, file-transfer, or remediation endpoint is exposed.
- Migration control plane: $18 USDC per license and 500 GiB pooled capacity per license; provider selection, authorization, vault references, mappings, payment preflight, Workflow continuation, checkpoints and bounded result validation. Every retry rechecks authorization; cutover is gated before external calls; source deletion is forbidden.
- Light/dark logos, app icon and favicon are included in `assets/`; each uploaded branding asset is under 2 MB.
- The historical conversation draft in migration 0014 is cancelled on fresh installation, so applying a schema migration does not publish an old comment.
- Paid order/bounty creation and hosted checkout fail closed if owner review authentication, D1, or the treasury configuration is missing. The public catalog displays this hold instead of implying that billing is ready.

## Not ready for sale or autonomous execution

### Migration data movers

The private `MIGRATION_CONNECTOR` worker does not yet exist in this repository. Microsoft Graph, Gmail/Drive, IMAP and Dropbox data-moving adapters, per-customer OAuth/vault provisioning, resumable large-file transfer, destination reconciliation reports and real cross-provider acceptance tests remain to be implemented. A configured binding alone is not proof of capacity or correctness. Payment remains unavailable until preflight. This is not yet a MigrationWiz replacement.

### RMM / PSA

The service desk and evidence plane work locally. Native endpoint installers, remote-control sessions, patch deployment, script execution, automatic remediation, contracts/billing/time-entry workflows and end-to-end ScreenConnect tenant tests are not complete. The current integration is deliberately read-only. Custom domain branding saves a setting but does not configure DNS or TLS routing.

### SaturnShift

`POST /api/webhooks/saturnshift` is implemented as a disabled provisional adapter. Its HMAC scheme and payload contract are test fixtures, NOT verified SaturnShift specifications. Do not mark `SATURNSHIFT_WEBHOOK_ADAPTER_STATUS=provider_docs_confirmed` until the real contract has been obtained and the adapter matches it.

The signed-in merchant Developers page was inspected: checkout snippets are present, but the public key is empty. The Developers, Integrations and Settings pages expose no webhook registration control. Provider support is needed for provisioning and authoritative documentation.

After explicit owner approval, a Technical Issue was submitted through the merchant Support page requesting public-key provisioning, webhook registration/signing/event-schema documentation, settlement evidence and non-monetary signed test delivery. The page confirmed **Report received**; no ticket identifier was displayed. The request included only the planned MAG callback URL and technical requirements, instructed support not to route production events yet, and requested no payment-setting changes or fund transfers. No webhook is registered or enabled on the strength of this support receipt; provider follow-up is still required.

Required evidence before enablement:

1. Exact signature/header/timestamp format and sample raw signed deliveries from SaturnShift.
2. Documented event IDs, retry rules, test/live separation, merchant binding, amount units, payment state and settlement-finality semantics.
3. Authoritative Base-USDC settlement evidence tied to the order, including gross amount, fees/net settlement and recipient. A success event or browser return is not automatically sufficient.
4. Successful sandbox delivery, rejection of bad signatures, replay deduplication and full order-to-delivery acceptance test.
5. Secure Cloudflare secret configuration and provider-side endpoint registration.

SaturnShift's merchant settings state that card/ACH payout schedules are managed through Stripe. The saved Base wallet covers crypto settlements only. Card/ACH acceptance must not promise automatic USDC settlement. The code holds fiat events for explicit USDC reserve coverage; that reserve-allocation workflow is not implemented and must not be enabled implicitly.

### Agent execution, notifications and community

The inspected production version has no `SCOUT_ADMIN_TOKEN` binding. This blocks paid intake and operator acceptance; configure owner review authentication securely before enabling purchases. No administrator credential is generated or published by this release. Email delivery also lacks a configured sending provider; receipt-backed delivery is not claimed.

Publishing a task does not guarantee that an external agent claims or performs it. General-purpose task execution, customer-specific credentials and independent acceptance checks require real worker capacity. Notification events are deduplicated, but SMS/email delivery requires configured providers and delivery receipts; queuing is not proof of delivery. External 1F916 bounties are not completed merely because local MAG tests pass. No new bounty, revenue, sponsor, citizen or formal affiliation is claimed by this release.

## Validation and release procedure

Use Node 24, `npm ci`, then `npm run check`. The current suite passes 90 tests, including SQLite-backed payment, acceptance, tenant-isolation, stale-validation, paid-intake-readiness and replay tests. A synthetic signed provider event now also passes the complete claim, delivery and acceptance lifecycle without inventing a blockchain transaction hash. These fixtures are not live-provider acceptance tests.

Run `npx wrangler deploy --dry-run` from an isolated build directory if OneDrive prevents Wrangler from creating temporary files. Preserve the existing dependency lockfile. Never copy `.dev.vars`, credentials or a production database export into Git.

The inspected production database has migrations 0011–0020 pending. Back up the exact database, review migration effects and obtain explicit production schema/payment-release authorization before applying them. Do not deploy this Worker against an older schema. Existing CI runs tests and builds; schema migration is a separate release operation, not an unattended CI side effect.

After authorized release, preserve deployed vars (`--keep-vars`), verify `/health`, `/hire`, `/ops`, `/ops/console`, `/ops/screenconnect`, `/orders/status` and all branding assets. Confirm unconfigured payment adapters still refuse requests. Real provider tests must use separate test orders and must not fabricate revenue or completion records.

## Official integration references

- [Cloudflare Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Cloudflare Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [SaturnShift merchant developer page](https://app.saturnshift.io/admin/settings/developers) (requires merchant login)
- [SaturnShift payment and settlement overview](https://www.saturnshift.io/accept-cards-ach-and-crypto/)
