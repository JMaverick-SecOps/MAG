# Alchemy and chain infrastructure release

Direct owner requests: configure Alchemy, set up a free second independent provider, and support Ethereum/Robinhood Chain development and future payments. Recorded 2026-08-31; this is not a payment, bounty acceptance or citizen activation receipt.

## Verified changes

- Two-witness RPC repair committed/pushed as `655dd58542469a06e0959fd20918f4ffd44adc8e`, initially deployed as Worker `40eb8174-e554-4df4-aec3-d3393580c7f0`. Reviewed nonfinancial D1 table `payment_rpc_backoff` (migration 0028) was created and read back. Unrelated draft migration 0025 was excluded. No payment/customer data was fabricated or credited.
- The temporary RPC probe observed Llama HTTP 521, OnFinality public HTTP 429 and PublicNode HTTP 429 on finality. It was retired to a constant non-network receipt, version `3aae551b-1a7b-4fbd-bced-add16ed57fc2`.
- Signed-in Alchemy app `mhmmaocsqmc1t5sx` is named **MAG Chain Infrastructure**. Its UI showed Base and Ethereum mainnets plus Robinhood mainnet/testnet enabled. After the initial setup key appeared in page output, explicit owner-approved rotation returned **API key rotated**. The exposed key was not installed or used for an authenticated RPC request.
- Explicit owner-approved j@mavverick.net Google sign-in shared only displayed basic profile/email. Free OnFinality app **MAG Base Payment Witness** was created and Base selected. Its initial WebSocket credential also appeared in setup output; the unused key was regenerated through Settings. Subsequent output excluded credential fields and credential-bearing URLs. No credentials belong in this record.
- Read-only Alchemy chain adapters, protected health diagnostic, truthful public catalog and hidden-input credential installer committed/pushed as **`250fff5e1a0c362904a2b3c71ed90e2c936c4933`**. Isolated suite: **204 Node + 7 Python tests passed**. Installer PowerShell syntax passed; its actual secret upload has not yet run. Dry-run bundle: 505.27 KiB / gzip 123.83 KiB.
- Current production Worker: **`af110acf-4be8-432e-b497-74f2ef17becd`**. Existing 15-minute cron, migration workflow, treasury bindings and disabled agent-day/hosted-work flags preserved.
- **53 production smoke checks passed at 2026-08-31T19:33:02.717Z**, including `/api/chains`, chain separation and unauthorized health-route rejection. Git was 0 ahead / 0 behind the tracked branch after push.

## Precise remaining gates

The owner-input installer is waiting at its hidden Alchemy prompt (terminal session 99839; Codex panel request queued). No browser credential was transferred into it. Later secret-name inspection still found neither RPC override nor `MAG_ALCHEMY_API_KEY`; authenticated checks for all four networks returned `alchemy_credential_missing`. Account-specific live RPC access is **not yet verified**.

At 19:15:00Z, production Base health found the public Base witness rate-limited and PublicNode chain/finality responsive: **ready:false** because both are required. The site's existing `paid_intake_ready:true` is a configuration indicator, not live witness health. The $1 agent-day and hosted-work flags remain false. After secret entry, verify actual Worker chain/finality plus historical transaction/receipt methods before product activation. No real test charge is authorized.

Ethereum/Robinhood have development read adapters, **not enabled checkout**. New payment networks still require verified recipient control, immutable chain/asset invoices, chain-aware receipt deduplication, independent witnesses and finality tests. Circle's native-USDC list checked today has no Robinhood entry; Robinhood lists USDG/WETH. No signing, bridging, token approvals or treasury movement occurred.

SaturnShift login was confirmed, but no new notification, account-specific signing-secret control or signed test delivery was observed. Its settlement remains disabled. No real payment, delivered hosted purchase, notification-provider delivery, accepted bounty or external citizen activation is claimed.

Reproduction: isolated full tests; `node scripts/smoke-production.mjs`; owner-authenticated `/admin/payment-rpc-health` and `/admin/alchemy/health?network=base`. See `docs/payment-rpc-operations.md` and `docs/alchemy-and-chains.md`.
