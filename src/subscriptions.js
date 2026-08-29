import { validateTenant, planById, authorizedTenant } from "./managed-ops.js";
import { createPaymentIntent, verifyPaymentIntent } from "./payment-intents.js";
import { claimPaymentReceipt } from "./commerce.js";
const TERMS = "mag-30-day-trial-prepaid-monthly-v2";
const DAY = 86400000;
const TRIAL_DAYS = 30;
async function sha(text) {return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,"0")).join("");}
function monthlyQuote(planId,devices) {
  const plan=planById(planId), n=Number(devices);
  if (!plan || !Number.isInteger(n) || n<1 || n>10000) throw new Error("invalid plan or device limit");
  return (BigInt(plan.monthly_min_atomic)+BigInt(plan.endpoint_monthly_atomic)*BigInt(n)).toString();
}
function nextCalendarMonth(time) {
  const date=new Date(time), year=date.getUTCFullYear(), month=date.getUTCMonth()+1;
  const day=Math.min(date.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
  return Date.UTC(year,month,day,date.getUTCHours(),date.getUTCMinutes(),date.getUTCSeconds(),date.getUTCMilliseconds());
}
function enabledPlans(env) {return String(env.MAG_SUBSCRIPTION_PLANS || "").split(",").map(x=>x.trim()).filter(x=>planById(x));}
async function createSubscription(env,input,now=Date.now()) {
  if (!env.DB || !String(env.SCOUT_ADMIN_TOKEN||"").trim() || !enabledPlans(env).includes(input.plan_id)) throw new Error("subscription plan is not enabled for paid activation");
  const tenant=validateTenant(input), amount=monthlyQuote(tenant.plan.id,tenant.maxAssets);
  if (input.terms_accepted!==true || !/^[0-9a-f-]{36}$/i.test(input.request_key || "")) throw new Error("billing terms and unique request_key are required");
  if (await env.DB.prepare("SELECT id FROM managed_subscriptions WHERE request_key=?").bind(input.request_key).first()) throw new Error("request already created; reopen the original workspace rather than purchasing twice");
  const domainPlaceholders=tenant.domains.map(()=>"?").join(",");
  const priorTrial=await env.DB.prepare(`SELECT t.id FROM managed_tenants t JOIN managed_subscriptions s ON s.tenant_id=t.id WHERE t.contact_email=? OR EXISTS(SELECT 1 FROM json_each(t.authorized_domains_json) domain WHERE domain.value IN (${domainPlaceholders})) LIMIT 1`).bind(tenant.contactEmail,...tenant.domains).first();
  if (priorTrial) throw new Error("a workspace trial already exists for this email or organization domain; reopen that workspace to subscribe");
  const tenantId=crypto.randomUUID(), id=crypto.randomUUID(), invoiceId=crypto.randomUUID(), token=crypto.randomUUID()+crypto.randomUUID();
  const trialEndsAt=now+TRIAL_DAYS*DAY;
  // Validate the configured recipient before creating any customer records.
  const {transferRequest}=await import("./payment-intents.js");
  await transferRequest("subscription_invoice",invoiceId,env.TREASURY_WALLET_ADDRESS,amount);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO managed_tenants(id,name,contact_email,plan_id,max_assets,authorized_domains_json,authorization_attested,data_processing_consent,access_token_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,?,'active',?,?)").bind(tenantId,tenant.name,tenant.contactEmail,tenant.plan.id,tenant.maxAssets,JSON.stringify(tenant.domains),await sha(token),now,now),
    env.DB.prepare("INSERT INTO managed_subscriptions(id,tenant_id,plan_id,endpoint_limit,monthly_atomic,status,paid_through,terms_version,request_key,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?,?,?)").bind(id,tenantId,tenant.plan.id,tenant.maxAssets,amount,trialEndsAt,TERMS,input.request_key,now,now),
    env.DB.prepare("INSERT INTO subscription_invoices(id,subscription_id,period_number,amount_atomic,period_start,created_at) VALUES(?,?,1,?,?,?)").bind(invoiceId,id,amount,trialEndsAt,now),
    env.DB.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) VALUES(?,?,'subscription_created',?,?)").bind(id,id+":created",JSON.stringify({terms_version:TERMS,billing_method:"mag_merchant_checkout",automatic_debit:false,monthly_atomic:amount,endpoint_limit:tenant.maxAssets}),now),
    env.DB.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) VALUES(?,?,'trial_started',?,?)").bind(id,id+":trial",JSON.stringify({trial_days:TRIAL_DAYS,trial_started_at:now,trial_ends_at:trialEndsAt,automatic_charge:false,invoice_due_at:trialEndsAt}),now),
  ]);
  return {id,tenant_id:tenantId,access_token:token,invoice_id:invoiceId,amount_atomic:amount,status:"active",billing_state:"trialing",trial_days:TRIAL_DAYS,trial_started_at:now,trial_ends_at:trialEndsAt,terms_version:TERMS,automatic_debit:false};
}
async function authorizedSubscription(db,id,token) {
  const subscription=await db.prepare("SELECT * FROM managed_subscriptions WHERE id=? OR tenant_id=?").bind(id,id).first();
  if (!subscription || !await authorizedTenant(db,subscription.tenant_id,token)) throw new Error("subscription not found or unauthorized");
  return subscription;
}
async function subscriptionState(db,id,token,now=Date.now()) {
  const s=await authorizedSubscription(db,id,token);
  const invoices=await db.prepare("SELECT * FROM subscription_invoices WHERE subscription_id=? ORDER BY period_number DESC LIMIT 24").bind(s.id).all();
  const trialEvent=await db.prepare("SELECT details FROM subscription_events WHERE subscription_id=? AND kind='trial_started' LIMIT 1").bind(s.id).first();
  let trial=null;
  if(trialEvent)try{const details=JSON.parse(trialEvent.details);trial={days:Number(details.trial_days)||TRIAL_DAYS,started_at:Number(details.trial_started_at)||null,ends_at:Number(details.trial_ends_at)||null,active:s.status==="active"&&Number(details.trial_ends_at)>now};}catch{}
  const entitled=s.status==="active"&&Number(s.paid_through)>now;
  const billingState=trial?.active?"trialing":s.status;
  return {subscription:s,invoices:invoices.results,entitled,billing_state:billingState,trial,automatic_debit:false,terms_version:TERMS};
}
async function subscriptionIntent(env,id,invoiceId,token) {
  const s=await authorizedSubscription(env.DB,id,token);
  const invoice=await env.DB.prepare("SELECT * FROM subscription_invoices WHERE id=? AND subscription_id=?").bind(invoiceId,s.id).first();
  if (!invoice || invoice.status!=="unpaid" || s.cancel_at_period_end || s.status==="cancelled") throw new Error("invoice cannot accept payment");
  return createPaymentIntent(env.DB,"subscription_invoice",invoiceId,env.TREASURY_WALLET_ADDRESS,invoice.amount_atomic);
}
async function submitSubscriptionReceipt(env,id,invoiceId,token,input,now=Date.now()) {
  const s=await authorizedSubscription(env.DB,id,token), tx=String(input.tx_hash||"").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(tx)) throw new Error("valid Base transaction hash required");
  const existing=await env.DB.prepare("SELECT status,tx_hash FROM subscription_invoices WHERE id=? AND subscription_id=?").bind(invoiceId,s.id).first();
  if(existing?.tx_hash===tx&&["pending_verification","paid"].includes(existing.status))return {invoice_id:invoiceId,status:existing.status};
  await subscriptionIntent(env,id,invoiceId,token);
  await claimPaymentReceipt(env.DB,tx,"subscription_invoice",invoiceId,[
    env.DB.prepare("UPDATE subscription_invoices SET status='pending_verification',tx_hash=? WHERE id=? AND status='unpaid'").bind(tx,invoiceId),
    env.DB.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) VALUES(?,?,'payment_submitted',?,?)").bind(s.id,invoiceId+":submitted",JSON.stringify({invoice_id:invoiceId}),now)
  ],env.DB.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) SELECT ?,'subscription_invoice',?,? FROM subscription_invoices i JOIN managed_subscriptions s ON s.id=i.subscription_id WHERE i.id=? AND i.status='unpaid' AND s.cancel_at_period_end=0 AND s.status<>'cancelled'").bind(tx,invoiceId,now,invoiceId));
  return {invoice_id:invoiceId,status:"pending_verification"};
}
async function cancelSubscription(db,id,token,now=Date.now()) {
  const s=await authorizedSubscription(db,id,token);
  const pending=await db.prepare("SELECT id FROM subscription_invoices WHERE subscription_id=? AND status='pending_verification'").bind(s.id).first();
  if (pending) throw new Error("payment is being verified; cancel after its receipt settles so no paid period is lost");
  await db.batch([
    db.prepare("UPDATE managed_subscriptions SET cancel_at_period_end=1,status=CASE WHEN paid_through>? THEN status ELSE 'cancelled' END,updated_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM subscription_invoices WHERE subscription_id=? AND status='pending_verification')").bind(now,now,s.id,s.id),
    db.prepare("UPDATE subscription_invoices SET status='void' WHERE subscription_id=? AND status='unpaid' AND EXISTS(SELECT 1 FROM managed_subscriptions WHERE id=? AND cancel_at_period_end=1)").bind(s.id,s.id),
    db.prepare("INSERT OR IGNORE INTO subscription_events(subscription_id,event_key,kind,details,created_at) SELECT id,id||':cancelled','cancellation_requested','{\"automatic_debit\":false}',? FROM managed_subscriptions WHERE id=? AND cancel_at_period_end=1").bind(now,s.id),
  ]);
  const current=await authorizedSubscription(db,s.id,token);
  if (!current.cancel_at_period_end) throw new Error("payment state changed; cancellation was not applied");
  return {id:s.id,cancel_at_period_end:true,access_until:s.paid_through,automatic_debit:false};
}
async function processSubscriptions(env,fetcher=fetch,now=Date.now()) {
  if (!env.DB) return {checked:0,activated:0,renewal_invoices:0};
  const rows=await env.DB.prepare("SELECT i.*,s.tenant_id,s.paid_through,s.cancel_at_period_end FROM subscription_invoices i JOIN managed_subscriptions s ON s.id=i.subscription_id JOIN payment_receipt_claims p ON p.tx_hash=i.tx_hash AND p.purpose_type='subscription_invoice' AND p.purpose_id=i.id WHERE i.status='pending_verification' ORDER BY i.created_at LIMIT 10").all();
  let activated=0,renewals=0;
  for (const invoice of rows.results || []) {
    try {
      const intent=await env.DB.prepare("SELECT * FROM checkout_payment_intents WHERE purpose_type='subscription_invoice' AND purpose_id=?").bind(invoice.id).first();
      const proof=await verifyPaymentIntent(intent,invoice.tx_hash,fetcher);
      if (!proof.verified) continue;
      const start=Math.max(now,Number(invoice.paid_through||0)), end=nextCalendarMonth(start);
      const results=await env.DB.batch([
        env.DB.prepare("UPDATE subscription_invoices SET status='paid',period_start=?,period_end=?,verified_at=? WHERE id=? AND status='pending_verification'").bind(start,end,now,invoice.id),
        env.DB.prepare("INSERT INTO subscription_events(subscription_id,event_key,kind,details,created_at) VALUES(?,?,CASE WHEN changes()=1 THEN 'payment_verified' ELSE NULL END,?,?)").bind(invoice.subscription_id,invoice.id+":paid",JSON.stringify({invoice_id:invoice.id,...proof}),now),
        env.DB.prepare("UPDATE managed_subscriptions SET status='active',paid_through=?,updated_at=? WHERE id=?").bind(end,now,invoice.subscription_id),
        env.DB.prepare("UPDATE managed_tenants SET status='active',updated_at=? WHERE id=? AND status IN ('pending_review','active')").bind(now,invoice.tenant_id),
      ]);
      if (results[0]?.meta?.changes===1) activated++;
    } catch { /* No provider response bodies or credential-bearing errors in logs. */ }
  }
  const due=await env.DB.prepare("SELECT s.*,COALESCE((SELECT MAX(period_number) FROM subscription_invoices WHERE subscription_id=s.id),0)+1 AS next_period FROM managed_subscriptions s WHERE s.status IN ('active','past_due') AND s.cancel_at_period_end=0 AND s.paid_through<? AND NOT EXISTS(SELECT 1 FROM subscription_invoices WHERE subscription_id=s.id AND status IN ('unpaid','pending_verification')) LIMIT 100").bind(now+7*DAY).all();
  for (const s of due.results || []) {
    const id=crypto.randomUUID();
    const inserted=await env.DB.prepare("INSERT OR IGNORE INTO subscription_invoices(id,subscription_id,period_number,amount_atomic,created_at) SELECT ?,id,?,monthly_atomic,? FROM managed_subscriptions WHERE id=? AND cancel_at_period_end=0 AND NOT EXISTS(SELECT 1 FROM subscription_invoices WHERE subscription_id=? AND status IN ('unpaid','pending_verification'))").bind(id,s.next_period,now,s.id,s.id).run();
    renewals+=Number(inserted.meta?.changes||0);
  }
  await env.DB.prepare("UPDATE managed_subscriptions SET status=CASE WHEN cancel_at_period_end=1 THEN 'cancelled' ELSE 'past_due' END,updated_at=? WHERE status='active' AND paid_through<=?").bind(now,now).run();
  return {checked:rows.results?.length||0,activated,renewal_invoices:renewals};
}
async function tenantEntitled(db,tenantId,now=Date.now()) {
  const s=await db.prepare("SELECT status,paid_through FROM managed_subscriptions WHERE tenant_id=?").bind(tenantId).first();
  // Previously operator-approved tenants retain their existing non-subscription status.
  return !s || s.status==="active"&&Number(s.paid_through)>now;
}
export { DAY, TERMS, TRIAL_DAYS, monthlyQuote, nextCalendarMonth, enabledPlans, createSubscription, authorizedSubscription, subscriptionState, subscriptionIntent, submitSubscriptionReceipt, cancelSubscription, processSubscriptions, tenantEntitled };
