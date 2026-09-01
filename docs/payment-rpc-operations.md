# Automatic payment verification and RPC capacity

Cloudflare hosting capacity is separate from the blockchain providers' quotas.
Upgrading Workers does not increase an upstream RPC provider's allowance.

## Configuration

For the approved Alchemy/OnFinality pair, `scripts/configure-rpc-secrets.ps1` provides a single hidden-input handoff, including the new read-only chain adapter. See [Alchemy and chains](alchemy-and-chains.md). Neither key belongs in chat, a committed file, a browser-visible MAG field or a command argument.

`scripts/install-rpc-secrets-stdin.mjs` provides the same three-binding update for a trusted local automation that already holds both values in memory. Its JSON stdin must come directly from that trusted process—never a command argument, shell history, source file or log. It suppresses Wrangler response bodies and prints only the names of confirmed bindings.

Set both `MAG_BASE_RPC_PRIMARY_URL` and `MAG_BASE_RPC_SECONDARY_URL` as **Worker secrets** containing account-specific Base mainnet HTTPS endpoints. Do not put credential-bearing URLs in `wrangler.jsonc`, chat, command arguments, logs or browser-visible MAG fields. Use Wrangler's hidden prompt:

```
npx wrangler secret put MAG_BASE_RPC_PRIMARY_URL
npx wrangler secret put MAG_BASE_RPC_SECONDARY_URL
```

Supported operator families are Base, PublicNode, Alchemy (base-mainnet.g.alchemy.com), Quicknode (*.base-mainnet.quiknode.pro) and OnFinality (base.api.onfinality.io). The two endpoints must belong to different operator families. Hostnames alone cannot prove independent underlying failure domains. If either override is missing or invalid, verification stops; it does not silently fall back to a public endpoint. With neither set, existing Base/PublicNode defaults remain for compatibility, not as a production-capacity claim.

Account creation, sign-in and any provider charge remain owner actions where required. Alchemy's free account is an initial setup option, not proof of adequate sustained throughput. Do not purchase a plan or create an API key without the required authorization. No customer private wallet key is needed.

Sources: [Alchemy Chain APIs](https://www.alchemy.com/docs/get-started), [Quicknode Base](https://www.quicknode.com/docs/base), [OnFinality Base](https://onfinality.io/en/networks/base).

## What now happens automatically

Orders, subscription invoices, migration payments, bounty funding and agent-days all use `src/payment-rpc.js`. The caller submits its transaction hash once. Existing cron processors verify it and credit/publish/queue the matching product only when its existing acceptance predicate passes. Third-party workload approval gates remain unchanged.

The transport checks Base chain ID, refuses redirects, bounds response size/time, serializes requests per witness and coalesces repeated reads within one verification. HTTP failures (including 429), JSON-RPC errors inside HTTP 200, malformed payloads and timeouts never credit payment. D1 stores categorical errors and a fingerprint of the endpoint, not the endpoint or credential. Cooldowns survive new isolates and deployments. Retry-After is honored up to 24 hours; automatic exponential backoff ranges from one minute to one hour otherwise. The 15-minute settlement cron resumes eligible pending receipts without requiring another payment or a manual credit. Both observations are drained on failure; one healthy witness cannot settle a payment.

The nonfinancial schema is `0028_payment_rpc_backoff.sql`. Apply only this reviewed migration; unrelated draft migration 0025 is out of scope.

## Read-only production diagnostic

`GET /admin/payment-rpc-health` requires the existing owner bearer token. It verifies chain ID, a finalized block, and historical transaction/receipt reads through both configured operators, returning only operator labels, categorical failures and retry times. It never returns URLs or credentials. Its `ready` field describes **read capability only**, not invoice matching, checkout acceptance, delivered work or a real payment. The public cannot use it as an RPC proxy.

Before enabling a disabled product: configure capacity, verify both witnesses from the actual Worker, test historical receipt/transaction methods without sending a payment, and complete the product-specific hosted-delivery checks. No real charge is a test. Existing disabled agent-day and SaturnShift flags are not changed by this transport repair.

## SaturnShift remains separate

On August 31 the authenticated MAVVERICK merchant Developers page exposed the public checkout key and widget examples, but no signing-secret/webhook registration control. Support exposed a new-report form, not an existing-ticket response; Notifications said no new notifications. Login is confirmed, webhook access is not. The public-key checkout is available for ordinary service and PSA/RMM payment intake, with agent-day access excluded. Do not equate the public key or redirect with signed settlement proof. MAG still requires the account-specific signing secret, registered endpoint and independently observed provider-signed test before that rail can fulfill purchases automatically.
