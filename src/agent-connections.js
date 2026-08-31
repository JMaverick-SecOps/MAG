import { USDC, transferRequest, verifyPaymentIntent } from "./payment-intents.js";
import { recentHostedRuns } from "./hosted-agent.js";

const DAY = 86400000;
const AMOUNT = "1000000";
const TERMS = "mag-agent-connection-work-watch-24h-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ACTIONS = new Set(["invoice", "receipt", "status"]);

function database(env) { return env.DB.withSession ? env.DB.withSession("first-primary") : env.DB; }
function enabled(env) { return env.MAG_AGENT_CONNECTIONS_ENABLED === "true" && Boolean(env.DB); }
function normalized(input, now) {
  const action = input.action, handle = String(input.handle || ""), id = String(input.invoice_id || "");
  const signedAt = Number(input.signed_at), tx = String(input.tx_hash || "");
  if (!ACTIONS.has(action) || !HANDLE.test(handle) || !UUID.test(id)) throw new Error("invalid signed request");
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > 300000) throw new Error("signature expired");
  if ((action === "receipt" && !HASH.test(tx)) || (action !== "receipt" && tx)) throw new Error("invalid receipt field");
  return { action, handle, invoice_id: id, tx_hash: tx, signed_at: signedAt };
}
function connectionPreimage(input, treasury) {
  return "mag.agent-connection.v1:" + JSON.stringify([
    input.action, input.handle, input.invoice_id, input.tx_hash, input.signed_at,
    TERMS, 8453, USDC, treasury.toLowerCase(), AMOUNT, DAY
  ]);
}
async function boundedJson(response, maximum = 65536) {
  if (!response.ok || !response.body) throw new Error("upstream unavailable");
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > maximum) throw new Error("body too large");
      chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function decode(value, size) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) throw new Error("invalid signature encoding");
  const s = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bytes = Uint8Array.from(atob(s + "=".repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
  if (bytes.length !== size) throw new Error("invalid signature length");
  return bytes;
}
async function member(db, handle) {
  return db.prepare("SELECT handle FROM guild_applications WHERE handle=? AND status='active' AND registry_verified_at IS NOT NULL").bind(handle).first();
}
async function requestContext(env, input, now) {
  if (!enabled(env)) throw new Error("agent connection checkout disabled");
  const data = normalized(input, now), db = database(env);
  if (data.action === "invoice" && env.MAG_HOSTED_WORK_WATCH_ENABLED !== "true") throw new Error("hosted work-watch unavailable");
  if (!await member(db, data.handle)) throw new Error("approved verified MAG member required");
  const invoice = await db.prepare("SELECT * FROM agent_connection_invoices WHERE id=?").bind(data.invoice_id).first();
  if (invoice && invoice.handle !== data.handle) throw new Error("invoice unavailable");
  if (!invoice && data.action !== "invoice") throw new Error("invoice unavailable");
  const treasury = invoice?.treasury_address || String(env.TREASURY_WALLET_ADDRESS || "").toLowerCase();
  // Validate the merchant recipient and exact transfer before exposing a request.
  const payment = await transferRequest("agent_connection_day", data.invoice_id, treasury, AMOUNT);
  return { data, db, invoice, treasury, payment, preimage: connectionPreimage(data, treasury) };
}
async function signingPayload(env, input, now = Date.now()) {
  const context = await requestContext(env, { ...input, signed_at: now }, now);
  return { ...context.data, preimage: context.preimage, terms: TERMS, amount_atomic: AMOUNT,
    duration_ms: DAY, chain_id: 8453, token_contract: USDC, treasury_address: context.treasury,
    automatic_debit: false, instruction: "Sign this exact MAG message with your active citizen Ed25519 key locally. Never send a private key or citizen secret. This is not a 1F916 payment or an affiliation claim." };
}
async function authorize(context, signature, fetcher) {
  const payload = await boundedJson(await fetcher("https://1f916.ai/api/keys/" + encodeURIComponent(context.data.handle),
    { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15000) }));
  const bytes = decode(signature, 64), message = new TextEncoder().encode(context.preimage);
  for (const entry of (Array.isArray(payload.keys) ? payload.keys : []).slice(0, 32)) {
    if (entry.status !== "active") continue;
    try {
      const key = await crypto.subtle.importKey("raw", decode(entry.public_key || entry.x, 32), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify("Ed25519", key, bytes, message)) return;
    } catch {}
  }
  throw new Error("invalid active citizen signature");
}
async function connectionState(db, handle, now) {
  const row = await db.prepare("SELECT MAX(period_end) AS paid_through FROM agent_connection_invoices WHERE handle=? AND status='paid'").bind(handle).first();
  const approved = Boolean(await member(db, handle)), through = Number(row?.paid_through || 0);
  return { handle, approved_member: approved, connected: approved && through > now, paid_through: through || null,
    automatic_debit: false, contributor_activation: false };
}
async function operateConnection(env, input, fetcher = fetch, now = Date.now()) {
  const c = await requestContext(env, input, now);
  await authorize(c, input.signature, fetcher);
  const { db, data, payment } = c;
  if (data.action === "invoice" && !c.invoice) {
    // Both the open-invoice limit and daily cap are evaluated inside the write.
    await db.prepare("INSERT INTO agent_connection_invoices(id,handle,amount_atomic,treasury_address,calldata,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM guild_applications WHERE handle=? AND status='active' AND registry_verified_at IS NOT NULL) AND (SELECT COUNT(*) FROM agent_connection_invoices WHERE handle=? AND created_at>?)<10 AND NOT EXISTS(SELECT 1 FROM agent_connection_invoices WHERE handle=? AND status<>'paid') ON CONFLICT DO NOTHING")
      .bind(data.invoice_id, data.handle, AMOUNT, c.treasury, payment.data, now, data.handle, data.handle, now-DAY, data.handle).run();
  }
  let invoice = await db.prepare("SELECT * FROM agent_connection_invoices WHERE id=? AND handle=?").bind(data.invoice_id, data.handle).first();
  if (!invoice) throw new Error("reuse the existing invoice or wait for the daily cap");
  if (data.action === "receipt" && invoice.status !== "paid") {
    // Pending hashes reserve no global claim. Invalid hashes cannot steal somebody else's payment.
    await db.prepare("UPDATE agent_connection_invoices SET tx_hash=?,status='pending_verification' WHERE id=? AND status<>'paid' AND EXISTS(SELECT 1 FROM guild_applications WHERE handle=? AND status='active')")
      .bind(data.tx_hash, invoice.id, data.handle).run();
  } else if (data.action === "receipt" && invoice.tx_hash !== data.tx_hash) {
    throw new Error("invoice already paid by another receipt");
  }
  invoice = await db.prepare("SELECT * FROM agent_connection_invoices WHERE id=?").bind(invoice.id).first();
  return { invoice, connection: await connectionState(db, data.handle, now),
    hosted_runs: await recentHostedRuns(db, data.handle),
    payment_request: invoice.status === "unpaid" ? payment : null,
    next: invoice.status === "paid" ? "connection credited" : "Submit the bound transaction hash; background verification credits one 24-hour period. Never transfer twice because verification is pending." };
}
async function processAgentConnections(env, fetcher = fetch, now = Date.now()) {
  if (!enabled(env)) return { enabled: false, checked: 0, credited: 0 };
  const db = database(env);
  const pending = await db.prepare("SELECT * FROM agent_connection_invoices WHERE status='pending_verification' ORDER BY COALESCE(last_checked_at,0),created_at LIMIT 5").all();
  let credited = 0;
  for (const invoice of pending.results || []) {
    try {
      await db.prepare("UPDATE agent_connection_invoices SET last_checked_at=? WHERE id=? AND status='pending_verification'").bind(now, invoice.id).run();
      const proof = await verifyPaymentIntent(invoice, invoice.tx_hash, fetcher, { ...env, DB:db });
      if (!proof.verified) continue;
      // All accounting and the notification are one transaction. A stale receipt,
      // replay or cross-purpose claim rolls everything back, including the credit.
      await db.batch([
        db.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) VALUES(?,'agent_connection_day',?,?)").bind(invoice.tx_hash, invoice.id, now),
        db.prepare("UPDATE agent_connection_invoices SET status='paid',period_start=MAX(?,COALESCE((SELECT MAX(period_end) FROM agent_connection_invoices WHERE handle=? AND status='paid'),0)),period_end=MAX(?,COALESCE((SELECT MAX(period_end) FROM agent_connection_invoices WHERE handle=? AND status='paid'),0))+86400000,verified_at=? WHERE id=? AND status='pending_verification' AND tx_hash=?")
          .bind(now, invoice.handle, now, invoice.handle, now, invoice.id, invoice.tx_hash),
        db.prepare("INSERT INTO notification_events(id,dedupe_key,kind,subject,message,created_at) VALUES(?,?,CASE WHEN changes()=1 THEN 'agent_connection_paid' ELSE NULL END,?,?,?)")
          .bind(crypto.randomUUID(), "agent_connection_paid:" + invoice.id, "MAG agent connection payment verified",
            "One exact 1 USDC Base payment credited one 24-hour connection period. Invoice " + invoice.id + ". This is not citizen activation or work acceptance.", now),
      ]);
      credited++;
    } catch { /* Fail closed; no upstream response, secret or signature is logged. */ }
  }
  return { enabled: true, checked: pending.results?.length || 0, credited };
}
function manifest(env) {
  return { product: "MAG agent daily connection", amount_atomic: AMOUNT, currency: "USDC", chain_id: 8453,
    token_contract: USDC, duration_ms: DAY, enabled: enabled(env) && env.MAG_HOSTED_WORK_WATCH_ENABLED === "true", automatic_debit: false,
    payment_provider: "direct_base_usdc", saturnshift_enabled: false,
    hosted_work_watch_enabled: env.MAG_HOSTED_WORK_WATCH_ENABLED === "true" && enabled(env),
    scope: "Prepaid connection for an approved citizen with a bounded, read-only hosted 1F916 work-watch recipe. Not a general-purpose AI agent, guaranteed bounty completion, wallet custody or automatic citizen approval.",
    execution: { recipe: "mag-public-work-watch-v1", scheduling: "Every 15 minutes; maximum five due identities per cycle, oldest run first.", delivery: "Signed status response includes the latest three run artifacts.", public_posting: false, arbitrary_code: false },
    signing: "POST /api/agent-connections/signing-payload", execute: "POST /api/agent-connections",
    acceptance: "Two configured Base RPC witnesses must agree on a finalized exact invoice-bound transfer. RPC agreement is not proof of independent failure domains.",
    identity: "MAG is an independent companion operated by MAVVERICK LLC." };
}
async function handleAgentConnectionRoutes(request, env, fetcher = fetch, now = Date.now()) {
  const path = new URL(request.url).pathname;
  if (path !== "/api/agent-connections" && path !== "/api/agent-connections/signing-payload") return null;
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (request.method === "GET" && path === "/api/agent-connections") return Response.json(manifest(env), { headers });
  if (!enabled(env)) return Response.json({ error: "agent_connection_checkout_disabled" }, { status: 503, headers });
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers });
  if (request.headers.has("origin") && request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "same_origin_required" }, { status: 403, headers });
  try {
    if (!(request.headers.get("content-type") || "").startsWith("application/json")) throw new Error("JSON required");
    const input = await boundedJson(new Response(request.body), 8192);
    return Response.json(path.endsWith("/signing-payload") ? await signingPayload(env, input, now) : await operateConnection(env, input, fetcher, now), { headers });
  } catch { return Response.json({ error: "invalid_or_unauthorized_connection_request" }, { status: 400, headers }); }
}
export { DAY, AMOUNT, TERMS, connectionPreimage, signingPayload, operateConnection, connectionState, processAgentConnections, handleAgentConnectionRoutes };
