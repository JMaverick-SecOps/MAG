import { RPCS, createPaymentRpc, collectWitnesses } from './payment-rpc.js';
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;

async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(x => x.toString(16).padStart(2, "0")).join("");
}

// The trailing 32-byte reference is non-argument calldata. USDC still receives
// an ordinary transfer, not an allowance. Independent RPCs must observe this
// exact calldata before the payment can activate this specific purchase.
async function transferRequest(purpose, id, treasury, amount) {
  if (!ADDRESS.test(treasury) || /^0x0{40}$/i.test(treasury)) throw new Error("treasury unavailable");
  if (!/^[1-9][0-9]{0,20}$/.test(String(amount)) || BigInt(amount) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid payment amount");
  if (!["service_order", "subscription_invoice", "agent_connection_day"].includes(purpose) || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid purchase identity");
  const reference = await digest(`mag.payment.v1:${purpose}:${id}`);
  const data = "0xa9059cbb" + treasury.slice(2).toLowerCase().padStart(64, "0") + BigInt(amount).toString(16).padStart(64, "0") + reference;
  return { chainId: "0x2105", to: USDC, value: "0x0", data, reference, amount_atomic: String(amount), treasury_address: treasury.toLowerCase(), asset: "USDC", network: "Base" };
}

async function createPaymentIntent(db, purpose, id, treasury, amount, now = Date.now()) {
  const request = await transferRequest(purpose, id, treasury, amount);
  await db.prepare("INSERT INTO checkout_payment_intents(purpose_type,purpose_id,amount_atomic,treasury_address,calldata,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(purpose_type,purpose_id) DO NOTHING")
    .bind(purpose, id, String(amount), request.treasury_address, request.data, now).run();
  const row = await db.prepare("SELECT * FROM checkout_payment_intents WHERE purpose_type=? AND purpose_id=?").bind(purpose,id).first();
  if (!row || row.amount_atomic !== String(amount) || row.calldata !== request.data || row.treasury_address !== request.treasury_address) throw new Error("payment intent differs from the immutable invoice");
  return request;
}

async function verifyPaymentIntent(intent, txHash, fetcher = fetch, env = {}) {
  if (!intent || !HASH.test(txHash || "")) return { verified: false, reason: "payment_intent_missing" };
  const client = createPaymentRpc(env, fetcher);
  const observations = await collectWitnesses(client, async (_, index) => {
    const chain = await client.request(index, 'eth_chainId');
    if (chain !== '0x2105') return { receipt:null, transaction:null, finalized:null, wrongChain:true };
    const receipt = await client.request(index, "eth_getTransactionReceipt", [txHash]);
    const transaction = await client.request(index, "eth_getTransactionByHash", [txHash]);
    const finalized = await client.request(index, "eth_getBlockByNumber", ["finalized", false]);
    return { receipt, transaction, finalized };
  });
  if (observations.some(o=>o.wrongChain)) return {verified:false, reason:'wrong_chain'};
  const recipient = "0x" + intent.treasury_address.slice(2).padStart(64,"0");
  for (const { receipt:r, transaction:t, finalized:f } of observations) {
    if (!r || !t || !f || r.status !== "0x1" || !/^0x[0-9a-f]+$/i.test(f.number || "") || !/^0x[0-9a-f]+$/i.test(r.blockNumber || "")) return { verified:false, reason:"payment_not_finalized" };
    if (BigInt(f.number) < BigInt(r.blockNumber)) return { verified:false, reason:"payment_not_finalized" };
    if (String(t.hash).toLowerCase() !== txHash.toLowerCase() || String(r.transactionHash).toLowerCase() !== txHash.toLowerCase() || t.blockHash !== r.blockHash || t.to?.toLowerCase() !== USDC || t.input?.toLowerCase() !== intent.calldata || t.value !== "0x0") return { verified:false, reason:"payment_reference_mismatch" };
    const exact = (r.logs || []).some(log => log.address?.toLowerCase() === USDC && log.topics?.[0]?.toLowerCase() === TRANSFER && log.topics?.[2]?.toLowerCase() === recipient && /^0x[0-9a-f]+$/i.test(log.data || "") && BigInt(log.data) === BigInt(intent.amount_atomic));
    if (!exact) return { verified:false, reason:"exact_transfer_not_found" };
  }
  if (observations[0].receipt.blockHash !== observations[1].receipt.blockHash || observations[0].receipt.blockNumber !== observations[1].receipt.blockNumber) return { verified:false, reason:"rpc_disagreement" };
  return { verified:true, independent_rpc_observations:2, finalized:true, block_number:BigInt(observations[0].receipt.blockNumber).toString(), reference_bound:true };
}

export { USDC, RPCS, createPaymentIntent, transferRequest, verifyPaymentIntent };
