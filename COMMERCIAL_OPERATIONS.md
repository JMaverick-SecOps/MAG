# Checkout, subscriptions and connector operations

## Release boundary

This release implements checkout plus a 30-day trial followed by prepaid subscription billing. It does **not** certify every advertised digital service as staffed or every connector as production-ready.

- Every /hire service is clickable; service, price, mode and acceptance defaults are server-controlled. Only customer identity, scope and authorization remain to enter.
- Ordinary invoices open a self-hosted Base-USDC wallet flow. The buyer must approve the exact transaction. MAG receives no wallet key or allowance. A unique invoice reference is bound to the ERC-20 transfer calldata, and two independent RPCs must observe the exact finalized transaction.
- Confirmed orders become funded community tasks. A worker must still claim and perform the job; acceptance requires reproducible evidence. Publishing is not a guarantee of staffing or completion.
- PSA Workspace: 79 USDC/calendar month. Managed Visibility: 49 USDC/calendar month plus 15 USDC per enrolled-device capacity. Prices come from the existing catalog. The managed-security plan remains disabled.
- New PSA Workspace and Managed Visibility tenants receive one 30-day trial per contact or authorized organization domain. No payment method is required and the first post-trial invoice is created server-side. Payment during the trial prepays the calendar month after the trial; cancellation voids the unpaid invoice. No card, bank account or wallet is charged automatically. Unpaid subscriptions lose entitlement when trial or paid access expires.
- Subscriptions include white-label display/colour/logo settings, tenant-scoped tickets/SLA targets, customer agreements, reviewed time entries and draft customer invoices. Draft invoices do not charge the customer's client. Endpoint enrollment, telemetry and runbooks require Managed Visibility; the flat-rate PSA plan cannot bypass per-device monitoring charges. Previously operator-approved non-subscription tenants retain their explicit legacy access.
- The visible endpoint runner supports signed, opt-in inventory/heartbeat/memory telemetry and bounded diagnostics. It has no arbitrary remote shell, stealth installation, screen capture or auto-start. Restart-service code remains disabled by the production flag and additionally requires exact-target approval and local consent.
- ScreenConnect inventory integration requires the customer's licensed instance, operator-pinned origin/filter and securely provisioned authentication. Live remote sessions, patch installation, unattended remediation and installer distribution are not certified.
- Migration and security-review forms record a selected service and calculated quote but request **no payment** until delivery preflight is valid.

## Connector code and remaining work

[Provider clients](src/migration-provider-clients.js) implement Microsoft Graph drive download/resumable upload, Google Drive download/resumable upload, Dropbox download/upload sessions, Gmail raw export/import, and read-only Graph MIME export. [File copy](src/migration-file-copy.js) provides checkpointed copying and full source/destination SHA-256 readback. [IMAP client](agents/migration_mail.py) supplies verified TLS, XOAUTH2, read-only source access, UIDVALIDITY/UIDPLUS pinning and conservative APPEND reconciliation.

These are **private data-plane libraries**, not a deployed connector service. They require an authenticated private connector that:

1. Pins each project, source/target mailbox, drive/folder, workload and mapping before any provider request.
2. Resolves short-lived tokens from a tenant-isolated vault and implements OAuth consent, refresh, revocation and least-privilege scopes.
3. Stores encrypted private checkpoints (upload-session URLs are credentials) and performs atomic, idempotent byte reservations against the paid pool.
4. Serializes work per item. Persisting a dispatch intent alone does not implement a distributed lease.
5. Reconciles unknown upload/APPEND outcomes before retrying; never blindly repeats writes.
6. Checks destination content, counts, flags/dates/folders and manifests on actual authorized test accounts.
7. Treats zero-byte files, provider-native documents, large MIME, calendars/contacts, shared-drive permissions, exports and transformations as explicit capability tests, not assumed support.

File chunks are 5 MiB (compatible with Graph and Google alignment). Generic IMAP literals are bounded to 32 MiB; Gmail JSON raw imports/exports are bounded to 8 MiB base64 text. Provider limits may be lower. Unsupported or transformed objects require an exception/fidelity report. The code never deletes the source or sends migrated messages.

Licenses remain **18 USDC per 500 GiB, pooled within a project**. The control plane does not charge merely because these libraries exist. Live M365/Google/Dropbox/IMAP credentials and representative test datasets have not been supplied; no live migration has been claimed or run.

## Endpoint setup

