import { authorizedOrder, serviceById } from "./commerce.js";
import { hasDeliverySecret, verifySaturnShiftDelivery, SaturnShiftDeliveryError } from "./saturnshift-delivery.js";
import { authorizedSubscription, nextCalendarMonth } from "./subscriptions.js";

const SATURNSHIFT_SCRIPT_URL = "https://api.saturnshift.io/checkout.js";
const SATURNSHIFT_PROVIDER = "saturnshift";
const BASE_USDC_CONTRACT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SIGNATURE_SCHEME = "saturnshift-t-v1-hmac-sha256-raw-body-v1";
const PAYLOAD_CONTRACT = "saturnshift-transaction-object-v1";
const DOCUMENTATION_URL = "https://docs.saturnshift.io/webhooks";
const MAX_WEBHOOK_BYTES = 64 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUBSCRIPTION_REFERENCE = /^subscription_invoice:([0-9a-f-]{36})$/i;

class SaturnShiftError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function clean(value, maximum) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function html(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]);
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  })[character]);
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function atomicAmount(value) {
  const normalized = String(value ?? "");
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n || BigInt(normalized) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SaturnShiftError("invalid_order_amount", 409);
  }
  const units = BigInt(normalized);
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  const decimal = `${whole}.${fraction}`;
  const amount = Number(decimal);
  if (!Number.isFinite(amount) || amount <= 0) throw new SaturnShiftError("invalid_order_amount", 409);
  return {
    amount,
    display: `${whole}.${fraction.slice(0, 2)}${fraction.slice(2).replace(/0+$/, "")}`.replace(/\.$/, ""),
  };
}

function usdToAtomic(value) {
  let normalized;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) normalized = String(value);
  else if (typeof value === "string") normalized = value.trim();
  else throw new SaturnShiftError("invalid_provider_amount", 422);
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,6}))?$/.exec(normalized);
  if (!match) throw new SaturnShiftError("invalid_provider_amount", 422);
  return (BigInt(match[1]) * 1_000_000n + BigInt((match[2] || "").padEnd(6, "0") || "0")).toString();
}

function validPublicKey(env) {
  const key = String(env?.SATURNSHIFT_PUBLIC_KEY || "");
  return key.length >= 8 && key.length <= 512 && !/[\u0000-\u001f\u007f]/.test(key) ? key : null;
}
function fiatCheckoutReady(env){return env?.SATURNSHIFT_FIAT_WEBHOOK_STATUS==="provider_confirmed";}

function directBaseUsdcConfig(env) {
  const treasury = String(env?.TREASURY_WALLET_ADDRESS || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(treasury)) return null;
  return {
    asset: "USDC",
    network: "Base",
    chain_id: 8453,
    decimals: 6,
    token_contract: BASE_USDC_CONTRACT,
    treasury_address: treasury,
  };
}

function webhookVerificationReadiness(env) {
  const missing = [];
  if (!hasDeliverySecret(env?.SATURNSHIFT_WEBHOOK_SECRET)) missing.push("SATURNSHIFT_WEBHOOK_SECRET");
  if (env?.SATURNSHIFT_WEBHOOK_ENDPOINT_STATUS !== "registered") missing.push("SATURNSHIFT_WEBHOOK_ENDPOINT_STATUS");
  return {
    ready: missing.length === 0,
    missing,
    signature_scheme: SIGNATURE_SCHEME,
    payload_contract: PAYLOAD_CONTRACT,
    documentation_url: DOCUMENTATION_URL,
    adapter_status: "provider_documented_crypto_settlement",
  };
}

function paymentProviderOptions(env) {
  const webhook = webhookVerificationReadiness(env);
  return {
    saturnshift: {
      checkout_configured: Boolean(validPublicKey(env)),
      configured: Boolean(validPublicKey(env)) && webhook.ready,
      signed_webhook_configured: webhook.ready,
      delivery_test: { supported: true, secret_configured: hasDeliverySecret(env?.SATURNSHIFT_WEBHOOK_SECRET), payment_activation: false },
      methods: fiatCheckoutReady(env)?["card", "bank", "crypto"]:["crypto"],
      settlement_proof: "documented_signed_payment.paid_webhook_plus_exact_server_amount_and_base_usdc_fields",
      fiat_policy: "checkout offered; card and ACH fulfillment remains in review until the merchant event schema is independently confirmed",
    },
    base_usdc_direct: {
      configured: Boolean(directBaseUsdcConfig(env)),
      methods: ["base_native_usdc"],
      settlement_proof: "independent_base_receipt_verification",
    },
  };
}

function checkoutOrigin(env, requestUrl) {
  const candidate = String(env?.SATURNSHIFT_REDIRECT_ORIGIN || new URL(requestUrl).origin);
  const url = new URL(candidate);
  if (url.pathname !== "/" || url.search || url.hash || !["https:", "http:"].includes(url.protocol)) throw new SaturnShiftError("invalid_redirect_origin", 503);
  if (env?.SCOUT_ENVIRONMENT === "production" && url.protocol !== "https:") throw new SaturnShiftError("https_redirect_origin_required", 503);
  return url.origin;
}

