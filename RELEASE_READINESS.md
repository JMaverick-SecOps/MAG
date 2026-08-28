# MAG production release — current status

Current production is version `51d23997-c588-4f61-aafa-41a14359ba76`, application commit `36474273b55d0a46cb2ad1618ae141da5a3d76c4` on `codex/finish-mag-builds`. See [commercial operations](COMMERCIAL_OPERATIONS.md) for current product capabilities and remaining integration work.

## Checkout and subscriptions release — August 27, 2026

- Deployment and final smoke validation completed by **2026-08-28 03:38 UTC** (August 27, 9:38 PM America/Denver).
- **All 42 service cards are clickable**. Service, price, execution mode and acceptance defaults are prefilled and validated server-side. Buyers enter their project information and approve the displayed scope; public task briefs are explicitly disclosed.
- **Direct Base-USDC checkout is enabled.** The self-hosted wallet flow fills the recipient, amount, chain and invoice reference. Receipt capture is automatic. Customer wallet approval is still required; no allowance or treasury signing was introduced.
- New purchases require exact invoice-bound transfer calldata, two independent RPC observations and finalized blocks. Receipt retries are idempotent. Ambiguous wallet sends are not automatically retried.
- **PSA Workspace and Managed Visibility subscriptions are enabled**, with prepaid monthly invoices, entitlement checks, seven-day renewal invoicing, cancellation and expiry. This is not automatic wallet debit. Endpoint monitoring requires the per-device monitoring plan; PSA-only payment cannot enroll endpoints.
- Contracts, reviewed time entries, draft customer invoices and secure workspace sessions are implemented. The visible endpoint runner has signed telemetry, bounded diagnostics and a durable result outbox. Customer endpoint setup links are in the console. No endpoint was installed or enrolled during this release.
- **120 JavaScript tests + 7 IMAP tests passed**, along with syntax checks, the isolated Cloudflare dry run (445.03 KiB / 106.48 KiB gzip), and [GitHub CI](https://github.com/JMaverick-SecOps/MAG/actions/runs/33139408029).
- **39 live smoke checks passed** at 2026-08-28T03:38:09.425Z; paid intake reported ready, unauthenticated admin access was rejected, unsigned device requests were rejected and the unverified SaturnShift webhook stayed disabled. The live wallet asset matched the reviewed source.
- D1 migrations **0021–0024 applied** after restoring a fresh private backup into isolated local storage and rehearsing the upgrade. Both local and production quick checks passed, with no foreign-key violations. Backup SHA-256: `6b4ecfddbe9632b7ca6affd163dd81ace95281e90578926fb1177db945887a1f`. Backup contents remain outside Git with a restricted Windows ACL.
- A random owner-review credential was securely provisioned via stdin. Its recovery copy is Windows-user DPAPI-encrypted outside Git. Authenticated owner access was verified; values were never printed. Safe signing remains owner-controlled.
- Production counts after smoke tests: **0 orders, 0 subscriptions, 0 enrolled devices, 0 payment receipts and 0 migration projects**. No revenue, live payment, completed migration or remote-control action is claimed.

### Still blocked or deliberately unavailable

SaturnShift's public key is provisioned, but its authoritative webhook and registration contract is not verified; **card/ACH checkout remains disabled**. Card/ACH fiat settlement is not automatically USDC. No treasury conversion or reserve spending is implemented.

Microsoft/Google/Dropbox and verified-TLS IMAP adapter libraries now exist and pass mocked tests. A deployed private connector service, per-customer vault/OAuth provisioning and real test-tenant certification are still required. Migration/security forms hold payment until supported delivery capacity passes preflight. Full-fidelity calendars, contacts, native-document conversion and all provider edge cases are not certified.

ScreenConnect still needs an authorized licensed instance and scoped credentials for live tests. Service restarts remain disabled. Unattended patching, arbitrary scripts, full remote control and a general-purpose autonomous worker fleet are not claimed. Funded community tasks still need an actual worker and evidence-backed acceptance. Email-provider delivery remains unconfigured.

The previous compatible checkout version is `06150bcd-cabb-4257-8fc9-ab9ce4e825f2`; the earlier pre-subscription code version is `df8678f4-c7b3-4648-8221-8be89b720f57`. Roll back code only with schema/record compatibility reviewed. Do not overwrite customer activity with a database restore.

## Historical release record — earlier August 27 deployment

The remainder records the earlier deployment and its then-current limitations. Where it differs, the current status above takes precedence.



This is a production deployment of the tested components, not a claim that every service is operational. Paid intake and SaturnShift remain disabled pending the requirements below.
No wallet was signed, no funds were moved, and no provider payment was fabricated.

## Production deployment receipt

- Deployed at **2026-08-28 02:20 UTC** (August 27, 8:20 PM America/Denver).
- Worker: `mavverick-scout`; [production site](https://mavverick-scout.magai.workers.dev).
- Version: `df8678f4-c7b3-4648-8221-8be89b720f57`; application commit: `b774b8f` on `codex/finish-mag-builds`.
- Preserved existing vars and secret bindings. The 15-minute cron and `mag-migration-orchestrator` binding are deployed; no migration instance was started. Players
- D1 migrations **0011–0020 applied** after a successful in-memory rehearsal of the production export. All 20 migrations are tracked and none remain pending.
- A private pre-release SQL export is stored outside Git. SHA-256: `59d5328913f93bec81dda5ea74acbf88c159552af430d46bf9a2540858f57bfb`. A Time Travel recovery bookmark was also recorded privately.
- Production `PRAGMA quick_check` returned `ok`; `foreign_key_check` returned no violations. Existing task, order, bounty, member-application and audit counts were preserved. D1 does not expose the attempted SQLite `integrity_check`; the documented quick-check was used instead.
- **90 tests passed**, all release JavaScript passed syntax checks, and the final Worker dry-run passed (378.51 KiB / 89.72 KiB gzip).
- **34 non-monetary live smoke checks passed** at 02:22 UTC. Re-run with `node scripts/smoke-production.mjs`. Service cards were also clicked in the live browser: the SOW card prefilled 49 USDC and `draft_only`; the operations preview and ScreenConnect boundary rendered correctly.
- Live payment status: `paid_intake_ready=false`, `saturnshift.configured=false`. Paid intake returned 503, the disabled webhook returned 503, unauthenticated admin access returned 401, and an invalid private order token returned 404. No order, bounty, provider event or payment receipt was created by the tests.

The previous Worker version is `88e57e7a-3407-461c-a74c-cbb2caf216f5`. Any rollback must account for schema compatibility and new records; do not automatically restore the database or overwrite post-release activity.

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

The owner authorized this production release, and migrations 0011–0020 have been applied. Future schema changes still require a fresh backup, effect review, rehearsal and release authorization. Do not deploy this Worker against an older schema. Existing CI runs tests and builds; schema migration remains a separate release operation, not an unattended CI side effect.

After authorized release, preserve deployed vars (`--keep-vars`), verify `/health`, `/hire`, `/ops`, `/ops/console`, `/ops/screenconnect`, `/orders/status` and all branding assets. Confirm unconfigured payment adapters still refuse requests. Real provider tests must use separate test orders and must not fabricate revenue or completion records.

## Official integration references

- [Cloudflare Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)
- [Cloudflare Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [SaturnShift merchant developer page](https://app.saturnshift.io/admin/settings/developers) (requires merchant login)
- [SaturnShift payment and settlement overview](https://www.saturnshift.io/accept-cards-ach-and-crypto/)
