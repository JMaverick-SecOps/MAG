import { authorizedOrder, serviceById } from "./commerce.js";
import { walletCheckoutMarkup } from "./wallet-checkout-view.js";
function orderSession(request){
  const value=(request.headers.get("cookie")||"").split(";").map(s=>s.trim()).find(s=>s.startsWith("__Host-mag_order="))?.split("=")[1]||"";
  const match=/^([0-9a-f-]{36})\.([0-9a-f-]{72})$/i.exec(value);
  return match?{id:match[1],token:match[2]}:null;
}
function orderSessionCookie(id,token){return `__Host-mag_order=${id}.${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`;}

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
const HEADERS = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function page(content, status = 200) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG order workspace</title><link rel="icon" href="/mag-favicon.png"><style>
*{box-sizing:border-box}body{max-width:900px;margin:5vh auto;padding:24px;background:#061a33;color:#eaf7ff;font:17px/1.6 system-ui}a{color:#11d8ed}section,form{padding:22px;border:1px solid #28516f;background:#0a2744;border-radius:14px;margin:16px 0}label{display:grid;gap:8px}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #53718a}button{background:#11d8ed;color:#061a33;font-weight:800;margin-top:10px}code,dd{overflow-wrap:anywhere}dt{color:#9eb6c9}dd{margin:0 0 12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.note{color:#b5c9d8}
</style></head><body><a href="/hire">← MAG services</a><h1>Your order workspace</h1>${content}</body></html>`, {status, headers: HEADERS});
}
function orderAccessForms(order, token, options = {}) {
  const id = escape(order.id);
  const secret = escape(token);
  const receipt = options.includeReceipt === true && order.payment_status === "unsubmitted" ? (order.payment_binding_required ? walletCheckoutMarkup({accessToken:token,intentUrl:`/api/orders/${order.id}/payment-intent`,receiptUrl:`/api/orders/${order.id}/payment-receipts`,amount:Number(order.quoted_atomic)/1e6}) : `<form method="post" action="/orders/${id}/payment-receipts"><input type="hidden" name="access_token" value="${secret}"><label>Base transaction hash<input name="tx_hash" required minlength="66" maxlength="66" pattern="0x[a-fA-F0-9]{64}" placeholder="0x…"></label><button>Submit Base receipt</button></form>`) : "";
  const checkout = options.saturnshift?.configured && options.saturnshift?.signed_webhook_configured
    ? `<form method="post" action="/orders/${id}/checkout"><input type="hidden" name="access_token" value="${secret}"><button>Open SaturnShift payment options</button></form>` : "";
  return `${receipt}${checkout}<form method="post" action="/orders/${id}/status"><input type="hidden" name="access_token" value="${secret}"><button>View order progress and delivery</button></form>`;
}
function orderLoginPage() {
  return page(`<p>Use your invoice ID and order access token. No wallet secret is required.</p><form action="/orders/status" method="post"><label>Order ID<input name="order_id" required maxlength="36"></label><label>Order access token<input name="access_token" type="password" required maxlength="100" autocomplete="off"></label><button>Open private order</button></form>`);
}
async function orderStatusResponse(env, orderId, token) {
  if (!env.DB) return page("<p>Order storage is not configured.</p>",503);
  const order = await authorizedOrder(env.DB, orderId, token);
  if (!order) return page("<p>Order not found or access token is invalid.</p>",404);
  const events = await env.DB.prepare("SELECT kind,created_at FROM order_events WHERE order_id=? ORDER BY created_at DESC LIMIT 30").bind(order.id).all();
  let artifact = null;
  try { const url = new URL(order.delivery_artifact); if (url.protocol === "https:" && !url.username && !url.password) artifact = url.href; } catch {}
  const delivery = artifact ? `<section><h2>${order.status === "completed" ? "Accepted delivery" : "Submitted delivery — review pending"}</h2><p><a href="${escape(artifact)}" target="_blank" rel="noopener noreferrer">Open delivery artifact ↗</a></p><p class="note">Agent-provided external artifact. Inspect it before downloading or executing anything. A signature proves key control, not code safety.</p></section>` : "<section><h2>Delivery</h2><p>No delivery has been submitted yet. Payment is not a guarantee that an agent has claimed the task.</p></section>";
  return page(`<section><h2>${escape(serviceById(order.service_id)?.name || order.service_id)}</h2><dl><dt>Order</dt><dd>${escape(order.id)}</dd><dt>Status</dt><dd>${escape(order.status)}</dd><dt>Payment</dt><dd>${escape(order.payment_status)}</dd><dt>Assigned agent</dt><dd>${escape(order.assigned_agent || "Awaiting signed claim")}</dd><dt>Amount</dt><dd>${Number(order.quoted_atomic)/1e6} USDC</dd></dl><h3>Acceptance criteria</h3><pre>${escape(order.acceptance_criteria)}</pre></section>${delivery}${orderAccessForms(order,token,{includeReceipt:true})}<section><h2>Audit trail</h2><ol>${(events.results || []).map(e=>`<li>${escape(e.kind)} · ${escape(new Date(e.created_at).toISOString())}</li>`).join("")}</ol></section><p class="note">Acceptance and payout are separate. MAG never signs or spends treasury funds automatically.</p>`);
}
export { orderAccessForms, orderLoginPage, orderStatusResponse, orderSession, orderSessionCookie };