function checkoutHeaders(nonce) {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), usb=()",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' ${SATURNSHIFT_SCRIPT_URL}; connect-src https://api.saturnshift.io; frame-src https://api.saturnshift.io; img-src 'self' data: https://api.saturnshift.io; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  };
}

function checkoutPage(order, accessToken, env, requestUrl) {
  if (!UUID.test(String(order.id || ""))) throw new SaturnShiftError("invalid_order_id", 409);
  const key = webhookVerificationReadiness(env).ready ? validPublicKey(env) : null;
  const direct = directBaseUsdcConfig(env);
  const { amount, display } = atomicAmount(order.quoted_atomic);
  const service = serviceById(order.service_id);
  const title = clean(service?.name || order.service || "MAG service order", 120);
  const redirectUrl = new URL(`/orders/${order.id}/payment-return`, checkoutOrigin(env, requestUrl)).href;
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const config = key ? {
    publicKey: key,
    amount,
    currency: "USD",
    title,
    description: `MAG order ${order.id}`,
    externalReference: order.id,
    idempotencyKey: order.id,
    redirectUrl,
    openInNewTab: false,
    allowCard: fiatCheckoutReady(env),
    allowBank: fiatCheckoutReady(env),
    allowCrypto: true,
    processingFeeEnabled: false,
  } : null;
  const saturnPanel = config
    ? `<section class="panel primary"><p class="eyebrow">Hosted checkout</p><h2>Pay $${html(display)} USD</h2><p>Choose card, ACH bank payment, or supported crypto in SaturnShift's hosted overlay.</p><button id="saturnshift-pay" type="button">Choose payment method</button><p id="checkout-error" class="error" role="alert" hidden>Hosted checkout could not load. No payment was recorded. Use the direct Base-USDC option or try again later.</p><p class="fine">Returning to MAG is not payment proof. A verified crypto payment can open work only when the provider confirms settlement as USDC on Base. Verified card or bank payment remains in payment review until an explicit USDC reserve-coverage gate is satisfied.</p></section>`
    : `<section class="panel unavailable"><h2>Hosted checkout unavailable</h2><p>The public key and verified webhook integration must both be configured. No hosted payment can be initiated.</p></section>`;
  const directPanel = direct
    ? `<section class="panel"><p class="eyebrow">Direct settlement remains available</p><h2>Pay ${html(display)} USDC on Base</h2><dl><div><dt>Treasury</dt><dd><code>${html(direct.treasury_address)}</code></dd></div><div><dt>Native USDC contract</dt><dd><code>${html(direct.token_contract)}</code></dd></div><div><dt>Chain</dt><dd>Base · 8453</dd></div></dl><p>Send exactly <strong>${html(display)} USDC</strong>, then submit the transaction hash for independent two-RPC verification.</p><p><a href="/orders/status">Open private order to submit a Base receipt</a>. Enter the order token only on that MAG-only page, which contains no third-party script.</p><p class="fine">Never enter a seed phrase, private key, wallet password, or unlimited approval.</p></section>`
    : `<section class="panel unavailable"><h2>Direct Base-USDC temporarily unavailable</h2><p>No treasury receive address is configured. Do not send funds.</p></section>`;
  const scripts = config ? `<script src="${SATURNSHIFT_SCRIPT_URL}"></script><script nonce="${nonce}">(() => { const error = document.getElementById("checkout-error"); try { if (!globalThis.SaturnShift || typeof globalThis.SaturnShift.checkout !== "function") throw new Error("checkout unavailable"); globalThis.SaturnShift.checkout(${jsonForScript(config)}, "#saturnshift-pay"); } catch (_) { document.getElementById("saturnshift-pay").disabled = true; error.hidden = false; } })();</script>` : "";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>MAG checkout · ${html(title)}</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{max-width:920px;margin:4vh auto;padding:0 22px;background:#06162c;color:#eef8ff;font:17px/1.55 system-ui,sans-serif}header,.panel{background:#0a203b;border:1px solid #2b5776;border-radius:18px;padding:24px;margin:18px 0}.primary{border-color:#10d7ec;box-shadow:0 18px 50px #00101f80}.eyebrow{color:#65e8f4;text-transform:uppercase;letter-spacing:.12em;font-size:.78rem;font-weight:800}h1,h2{line-height:1.12}button,input{font:inherit;border-radius:9px;padding:12px;border:1px solid #5f829d}button{background:#10d7ec;color:#031421;font-weight:850;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}label,form{display:grid;gap:9px}dl{display:grid;gap:10px}dl div{background:#05162a;border-radius:10px;padding:12px}dt{color:#9fb8ca}dd{margin:4px 0;overflow-wrap:anywhere}code{color:#65e8f4}.fine{color:#a9bdcc;font-size:.9rem}.error,.unavailable{color:#ffd8d8}.status{display:inline-block;padding:5px 9px;border-radius:99px;background:#183852;color:#c9eef6}</style></head><body><header><p class="eyebrow">MAG provider-aware checkout</p><h1>${html(title)}</h1><p>Order <code>${html(order.id)}</code></p><p class="status">Awaiting verified payment</p></header>${saturnPanel}${directPanel}${scripts}</body></html>`, { status: 200, headers: checkoutHeaders(nonce) });
}

async function saturnShiftCheckoutResponse(env, orderId, accessToken, requestUrl) {
  if (!env?.DB) return json({ error: "marketplace_database_not_configured" }, 503);
  const order = await authorizedOrder(env.DB, orderId, String(accessToken || ""));
  if (!order) return json({ error: "order_not_found_or_unauthorized" }, 404);
  if (order.payment_status !== "unsubmitted" || order.published_task_id) return json({ error: "order_is_not_awaiting_payment" }, 409);
  try {
    return checkoutPage(order, accessToken, env, requestUrl);
  } catch (error) {
    const status = error instanceof SaturnShiftError ? error.status : 500;
    return json({ error: error instanceof SaturnShiftError ? error.code : "checkout_configuration_error" }, status);
  }
}

function subscriptionCheckoutPage(subscription,invoice,env,requestUrl) {
  const reference=`subscription_invoice:${invoice.id}`;
  const key=webhookVerificationReadiness(env).ready?validPublicKey(env):null;
  const {amount,display}=atomicAmount(invoice.amount_atomic);
  const title=`${clean(subscription.plan_id,60)} subscription`;
  const redirectUrl=new URL(`/subscriptions/payment-return?invoice=${encodeURIComponent(invoice.id)}`,checkoutOrigin(env,requestUrl)).href;
  const nonce=crypto.randomUUID().replace(/-/g,"");
  const config=key?{publicKey:key,amount,currency:"USD",title,description:`MAG subscription invoice ${invoice.id}`,externalReference:reference,idempotencyKey:reference,redirectUrl,openInNewTab:false,allowCard:fiatCheckoutReady(env),allowBank:fiatCheckoutReady(env),allowCrypto:true,processingFeeEnabled:false}:null;
  const hosted=config?`<section class="panel primary"><p class="eyebrow">Pay MAG</p><h2>Pay $${html(display)} USD</h2><p>Choose card, ACH bank payment, or supported stablecoin in MAG's SaturnShift-hosted checkout.</p><button id="saturnshift-pay" type="button">Choose payment method</button><p id="checkout-error" class="error" role="alert" hidden>Hosted checkout could not load. No payment was recorded.</p><p class="fine">Your PSA/RMM tenant does not need a SaturnShift account. The provider is MAG's merchant payment rail only. Access changes only after a signed final payment event matches this exact server-priced invoice.</p></section>`:`<section class="panel unavailable"><h2>Hosted checkout unavailable</h2><p>MAG has not completed the signing-secret and endpoint-registration checks. No hosted payment can be initiated. Return to billing for the direct Base-USDC option.</p></section>`;
  const scripts=config?`<script src="${SATURNSHIFT_SCRIPT_URL}"></script><script nonce="${nonce}">(()=>{const e=document.getElementById("checkout-error");try{if(!globalThis.SaturnShift||typeof globalThis.SaturnShift.checkout!=="function")throw new Error("checkout unavailable");globalThis.SaturnShift.checkout(${jsonForScript(config)},"#saturnshift-pay");}catch(_){document.getElementById("saturnshift-pay").disabled=true;e.hidden=false;}})();</script>`:"";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG subscription checkout</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{max-width:820px;margin:6vh auto;padding:0 22px;background:#06162c;color:#eef8ff;font:17px/1.55 system-ui}.panel{background:#0a203b;border:1px solid #2b5776;border-radius:18px;padding:24px;margin:18px 0}.primary{border-color:#10d7ec}.eyebrow,a{color:#65e8f4}button{font:inherit;border:0;border-radius:9px;padding:13px;background:#10d7ec;color:#031421;font-weight:850}.fine{color:#a9bdcc;font-size:.9rem}.error,.unavailable{color:#ffd8d8}</style></head><body><a href="/subscriptions/billing">← Subscription billing</a><h1>${html(title)}</h1>${hosted}${scripts}</body></html>`,{status:200,headers:checkoutHeaders(nonce)});
}

async function saturnShiftSubscriptionCheckoutResponse(env,subscriptionId,invoiceId,accessToken,requestUrl){
  if(!env?.DB)return json({error:"marketplace_database_not_configured"},503);
  const subscription=await authorizedSubscription(env.DB,subscriptionId,accessToken);
  const invoice=await env.DB.prepare("SELECT id,subscription_id,amount_atomic,status FROM subscription_invoices WHERE id=? AND subscription_id=?").bind(invoiceId,subscription.id).first();
  if(!invoice||invoice.status!=="unpaid")return json({error:"subscription_invoice_not_payable"},409);
  return subscriptionCheckoutPage(subscription,invoice,env,requestUrl);
}

function saturnShiftReturnResponse(orderId) {
  const safeOrderId = UUID.test(String(orderId || "")) ? orderId : "unknown";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG payment verification</title><style>body{max-width:720px;margin:12vh auto;padding:22px;background:#06162c;color:#eef8ff;font:18px/1.6 system-ui}.card{background:#0a203b;border:1px solid #2b5776;border-radius:18px;padding:26px}code,a{color:#65e8f4}</style></head><body><main class="card"><h1>Payment verification pending</h1><p>SaturnShift returned the browser for order <code>${html(safeOrderId)}</code>. This redirect is not proof of payment and did not change the order.</p><p>MAG starts the work lifecycle only after an authenticated provider event matches the exact order ID, idempotency key, currency, amount, payment method, and USDC-on-Base settlement fields. Card or bank payments remain in reserve review and do not publish work automatically.</p><a href="/work">View open work</a></main></body></html>`, {
    status: 202,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function saturnShiftSubscriptionReturnResponse(invoiceId){
  const safeInvoiceId=UUID.test(String(invoiceId||""))?invoiceId:"unknown";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG subscription payment verification</title><style>body{max-width:720px;margin:12vh auto;padding:22px;background:#06162c;color:#eef8ff;font:18px/1.6 system-ui}.card{background:#0a203b;border:1px solid #2b5776;border-radius:18px;padding:26px}code,a{color:#65e8f4}</style></head><body><main class="card"><h1>Payment verification pending</h1><p>SaturnShift returned the browser for subscription invoice <code>${html(safeInvoiceId)}</code>. This redirect is not payment proof and did not change access.</p><p>MAG updates the subscription only after a signed final provider event matches the exact server-priced invoice.</p><a href="/subscriptions/billing">Return to billing</a></main></body></html>`,{status:202,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"}});
}

async function readLimitedBody(request, maximum = MAX_WEBHOOK_BYTES) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new SaturnShiftError("webhook_body_too_large", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel("body too large");
      throw new SaturnShiftError("webhook_body_too_large", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifyWebhook(request, env) {
  const readiness = webhookVerificationReadiness(env);
  if (!readiness.ready) throw new SaturnShiftError("saturnshift_webhook_verification_not_configured", 503);
  const signatureValue = request.headers.get(env.SATURNSHIFT_WEBHOOK_SIGNATURE_HEADER);
  const timestampValue = request.headers.get(env.SATURNSHIFT_WEBHOOK_TIMESTAMP_HEADER);
  const signatureMatch = /^sha256=([0-9a-f]{64})$/i.exec(String(signatureValue || ""));
  const signature = signatureMatch ? hexToBytes(signatureMatch[1]) : null;
  if (!signature || !/^\d{10}$/.test(String(timestampValue || ""))) throw new SaturnShiftError("invalid_saturnshift_webhook_signature", 401);
  const timestamp = Number(timestampValue);
  const configuredTolerance = Number(env.SATURNSHIFT_WEBHOOK_TOLERANCE_SECONDS || 300);
  const tolerance = Number.isInteger(configuredTolerance) ? Math.min(900, Math.max(60, configuredTolerance)) : 300;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) throw new SaturnShiftError("stale_saturnshift_webhook", 401);
  const body = await readLimitedBody(request);
  const timestampBytes = new TextEncoder().encode(`${timestampValue}.`);
  const signed = new Uint8Array(timestampBytes.byteLength + body.byteLength);
  signed.set(timestampBytes);
  signed.set(body, timestampBytes.byteLength);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SATURNSHIFT_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("HMAC", key, signature, signed))) throw new SaturnShiftError("invalid_saturnshift_webhook_signature", 401);
  return {
    body,
    bodySha256: await sha256Hex(body),
    signatureSha256: await sha256Hex(String(signatureValue)),
    signatureScheme: SIGNATURE_SCHEME,
  };
}

function providerIdentifier(value, code) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new SaturnShiftError(code, 422);
  return normalized;
}

function parsePaymentEvent(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== "object" || !payload.data || Array.isArray(payload.data) || typeof payload.data !== "object") {
    throw new SaturnShiftError("invalid_saturnshift_payload_contract", 422);
  }
  const data=payload.data;
  if(data.object!=="transaction"||!data.amount||typeof data.amount!=="object"||!data.networks||typeof data.networks!=="object")throw new SaturnShiftError("invalid_saturnshift_payload_contract",422);
  const amountStatus=providerIdentifier(data.amount_status,"invalid_saturnshift_amount_status").toUpperCase();
  return {
    eventId: providerIdentifier(payload.id, "invalid_saturnshift_event_id"),
    eventType: providerIdentifier(payload.type, "invalid_saturnshift_event_type"),
    paymentId: providerIdentifier(data.id, "invalid_saturnshift_payment_id"),
    status: providerIdentifier(data.status, "invalid_saturnshift_payment_status"),
    amountAtomic: usdToAtomic(data.amount.gross),
    amountStatus,
    currency: providerIdentifier(data.currency, "invalid_saturnshift_currency").toUpperCase(),
    paymentMethod: "crypto",
    settlementAsset: providerIdentifier(data.asset, "invalid_saturnshift_settlement_asset").toUpperCase(),
    settlementNetwork: providerIdentifier(data.networks.settlement, "invalid_saturnshift_settlement_network"),
    externalReference: providerIdentifier(data.external_reference, "invalid_saturnshift_external_reference"),
    idempotencyKey: providerIdentifier(data.external_reference, "invalid_saturnshift_idempotency_key"),
  };
}

function duplicateConstraint(error) {
  return /(?:unique|constraint).*payment_provider|payment_provider.*(?:unique|constraint)/i.test(String(error?.message || error));
}

async function duplicateEventResult(db, event, verification) {
  const existing = await db.prepare("SELECT event_id,order_id,payment_id,body_sha256,processing_status FROM payment_provider_events WHERE provider='saturnshift' AND event_id=?").bind(event.eventId).first();
  if (existing && existing.body_sha256 === verification.bodySha256 && existing.order_id === event.externalReference && existing.payment_id === event.paymentId && existing.processing_status === "applied") {
    const order = await db.prepare("SELECT published_task_id FROM service_orders WHERE id=? AND payment_provider='saturnshift' AND provider_payment_id=? AND payment_status='verified'").bind(event.externalReference, event.paymentId).first();
    if (order?.published_task_id) return { duplicate: true, task_id: order.published_task_id, payment_status: "verified", reserve_required: false };
  }
  if (existing && existing.body_sha256 === verification.bodySha256 && existing.order_id === event.externalReference && existing.payment_id === event.paymentId && existing.processing_status === "accepted_pending_reserve") {
    const order = await db.prepare("SELECT payment_status FROM service_orders WHERE id=? AND payment_provider='saturnshift' AND provider_payment_id=? AND payment_status='paid_fiat_pending_usdc_reserve'").bind(event.externalReference, event.paymentId).first();
    if (order) return { duplicate: true, task_id: null, payment_status: order.payment_status, reserve_required: true };
  }
  return null;
}

async function applyVerifiedPayment(db, event, verification, env) {
  const duplicate = await duplicateEventResult(db, event, verification);
  if (duplicate) return duplicate;
  const order = await db.prepare("SELECT id,service_id,objective,acceptance_criteria,target_scope,execution_mode,quoted_atomic,payment_status,status,payment_tx_hash,published_task_id FROM service_orders WHERE id=?").bind(event.externalReference).first();
  if (!order) throw new SaturnShiftError("saturnshift_order_not_found", 422);
  if (event.idempotencyKey !== order.id || event.externalReference !== order.id) throw new SaturnShiftError("saturnshift_order_identity_mismatch", 422);
  if (event.currency !== "USD" || event.amountAtomic !== order.quoted_atomic || event.amountStatus!=="EXACT") throw new SaturnShiftError("saturnshift_payment_amount_mismatch", 422);
  if (event.eventType !== "payment.paid" || event.status !== "paid") throw new SaturnShiftError("saturnshift_event_is_not_final_payment", 202);
  const cryptoMethod = "crypto";
  const fiatMethods = [];
  if (event.paymentMethod !== cryptoMethod && !fiatMethods.includes(event.paymentMethod)) throw new SaturnShiftError("unsupported_saturnshift_payment_method", 422);
  const settlesBaseUsdc = event.paymentMethod === cryptoMethod
    && event.settlementAsset === "USDC"
    && event.settlementNetwork.toLowerCase() === "base";
  if (event.paymentMethod === cryptoMethod && !settlesBaseUsdc) throw new SaturnShiftError("saturnshift_crypto_settlement_is_not_base_usdc", 422);
  if (order.payment_status !== "unsubmitted" || order.status !== "awaiting_payment" || order.payment_tx_hash || order.published_task_id) throw new SaturnShiftError("order_payment_already_in_progress", 409);
  const service = serviceById(order.service_id);
  if (!service) throw new SaturnShiftError("unsupported_service", 409);
  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + 30 * 24 * 60 * 60;
  const description = `Objective:\n${order.objective}\n\nAuthorized target scope:\n${order.target_scope}\n\nExecution mode: ${order.execution_mode}`;
  const gross = BigInt(order.quoted_atomic);
  const platformFee = gross * 1500n / 10000n;
  const economics = {
    gross_atomic: gross.toString(),
    platform_fee_atomic: platformFee.toString(),
    worker_payout_atomic: (gross - platformFee).toString(),
    platform_fee_bps: 1500,
  };
  const providerDetails = {
    provider: SATURNSHIFT_PROVIDER,
    event_id: event.eventId,
    event_type: event.eventType,
    payment_id: event.paymentId,
    external_reference: event.externalReference,
    idempotency_key: event.idempotencyKey,
    amount_atomic: event.amountAtomic,
    currency: event.currency,
    payment_method: event.paymentMethod,
    settlement_asset: event.settlementAsset,
    settlement_network: event.settlementNetwork,
    provider_status: event.status,
    body_sha256: verification.bodySha256,
    signature_scheme: verification.signatureScheme,
    signature_adapter: "provider_documented",
    provider_documentation_url: DOCUMENTATION_URL,
  };
  let results;
  try {
    const eventStatement = db.prepare("INSERT INTO payment_provider_events(provider,event_id,event_type,order_id,payment_id,signature_scheme,signature_sha256,body_sha256,processing_status,details,received_at) SELECT 'saturnshift',?,?,?,?,?,?,?,'verified_pending_apply',?,? FROM service_orders WHERE id=? AND payment_status='unsubmitted' AND status='awaiting_payment' AND payment_tx_hash IS NULL AND published_task_id IS NULL")
      .bind(event.eventId, event.eventType, order.id, event.paymentId, verification.signatureScheme, verification.signatureSha256, verification.bodySha256, JSON.stringify(providerDetails), now, order.id);
    const claimStatement = db.prepare("INSERT INTO payment_provider_receipt_claims(provider,payment_id,purpose_type,purpose_id,event_id,created_at) SELECT 'saturnshift',?,'service_order',?,?,? WHERE EXISTS (SELECT 1 FROM payment_provider_events WHERE provider='saturnshift' AND event_id=? AND order_id=? AND payment_id=? AND processing_status='verified_pending_apply') AND EXISTS (SELECT 1 FROM service_orders WHERE id=? AND payment_status='unsubmitted' AND status='awaiting_payment' AND payment_tx_hash IS NULL AND published_task_id IS NULL)")
      .bind(event.paymentId, order.id, event.eventId, now, event.eventId, order.id, event.paymentId, order.id);
    if (settlesBaseUsdc) {
      results = await db.batch([
        eventStatement,
        claimStatement,
        db.prepare("INSERT INTO tasks(title,description,acceptance_criteria,category,reward_atomic,platform_fee_bps,status,fulfillment_mode,created_at,expires_at) SELECT ?,?,?,?,quoted_atomic,1500,'open','digital',?,? FROM service_orders WHERE id=? AND payment_status='unsubmitted' AND status='awaiting_payment' AND payment_tx_hash IS NULL AND published_task_id IS NULL AND EXISTS (SELECT 1 FROM payment_provider_events WHERE provider='saturnshift' AND event_id=? AND order_id=service_orders.id AND processing_status='verified_pending_apply') AND EXISTS (SELECT 1 FROM payment_provider_receipt_claims WHERE provider='saturnshift' AND payment_id=? AND purpose_type='service_order' AND purpose_id=service_orders.id)")
          .bind(service.name, description, order.acceptance_criteria, service.category, now, expiresAt, order.id, event.eventId, event.paymentId),
        db.prepare("UPDATE service_orders SET payment_provider='saturnshift',provider_payment_id=?,provider_payment_status=?,provider_external_reference=?,provider_idempotency_key=?,provider_verified_at=?,provider_verification_event_id=?,payment_status='verified',status='open',assigned_agent=NULL,published_task_id=last_insert_rowid(),updated_at=? WHERE id=? AND payment_status='unsubmitted' AND status='awaiting_payment' AND payment_tx_hash IS NULL AND published_task_id IS NULL AND EXISTS (SELECT 1 FROM tasks WHERE id=last_insert_rowid() AND created_at=?) AND EXISTS (SELECT 1 FROM payment_provider_receipt_claims WHERE provider='saturnshift' AND payment_id=? AND purpose_id=service_orders.id)")
          .bind(event.paymentId, event.status, event.externalReference, event.idempotencyKey, now, event.eventId, now, order.id, now, event.paymentId),
        db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) SELECT id,'saturnshift_payment_verified_and_task_published',?,? FROM service_orders WHERE id=? AND payment_provider='saturnshift' AND provider_payment_id=? AND provider_verification_event_id=? AND payment_status='verified' AND published_task_id=last_insert_rowid()")
          .bind(JSON.stringify({ ...providerDetails, economics, payout_authority: "owner_signature_required" }), now, order.id, event.paymentId, event.eventId),
        db.prepare("UPDATE payment_provider_events SET processing_status='applied',processed_at=? WHERE provider='saturnshift' AND event_id=? AND EXISTS (SELECT 1 FROM service_orders WHERE id=? AND payment_status='verified' AND provider_verification_event_id=?)")
          .bind(now, event.eventId, order.id, event.eventId),
      ]);
    } else {
      results = await db.batch([
        eventStatement,
        claimStatement,
        db.prepare("UPDATE service_orders SET payment_provider='saturnshift',provider_payment_id=?,provider_payment_status=?,provider_external_reference=?,provider_idempotency_key=?,provider_verified_at=?,provider_verification_event_id=?,payment_status='paid_fiat_pending_usdc_reserve',status='payment_review',assigned_agent=NULL,updated_at=? WHERE id=? AND payment_status='unsubmitted' AND status='awaiting_payment' AND payment_tx_hash IS NULL AND published_task_id IS NULL AND EXISTS (SELECT 1 FROM payment_provider_events WHERE provider='saturnshift' AND event_id=? AND order_id=service_orders.id AND processing_status='verified_pending_apply') AND EXISTS (SELECT 1 FROM payment_provider_receipt_claims WHERE provider='saturnshift' AND payment_id=? AND purpose_id=service_orders.id)")
          .bind(event.paymentId, event.status, event.externalReference, event.idempotencyKey, now, event.eventId, now, order.id, event.eventId, event.paymentId),
        db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) SELECT id,'saturnshift_fiat_paid_pending_usdc_reserve',?,? FROM service_orders WHERE id=? AND payment_provider='saturnshift' AND provider_payment_id=? AND provider_verification_event_id=? AND payment_status='paid_fiat_pending_usdc_reserve' AND published_task_id IS NULL")
          .bind(JSON.stringify({ ...providerDetails, task_publication: false, reserve_coverage: "required_before_task_publication", payout_authority: "owner_signature_required" }), now, order.id, event.paymentId, event.eventId),
        db.prepare("UPDATE payment_provider_events SET processing_status='accepted_pending_reserve',processed_at=? WHERE provider='saturnshift' AND event_id=? AND EXISTS (SELECT 1 FROM service_orders WHERE id=? AND payment_status='paid_fiat_pending_usdc_reserve' AND provider_verification_event_id=?)")
          .bind(now, event.eventId, order.id, event.eventId),
      ]);
    }
  } catch (error) {
    if (duplicateConstraint(error)) {
      const replay = await duplicateEventResult(db, event, verification);
      if (replay) return replay;
      throw new SaturnShiftError("saturnshift_payment_or_event_already_claimed", 409);
    }
    throw error;
  }
  const requiredIndexes = settlesBaseUsdc ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4];
  if (requiredIndexes.some((index) => Number(results?.[index]?.meta?.changes || 0) !== 1)) {
    const replay = await duplicateEventResult(db, event, verification);
    if (replay) return replay;
    throw new SaturnShiftError("saturnshift_payment_state_conflict", 409);
  }
  return settlesBaseUsdc
    ? { duplicate: false, task_id: results?.[2]?.meta?.last_row_id, payment_status: "verified", reserve_required: false }
    : { duplicate: false, task_id: null, payment_status: "paid_fiat_pending_usdc_reserve", reserve_required: true };
}

