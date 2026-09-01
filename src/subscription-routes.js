import { createSubscription, subscriptionState, subscriptionIntent, submitSubscriptionReceipt, cancelSubscription, enabledPlans, TRIAL_DAYS } from "./subscriptions.js";
import { walletCheckoutMarkup } from "./wallet-checkout-view.js";
import { paymentProviderOptions, saturnShiftSubscriptionCheckoutResponse, saturnShiftSubscriptionReturnResponse } from "./saturnshift-checkout.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function customerSession(request) {
  const value=(request.headers.get("cookie")||"").split(";").map(s=>s.trim()).find(s=>s.startsWith("__Host-mag_workspace="))?.split("=")[1]||"";
  const match=/^([0-9a-f-]{36})\.([0-9a-f-]{72})$/i.exec(value);
  return match?{tenant_id:match[1],access_token:match[2]}:null;
}
function sessionCookie(tenantId,token) {return `__Host-mag_workspace=${tenantId}.${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=2592000`;}
function page(body,status=200,cookie) {
  const headers={"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
  if(cookie)headers["set-cookie"]=cookie;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG subscription billing</title><link rel="icon" href="/mag-favicon.png"><style>body{max-width:850px;margin:40px auto;padding:0 22px;background:#061a33;color:#eaf7ff;font:16px/1.6 system-ui}a{color:#11d8ed}section,form{background:#0a2744;border:1px solid #28516f;border-radius:14px;padding:22px;margin:18px 0}button{padding:12px 18px;border:0;border-radius:8px;background:#11d8ed;color:#061a33;font:inherit;font-weight:700;cursor:pointer}code{overflow-wrap:anywhere}.muted{color:#a6bdcd}strong{color:#f6c653}</style></head><body><a href="/hire">← MAG services</a>${body}</body></html>`,{status,headers});
}
function json(value,status=200) {return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"}});}
async function input(request) {
  const reader=request.body?.getReader(), chunks=[];let length=0;
  if(reader)try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>16000)throw new Error("request too large");chunks.push(part.value);}}catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text=new TextDecoder().decode(bytes);
  return request.headers.get("content-type")?.includes("application/json")?JSON.parse(text):Object.fromEntries(new URLSearchParams(text));
}
async function billingPage(env,session,created=null) {
  const state=await subscriptionState(env.DB,session.tenant_id,session.access_token), s=state.subscription;
  const invoice=state.invoices.find(i=>i.status==="unpaid");
  const amount=(Number(s.monthly_atomic)/1e6).toLocaleString("en-US");
  const payment=invoice?`<section><h2>Pay MAG</h2><p><a href="/subscriptions/checkout?invoice=${encodeURIComponent(invoice.id)}">Pay with SaturnShift →</a></p><p class="muted">SaturnShift accepts MAG's enabled merchant methods. Agent-day access is excluded, and a browser return never activates service without authenticated payment evidence. Direct Base USDC remains available below.</p></section>${walletCheckoutMarkup({accessToken:session.access_token,intentUrl:`/api/subscriptions/${s.id}/invoices/${invoice.id}/payment-intent`,receiptUrl:`/api/subscriptions/${s.id}/invoices/${invoice.id}/payment-receipts`,amount:Number(invoice.amount_atomic)/1e6})}`:"";
  const trial=state.trial?.active?`<p><strong>${state.trial.days}-day free trial active</strong> through ${esc(new Date(state.trial.ends_at).toISOString())}. No payment method was required and no automatic charge will occur.</p>`:"";
  const access=state.billing_state==="trialing"?"Trial access active":state.entitled?"Paid access active":"Payment required to restore access";
  const body=`<h1>Your subscription</h1><section><h2>${esc(s.plan_id)}</h2><p><strong>$${amount} USD / calendar month after trial</strong> · ${s.endpoint_limit} device limit</p><p>Status: ${esc(state.billing_state)} · ${access}</p>${trial}<p>Access through: ${s.paid_through?esc(new Date(s.paid_through).toISOString()):"Payment required"}</p><p>MAG is the merchant. Your PSA tenant does not need a SaturnShift account and may use its own accounting integrations. Pay MAG's invoice by an available hosted card, ACH, or stablecoin method, or by direct Base USDC. Automatic debit: <strong>off</strong>.</p>${created?`<details><summary>Save your workspace recovery credentials</summary><p>Tenant: <code>${esc(session.tenant_id)}</code></p><p>Access token: <code>${esc(session.access_token)}</code></p><p>Saved securely in this browser's HTTP-only session cookie. Keep a private recovery copy.</p></details>`:""}<a href="/ops/console">Open workspace →</a></section>${payment}<section><h2>Invoices</h2>${state.invoices.map(i=>`<p><code>${esc(i.id)}</code> · $${Number(i.amount_atomic)/1e6} USD · ${esc(i.status)}${i.period_start?` · service period starts ${esc(new Date(i.period_start).toISOString())}`:""}</p>`).join("")}<a href="/subscriptions/billing">Refresh payment status</a></section>${s.cancel_at_period_end?"<p>Cancellation is scheduled. No future invoice will be generated.</p>":`<form method="post" action="/subscriptions/cancel"><p>Cancel before the trial or paid access period ends. No automatic charge, refund, or treasury transfer is performed.</p><button>Cancel future renewals</button></form>`}`;
  return page(body,created?201:200,created?sessionCookie(session.tenant_id,session.access_token):undefined);
}
async function handleSubscriptionRoutes(request,env,url) {
  if (!url.pathname.startsWith("/subscriptions")&&!url.pathname.startsWith("/api/subscriptions"))return null;
  if (!env.DB)return json({error:"database_unavailable"},503);
  const session=customerSession(request), bearer=(request.headers.get("authorization")||"").replace(/^Bearer /,"");
  if (request.method==="POST"&&((request.headers.has("origin")&&request.headers.get("origin")!==url.origin)||(session&&!request.headers.has("authorization")&&request.headers.get("origin")!==url.origin)))return json({error:"same_origin_required"},403);
  try {
    if (request.method==="GET"&&url.pathname==="/api/subscriptions/plans"){
      const providers=paymentProviderOptions(env),hosted=providers.saturnshift.checkout_configured;
      return json({enabled_plans:enabledPlans(env),trial_days:TRIAL_DAYS,billing:"mag_merchant_checkout",payment_methods:[...(hosted?providers.saturnshift.methods.map(method=>`saturnshift_${method}`):[]),...(providers.base_usdc_direct.configured?["base_native_usdc"]:[])],saturnshift:{payment_intake_configured:providers.saturnshift.payment_intake_configured,automatic_fulfillment_configured:providers.saturnshift.automatic_fulfillment_configured,agent_access_included:false},tenant_payment_provider_required:false,automatic_debit:false});
    }
    if(request.method==="POST"&&["/subscriptions","/api/subscriptions"].includes(url.pathname)) {
      const raw=await input(request), form=request.headers.get("content-type")?.includes("application/x-www-form-urlencoded");
      const normalized=form?{...raw,authorized_domains:[raw.authorized_domain],max_assets:Number(raw.max_assets),authorization_attested:raw.authorization_attested==="yes",data_processing_consent:raw.authorization_attested==="yes",terms_accepted:raw.terms_accepted==="yes"}:raw;
      const created=await createSubscription(env,normalized);
      return form?billingPage(env,{tenant_id:created.tenant_id,access_token:created.access_token},created):json({subscription:created},201);
    }
    if(request.method==="GET"&&url.pathname==="/subscriptions/billing")return session?billingPage(env,session):page('<h1>Open your workspace first</h1><a href="/ops/console">Workspace sign-in</a>',401);
    if(request.method==="GET"&&url.pathname==="/subscriptions/checkout"){
      if(!session)return json({error:"workspace_session_required"},401);
      const invoiceId=url.searchParams.get("invoice")||"";
      return saturnShiftSubscriptionCheckoutResponse(env,session.tenant_id,invoiceId,session.access_token,url.href);
    }
    if(request.method==="GET"&&url.pathname==="/subscriptions/payment-return")return saturnShiftSubscriptionReturnResponse(url.searchParams.get("invoice"));
    if(request.method==="POST"&&url.pathname==="/subscriptions/cancel") {
      if(!session)return json({error:"workspace_session_required"},401);
      await cancelSubscription(env.DB,session.tenant_id,session.access_token);
      return billingPage(env,session);
    }
    const match=url.pathname.match(/^\/api\/subscriptions\/([0-9a-f-]+)(?:\/invoices\/([0-9a-f-]+)\/(payment-intent|payment-receipts)|\/(cancel))?$/i);
    if(match) {
      if(request.method==="GET"&&!match[2]&&!match[4])return json(await subscriptionState(env.DB,match[1],bearer));
      if(request.method==="POST"&&match[3]==="payment-intent")return json({payment_request:await subscriptionIntent(env,match[1],match[2],bearer)});
      if(request.method==="POST"&&match[3]==="payment-receipts")return json(await submitSubscriptionReceipt(env,match[1],match[2],bearer,await input(request)),202);
      if(request.method==="POST"&&match[4])return json(await cancelSubscription(env.DB,match[1],bearer));
    }
    return json({error:"not_found"},404);
  }catch(error){return url.pathname.startsWith("/api/")?json({error:String(error.message)},400):page(`<h1>Checkout could not continue</h1><p>${esc(error.message)}</p><a href="/hire?service=managed-ops-psa">Return to subscription setup</a>`,400);}
}
export { customerSession, sessionCookie, billingPage, handleSubscriptionRoutes };
