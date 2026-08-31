# MAG chain infrastructure

## Implemented, versus enabled for payments

Base remains MAG's invoice network: chain 8453, Circle-issued native USDC, exactly 1,000,000 atomic units for an agent-day. This build does not change any invoice, treasury address, wallet, token allowance or payment flag.

`src/evm-networks.js` and `src/alchemy-chains.js` add a read-only Alchemy adapter for Base, Ethereum (1), Robinhood Chain mainnet (4663) and Robinhood testnet (46630). The adapter verifies chain ID before reading, refuses all signing/sending methods, uses bounded HTTPS requests, and shares durable quota cooldowns. It is a development/data-access integration, not completed multi-chain checkout or a deployed smart contract.

`GET /api/chains` publishes network metadata and explicit limitations. Owner-authenticated `GET /admin/alchemy/health?network=base|ethereum|robinhood|robinhood-testnet` performs fixed chain/finality reads; it is not an arbitrary public RPC proxy. Single-provider readiness never authorizes a payment. Base settlement still requires its existing two independent operator observations.

## Account setup and secure handoff

The Alchemy app is **MAG Chain Infrastructure**. Base and Ethereum mainnets plus Robinhood mainnet/testnet were observed enabled on August 31. The free OnFinality app is **MAG Base Payment Witness**. No paid tier, wallet connection or charge was selected. Setup keys displayed by provider pages were replaced; do not reuse values from prior setup output.

In the MAG repository, run PowerShell 7:

```powershell
pwsh -NoProfile -File .\scripts\configure-rpc-secrets.ps1
```

Paste only into its two **hidden local prompts**: the rotated Alchemy API key and the private Base HTTPS endpoint from OnFinality. Never paste either into chat. The helper uses the already-installed Wrangler, streams JSON through stdin, forces request-body log sanitization, suppresses child output and updates exactly these bindings in the existing `mavverick-scout` Worker:

- `MAG_ALCHEMY_API_KEY` for read-only development access.
- `MAG_BASE_RPC_PRIMARY_URL` derived for Alchemy Base mainnet.
- `MAG_BASE_RPC_SECONDARY_URL` for OnFinality Base mainnet.

It does not save plaintext files or put credentials in process arguments. Plaintext necessarily exists briefly in local process memory and Wrangler's input; this is not a hardware-isolated secret channel. It requires an authenticated Cloudflare CLI session. On an uncertain upload result, inspect secret **names** before retrying; never print values. After upload, check authenticated production health, historical receipt methods, and product delivery gates. A successful upload alone is not payment acceptance.

## Ethereum and Robinhood payment prerequisites

Ethereum native USDC is documented by Circle at `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`. Ethereum checkout still needs chain-bound immutable invoices, chain-and-hash deduplication, a verified recipient controlled on Ethereum, two independent witnesses, finality tests and reviewed activation. A Base smart-wallet address is not evidence that the same wallet is deployed or recoverable on Ethereum or Robinhood.

Robinhood mainnet is documented as chain 4663 and uses ETH for gas. Its token page lists USDG and WETH, while the Circle native-USDC list checked August 31 contains no Robinhood entry. Do not label USDG or a bridged token as native USDC, copy Base's USDC contract to another chain, or treat ETH gas as a dollar-priced invoice asset. Select and verify the actual payment asset/recipient and implement its accounting before offering Robinhood checkout. No fund bridging is part of this build. Testnet tokens never count as revenue.

Sources checked 2026-08-31: [Alchemy networks](https://www.alchemy.com/docs/reference/node-supported-chains), [Robinhood connections](https://docs.robinhood.com/chain/connecting/), [Robinhood finality](https://docs.robinhood.com/chain/transaction-finality/), [Robinhood tokens](https://docs.robinhood.com/chain/contracts/), [Circle USDC contracts](https://developers.circle.com/stablecoins/usdc-contract-addresses), [OnFinality Base](https://onfinality.io/en/networks/base), [Alchemy rotation](https://www.alchemy.com/docs/how-to-rotate-api-keys).