async function duplicateSubscriptionPayment(db,event,verification,invoiceId){
  const claim=await db.prepare("SELECT details FROM subscription_events WHERE event_key=? AND kind='saturnshift_event_claimed'").bind(`saturnshift:event:${event.eventId}`).first();
  if(!claim)return null;
  let details;try{details=JSON.parse(claim.details);}catch{return null;}
  const invoice=await db.prepare("SELECT i.status,i.subscription_id FROM subscription_invoices i WHERE i.id=?").bind(invoiceId).first();
  if(details.body_sha256===verification.bodySha256&&details.payment_id===event.paymentId&&details.invoice_id===invoiceId&&invoice?.status==="paid")return {duplicate:true,subscription_id:invoice.subscription_id,invoice_id:invoiceId,payment_status:"verified"};
  return null;
}

async function applyVerifiedSubscriptionPayment(db,event,verification){
  const match=SUBSCRIPTION_REFERENCE.exec(event.externalReference);
  if(!match)throw new SaturnShiftError("saturnshift_subscription_reference_invalid",422);
  const invoiceId=match[1];
  const duplicate=await duplicateSubscriptionPayment(db,event,verification,invoiceId);if(duplicate)return duplicate;
  const row=await db.prepare("SELECT i.id,i.subscription_id,i.amount_atomic,i.status,s.tenant_id,s.paid_through FROM subscription_invoices i JOIN managed_subscriptions s ON s.id=i.subscription_id WHERE i.id=?").bind(invoiceId).first();
  if(!row)throw new SaturnShiftError("saturnshift_subscription_invoice_not_found",422);
  if(event.idempotencyKey!==event.externalReference||event.currency!=="USD"||event.amountAtomic!==row.amount_atomic||event.amountStatus!=="EXACT")throw new SaturnShiftError("saturnshift_payment_amount_mismatch",422);
  if(event.eventType!=="payment.paid"||event.status!=="paid")throw new SaturnShiftError("saturnshift_event_is_not_final_payment",202);
  if(event.paymentMethod!=="crypto"||event.settlementAsset!=="USDC"||event.settlementNetwork.toLowerCase()!=="base")throw new SaturnShiftError("saturnshift_crypto_settlement_is_not_base_usdc",422);
  if(row.status!=="unpaid")throw new SaturnShiftError("subscription_invoice_payment_already_in_progress",409);
  const now=Date.now(),start=Math.max(now,Number(row.paid_through||0)),end=nextCalendarMonth(start);
  const details={provider:SATURNSHIFT_PROVIDER,event_id:event.eventId,event_type:event.eventType,payment_id:event.paymentId,invoice_id:invoiceId,subscription_id:row.subscription_id,external_reference:event.externalReference,amount_atomic:event.amountAtomic,currency:event.currency,settlement_asset:event.settlementAsset,settlement_network:event.settlementNetwork,body_sha256:verification.bodySha256,signature_scheme:verification.signatureScheme,provider_documentation_url:DOCUMENTATION_URL};
  let results;
  try{results=await db.batch([
    db.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) SELECT ? ,?,'saturnshift_event_claimed',?,? WHERE EXISTS(SELECT 1 FROM subscription_invoices WHERE id=? AND status='unpaid')").bind(row.subscription_id,`saturnshift:event:${event.eventId}`,JSON.stringify(details),now,invoiceId),
    db.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) SELECT ?,?,'saturnshift_payment_claimed',?,? WHERE EXISTS(SELECT 1 FROM subscription_events WHERE event_key=?) AND EXISTS(SELECT 1 FROM subscription_invoices WHERE id=? AND status='unpaid')").bind(row.subscription_id,`saturnshift:payment:${event.paymentId}`,JSON.stringify(details),now,`saturnshift:event:${event.eventId}`,invoiceId),
    db.prepare("UPDATE subscription_invoices SET status='paid',period_start=?,period_end=?,verified_at=? WHERE id=? AND status='unpaid' AND EXISTS(SELECT 1 FROM subscription_events WHERE event_key=?)").bind(start,end,now,invoiceId,`saturnshift:payment:${event.paymentId}`),
    db.prepare("UPDATE managed_subscriptions SET status='active',paid_through=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM subscription_invoices WHERE id=? AND status='paid')").bind(end,now,row.subscription_id,invoiceId),
    db.prepare("UPDATE managed_tenants SET status='active',updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM subscription_invoices WHERE id=? AND status='paid')").bind(now,row.tenant_id,invoiceId),
    db.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) SELECT ?,?,'saturnshift_payment_verified',?,? WHERE EXISTS(SELECT 1 FROM subscription_invoices WHERE id=? AND status='paid')").bind(row.subscription_id,`${invoiceId}:saturnshift:paid`,JSON.stringify({...details,period_start:start,period_end:end,automatic_debit:false}),now,invoiceId),
  ]);}catch(error){const replay=await duplicateSubscriptionPayment(db,event,verification,invoiceId);if(replay)return replay;if(/unique|constraint/i.test(String(error?.message||error)))throw new SaturnShiftError("saturnshift_payment_or_event_already_claimed",409);throw error;}
  if([0,1,2,3,4,5].some(index=>Number(results?.[index]?.meta?.changes||0)!==1))throw new SaturnShiftError("saturnshift_payment_state_conflict",409);
  return {duplicate:false,subscription_id:row.subscription_id,invoice_id:invoiceId,payment_status:"verified"};
}

