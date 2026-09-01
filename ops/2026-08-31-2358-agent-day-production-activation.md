# Agent-day production activation receipt

- Time: 2026-08-31T23:58:50Z
- Worker: `mavverick-scout`
- Version: `26c4fdd1-431a-4252-9042-5f6bf97c1b19` at 100% traffic
- Primary operator: Alchemy
- Secondary operator: OnFinality
- Secret handling: both credentials were rotated in their authenticated provider consoles and entered as encrypted Cloudflare secrets. No credential value was committed, logged, displayed in chat or passed as a command argument.
- Live read result: both operators independently returned Base chain 8453, a valid finalized block, the selected historical transaction and its matching historical receipt.
- Health scope: `chain_finality_and_historical_receipt_reads`
- Product state: `MAG_AGENT_CONNECTIONS_ENABLED=true` and `MAG_HOSTED_WORK_WATCH_ENABLED=true`
- Price: exactly 1,000,000 atomic units of native USDC on Base for one prepaid 24-hour period
- Automatic debit: false
- SaturnShift settlement: false; still independently gated
- Ethereum and Robinhood checkout: false; read-only development support only
- Verification: 204 Node tests passed, 7 Python tests passed, Wrangler dry-run built 506.06 KiB / 123.94 KiB gzip, and 51 production smoke checks passed.
- Production database readback: zero agent-day invoices, zero hosted runs and zero agent connection payment/delivery notifications immediately after activation.
- Financial boundary: no real or synthetic production payment was initiated; the first legitimate receipt must still be independently verified and matched to its actual hosted deliverable.
