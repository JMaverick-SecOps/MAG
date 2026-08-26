const SERVICES = Object.freeze([
  { id: "sow-studio", name: "Autonomous SOW Studio", from_atomic: "250000000", category: "sow", risk: "low", modes: ["draft_only"], summary: "Requirements synthesis, assumptions, deliverables, acceptance criteria, schedule, and pricing model." },
  { id: "network-exposure-test", name: "Authorized Network Exposure Test", from_atomic: "750000000", category: "security", risk: "high", modes: ["read_only", "preapproved_safe_tests"], summary: "Passive exposure mapping and explicitly authorized non-destructive checks against named assets." },
  { id: "m365-audit", name: "Microsoft 365 Audit & Hardening", from_atomic: "1000000000", category: "security", risk: "high", modes: ["audit_only", "preapproved_changes"], summary: "Tenant posture audit, evidence pack, remediation plan, and separately authorized hardening changes." },
  { id: "email-deliverability", name: "Email Deliverability Lab", from_atomic: "500000000", category: "operations", risk: "medium", modes: ["owned_domains_only"], summary: "SPF, DKIM, DMARC, DNS, reputation, content, and controlled inbox-placement testing for authorized domains." },
  { id: "trading-research", name: "Trading Research Agent", from_atomic: "500000000", category: "research", risk: "high", modes: ["research_only", "signals", "customer_authorized_execution"], summary: "Backtests, entry/exit signals, risk scenarios, and optional customer-controlled execution under explicit limits." },
  { id: "automation-build", name: "Automation Build", from_atomic: "2500000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], summary: "API, data, document, support, sales, and operations workflows built and tested against acceptance criteria." },
  { id: "software-delivery", name: "Software & Agent Delivery", from_atomic: "5000000000", category: "engineering", risk: "medium", modes: ["pull_request", "sandbox_deploy"], summary: "Features, integrations, applications, games, tests, documentation, and supervised deployment packages." },
  { id: "creative-production", name: "Creative Production", from_atomic: "250000000", category: "creative", risk: "low", modes: ["artifact_delivery"], summary: "Original music concepts, visual assets, copy, research briefs, presentations, and other rights-cleared digital work." },
  { id: "custom-autonomous", name: "Custom Autonomous Task", from_atomic: "750000000", category: "custom", risk: "review", modes: ["proposal_first"], summary: "Any lawful, remote, objectively verifiable task that community agents can complete without hidden human labor." },
]);

const HEX_TX = /^0x[a-fA-F0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];

function clean(value, maximum) { return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum); }
async function sha256(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function serviceById(id) { return SERVICES.find((service) => service.id === id); }

async function createOrder(db, input) {
  const service = serviceById(clean(input.service_id, 80));
  if (!service) throw new Error("unsupported service");
  const buyerName = clean(input.buyer_name, 100);
  const buyerEmail = clean(input.buyer_email, 254).toLowerCase();
  const buyerAgent = clean(input.buyer_agent_handle, 63);
  const objective = clean(input.objective, 4000);
  const acceptance = clean(input.acceptance_criteria, 4000);
  const scope = clean(input.target_scope, 3000);
  const mode = clean(input.execution_mode, 80);
  const maxBudget = String(input.max_budget_atomic || "");
  if (buyerName.length < 2 || !EMAIL.test(buyerEmail) || objective.length < 30 || acceptance.length < 30 || scope.length < 10) throw new Error("buyer, objective, acceptance criteria, and target scope are required");
  if (!service.modes.includes(mode)) throw new Error("execution mode is not allowed for this service");
  if (input.authorization_attested !== true) throw new Error("scope ownership or authorization must be attested");
  if (!/^\d+$/.test(maxBudget) || BigInt(maxBudget) < BigInt(service.from_atomic)) throw new Error("maximum budget is below the service minimum");
  if (service.id === "trading-research" && mode === "customer_authorized_execution" && input.customer_controls_account !== true) throw new Error("customer must control the trading account and execution limits");
  const id = crypto.randomUUID();
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  await db.prepare("INSERT INTO service_orders(id,access_token_hash,service_id,buyer_name,buyer_email,buyer_agent_handle,objective,acceptance_criteria,target_scope,authorization_attested,execution_mode,quoted_atomic,max_budget_atomic,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,'awaiting_payment',?,?)")
    .bind(id, await sha256(accessToken), service.id, buyerName, buyerEmail, buyerAgent, objective, acceptance, scope, mode, service.from_atomic, maxBudget, now, now).run();
  await db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) VALUES(?,'order_created',?,?)").bind(id, JSON.stringify({ service_id: service.id, execution_mode: mode, quoted_atomic: service.from_atomic }), now).run();
  return { id, access_token: accessToken, service: service.name, status: "awaiting_payment", quoted_atomic: service.from_atomic, asset: "USDC", network: "Base", warning: "Save access_token now. Payment does not authorize activity outside target_scope, execution_mode, acceptance criteria, or max budget." };
}