async function handleSaturnShiftWebhook(request, env) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) return json({ error: "application_json_required" }, 415);
  try {
    if (request.headers.has("SaturnShift-Signature")) {
      const delivery = await verifySaturnShiftDelivery(request, env?.SATURNSHIFT_WEBHOOK_SECRET);
      if (delivery.type === "webhook.test") {
        return json({ received: true, signature_verified: true, test_event: true, applied: false, payment_intake_enabled: false });
      }
      if (!env?.DB) return json({ error: "marketplace_database_not_configured" }, 503);
      const event=parsePaymentEvent(delivery.payload);
      if(SUBSCRIPTION_REFERENCE.test(event.externalReference)){
        const result=await applyVerifiedSubscriptionPayment(env.DB,event,delivery);
        return json({received:true,signature_verified:true,duplicate:result.duplicate,subscription_id:result.subscription_id,invoice_id:result.invoice_id,payment_status:result.payment_status},200);
      }
      const result=await applyVerifiedPayment(env.DB,event,delivery,env);
      return json({received:true,signature_verified:true,duplicate:result.duplicate,order_id:event.externalReference,payment_status:result.payment_status,task_id:result.task_id,reserve_required:result.reserve_required},200);
    }
    const readiness=webhookVerificationReadiness(env);
    if(!readiness.ready)return json({error:"saturnshift_webhook_verification_not_configured"},503);
    return json({error:"invalid_saturnshift_delivery_signature"},401);
  } catch (error) {
    if (error instanceof SaturnShiftDeliveryError) return json({ error: error.code }, error.status);
    if (error instanceof SaturnShiftError) {
      if (error.status === 202) return json({ received: true, signature_verified: true, applied: false, reason: error.code }, 202);
      return json({ error: error.code }, error.status);
    }
    console.error(JSON.stringify({ event: "saturnshift_webhook_error", message: String(error?.message || error) }));
    return json({ error: "saturnshift_webhook_processing_failed" }, 500);
  }
}

export {
  BASE_USDC_CONTRACT,
  PAYLOAD_CONTRACT,
  SATURNSHIFT_SCRIPT_URL,
  SIGNATURE_SCHEME,
  handleSaturnShiftWebhook,
  paymentProviderOptions,
  saturnShiftCheckoutResponse,
  saturnShiftSubscriptionCheckoutResponse,
  saturnShiftReturnResponse,
  saturnShiftSubscriptionReturnResponse,
  webhookVerificationReadiness,
};