Use Node 24 on an explicitly authorized endpoint. Review [the runner](agents/mag-endpoint.mjs) before installation. Provision these values through a device-scoped secret manager or protected service account environment, not command-line arguments, Git, tickets or chat:

- MAG_TENANT_ID: paid, active tenant.
- MAG_ASSET_ID: stable device identifier within that tenant.
- MAG_DEVICE_STATE_PATH: private local SQLite path. Restrict its directory ACL to the service account; it includes the encrypted device identity and result outbox.
- MAG_DEVICE_KEY_PASSWORD: random passphrase of at least 24 characters from the device secret manager.
- MAG_TENANT_ACCESS_TOKEN: enrollment only; remove it from the environment after enrollment.
- Optional MAG_ALLOWED_SERVICES: explicit comma-separated local service names for diagnostics. Protected security services cannot be targeted.
- MAG_ALLOW_SERVICE_RESTART must remain unset unless a separately approved, tested change policy is deployed. Production currently rejects restart jobs regardless.

Run node agents/mag-endpoint.mjs --enroll once, then run without arguments in a visible managed process, or use --once for a single cycle. The script does not install persistence. Telemetry and results are signed; the device key stays encrypted on the endpoint. A durable outbox resends results without executing a leased action twice. Ambiguous results require review.

No endpoint was enrolled on the owner's machine during release tests. No service restart, ScreenConnect session or remote command was performed.

## SaturnShift and owner administration

The merchant has a public checkout key. That public identifier is in Wrangler configuration; it is not a secret. SaturnShift's merchant [developer guide](https://www.saturnshift.io/developers/) defines a public-key checkout with a unique external reference, idempotency key and success redirect. MAG now exposes that checkout for ordinary service orders and PSA/RMM subscription invoices. The redirect is never treated as payment proof and cannot activate access or publish work.

SaturnShift's published [webhook contract](https://docs.saturnshift.io/webhooks) defines the `SaturnShift-Signature: t=...,v1=...` raw-body HMAC, transaction envelope, deduplicated event ID and final `payment.paid` state. MAG verifies those exact bytes and accepts only an exact USD amount whose documented crypto settlement is USDC on Base. Automatic fulfillment remains fail-closed until the merchant signing secret is stored and the MAG endpoint is registered.

Card/ACH settlement is fiat; crypto settlement can be Base USDC. The authenticated merchant dashboard shows card, bank and crypto enabled, so `SATURNSHIFT_CHECKOUT_METHODS` exposes those methods for payment intake. Their authoritative financial event fields have not been confirmed for MAG, so card/ACH fulfillment remains pending under `SATURNSHIFT_FIAT_WEBHOOK_STATUS` until the provider confirms the contract. This release does not convert, reserve or spend treasury money to bridge fiat. A customer's PSA/RMM tenant does not need SaturnShift: SaturnShift is MAG's merchant rail only. Agent-day access is explicitly excluded and remains direct Base USDC. QuickBooks, Xero and NetSuite are separate tenant accounting connectors and are not yet represented as active.

[Owner provisioning](scripts/provision-owner-admin.ps1) creates a random owner token, sends it over Wrangler stdin, and keeps only a Windows-user DPAPI-encrypted recovery file under the local MAG owner-admin directory, outside Git. It refuses to overwrite an existing unknown token. [Admin status](scripts/admin-status.ps1) checks authenticated access without printing the token. This credential gates review endpoints, not Safe signing; the Worker cannot sign treasury transactions.

## Verification and rollback

Run npm run check with Node 24, and python -m unittest discover -s test -p test_migration_mail.py. Run Wrangler deploy --dry-run in the isolated build and node scripts/smoke-production.mjs after release.

Unit tests mock providers; passing them is not a live-provider receipt. Production smoke checks do not create orders, charge wallets, enroll tenants or move mail.

Back up D1 privately before migrations 0021–0024; rehearse them locally and preserve all previous records. Deploy with --keep-vars. Rollback must use a schema-compatible Worker and account for records created since release. Never overwrite post-release customer activity with an old database.

## Primary provider references

- [Graph upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0)
- [Graph downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)
- [Google Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Gmail imports](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/import)
- [Dropbox HTTP API](https://www.dropbox.com/developers/documentation/http/documentation)
- [Microsoft IMAP OAuth](https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth)
- [SaturnShift payment methods and settlement](https://www.saturnshift.io/invoices-and-payment-links/)