async function authorizedOrder(db, id, token) {
  const order = await db.prepare("SELECT * FROM service_orders WHERE id=?").bind(id).first();
  if (!order || !token || await sha256(token) !== order.access_token_hash) return null;
  delete order.access_token_hash;
  return order;
}

async function submitPaymentReceipt(db, id, token, input) {
  const order = await authorizedOrder(db, id, token);
  if (!order) throw new Error("order not found or unauthorized");
  const txHash = clean(input.tx_hash, 66).toLowerCase();
  if (!HEX_TX.test(txHash)) throw new Error("valid Base transaction hash required");
  if (order.payment_status !== "unsubmitted") throw new Error("payment receipt already submitted");
  const now = Date.now();
  await db.prepare("UPDATE service_orders SET payment_tx_hash=?,payment_status='pending_verification',status='payment_review',updated_at=? WHERE id=?").bind(txHash, now, id).run();
  await db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) VALUES(?,'payment_receipt_submitted',?,?)").bind(id, JSON.stringify({ tx_hash: txHash }), now).run();
  return { id, status: "payment_review", payment_status: "pending_verification" };
}

async function rpc(url, method, params, fetcher) {
  const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error(`Base RPC returned ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`Base RPC error ${body.error.code}`);
  return body.result;
}

function paidExactly(receipt, treasury, atomic) {
  const recipientTopic = `0x${treasury.toLowerCase().slice(2).padStart(64, "0")}`;
  return (receipt.logs || []).some((log) => log.address?.toLowerCase() === BASE_USDC
    && log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC
    && log.topics?.[2]?.toLowerCase() === recipientTopic
    && BigInt(log.data || "0x0") === BigInt(atomic));
}

async function processPendingOrders(env, fetcher = fetch) {
  if (!env.DB || !/^0x[a-fA-F0-9]{40}$/.test(env.TREASURY_WALLET_ADDRESS || "")) return { configured: false, checked: 0, verified: 0 };
  const pending = await env.DB.prepare("SELECT id,service_id,quoted_atomic,payment_tx_hash FROM service_orders WHERE payment_status='pending_verification' ORDER BY updated_at LIMIT 10").all();
  let verified = 0;
  for (const order of pending.results || []) {
    try {
      const observations = await Promise.all(BASE_RPCS.map(async (url) => ({
        receipt: await rpc(url, "eth_getTransactionReceipt", [order.payment_tx_hash], fetcher),
        head: await rpc(url, "eth_blockNumber", [], fetcher),
      })));
      if (observations.some(({ receipt }) => !receipt)) continue;
      const [first, second] = observations;
      if (first.receipt.blockHash !== second.receipt.blockHash || first.receipt.status !== "0x1" || second.receipt.status !== "0x1") continue;
      const block = BigInt(first.receipt.blockNumber);
      if (observations.some(({ head }) => BigInt(head) - block < 12n)) continue;
      if (!observations.every(({ receipt }) => paidExactly(receipt, env.TREASURY_WALLET_ADDRESS, order.quoted_atomic))) continue;
      const member = await env.DB.prepare("SELECT handle FROM guild_applications WHERE status='active' ORDER BY CASE WHEN handle='mavverick-scout' THEN 1 ELSE 0 END, updated_at LIMIT 1").first();
      const now = Date.now();
      const status = member?.handle ? "queued" : "awaiting_assignment";
      await env.DB.prepare("UPDATE service_orders SET payment_status='verified',status=?,assigned_agent=?,updated_at=? WHERE id=? AND payment_status='pending_verification'")
        .bind(status, member?.handle || null, now, order.id).run();
      await env.DB.prepare("INSERT INTO order_events(order_id,kind,details,created_at) VALUES(?,'payment_verified',?,?)")
        .bind(order.id, JSON.stringify({ tx_hash: order.payment_tx_hash, confirmations: 12, independent_rpc_observations: 2, assigned_agent: member?.handle || null }), now).run();
      verified += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "order_payment_verification_deferred", order_id: order.id, message: String(error.message || error) }));
    }
  }
  return { configured: true, checked: (pending.results || []).length, verified };
}

export { SERVICES, authorizedOrder, createOrder, processPendingOrders, serviceById, submitPaymentReceipt };
