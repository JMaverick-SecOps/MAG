import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createOrder, submitPaymentReceipt } from "../src/commerce.js";
import { claimPreimage, claimTask, completeSubmission, submissionPreimage, submitWork } from "../src/marketplace.js";
import { createSubscription, subscriptionState } from "../src/subscriptions.js";
import {
  BASE_USDC_CONTRACT,
  SATURNSHIFT_SCRIPT_URL,
  handleSaturnShiftWebhook,
  paymentProviderOptions,
  saturnShiftCheckoutResponse,
  saturnShiftSubscriptionCheckoutResponse,
  saturnShiftReturnResponse,
  webhookVerificationReadiness,
} from "../src/saturnshift-checkout.js";

class TestStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  first(column) {
    const row = this.database.prepare(this.sql).get(...this.values);
    return column ? row?.[column] ?? null : row ?? null;
  }

  all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values), meta: { changes: 0 } };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  executeForBatch() {
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = this.database.prepare(this.sql).all(...this.values);
      return { results, meta: { changes: results.length, last_row_id: results[0]?.id } };
    }
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) return this.all();
    return this.run();
  }
}

class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const filename of readdirSync(directory).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
      this.sqlite.exec(readFileSync(fileURLToPath(new URL(`../migrations/${filename}`, import.meta.url)), "utf8"));
    }
    this.beforeBatch = null;
  }

  prepare(sql) {
    return new TestStatement(this.sqlite, sql);
  }

  batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (this.beforeBatch) {
        const hook = this.beforeBatch;
        this.beforeBatch = null;
        hook(this.sqlite);
      }
      const results = statements.map((statement) => statement.executeForBatch());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

const TREASURY = `0x${"a".repeat(40)}`;
const WEBHOOK_SECRET = "test-only-webhook-secret-with-32-bytes";

function webhookEnv(db) {
  return {
    DB: db,
    SATURNSHIFT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SATURNSHIFT_WEBHOOK_ENDPOINT_STATUS: "registered",
    SATURNSHIFT_FIAT_WEBHOOK_STATUS: "provider_confirmed",
  };
}

async function orderFixture(db) {
  return createOrder(db, {
    service_id: "website-starter",
    buyer_name: "Test Buyer",
    buyer_email: "buyer@example.test",
    objective: "Build a responsive product landing page from the supplied approved content.",
    acceptance_criteria: "The supplied accessibility and responsive-layout checks pass against the artifact.",
    target_scope: "The buyer-controlled example repository and staging environment.",
    execution_mode: "pull_request",
    max_budget_atomic: "99000000",
    authorization_attested: true,
  });
}

function providerEvent(order, overrides = {}) {
  return {
    id: overrides.id || "evt_test_crypto_1",
    type: overrides.type || "payment.paid",
    data: {
      object: overrides.object || "transaction",
      id: overrides.paymentId || "pay_test_crypto_1",
      merchant_id: 116,
      status: overrides.status || "paid",
      amount_status: overrides.amountStatus || "EXACT",
      asset: overrides.settlementAsset || "USDC",
      currency: overrides.currency || "USD",
      amount: {gross:overrides.amount || "99.00",net:overrides.amount || "99.00",psp_fee:"0.00",gas_fee:"0.00",bridge_fee:"0.00"},
      networks: {payment:overrides.paymentNetwork || "BASE",settlement:overrides.settlementNetwork || "BASE"},
      tx_hashes: {source:"0x"+"1".repeat(64),bridge:null,settlement:"0x"+"2".repeat(64)},
      external_reference: overrides.externalReference || order.id,
    },
  };
}

async function signedRequest(payload, env, { signature = null, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const body = JSON.stringify(payload);
  const signed = new TextEncoder().encode(`${timestamp}.${body}`);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SATURNSHIFT_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request("https://example.test/webhooks/saturnshift", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "SaturnShift-Signature": signature || `t=${timestamp},v1=${hex}`,
      "SaturnShift-Event-Id": payload.id,
      "SaturnShift-Event-Type": payload.type,
    },
    body,
  });
}

test("hosted checkout uses only the env public key, stable order identity, and all three provider methods", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const env = {
    ...webhookEnv(db),
    SCOUT_ENVIRONMENT: "production",
    SATURNSHIFT_PUBLIC_KEY: "pk_test_public_from_environment",
    TREASURY_WALLET_ADDRESS: TREASURY,
  };
  const response = await saturnShiftCheckoutResponse(env, order.id, order.access_token, "https://example.test/orders/checkout");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, new RegExp(SATURNSHIFT_SCRIPT_URL.replace(/[.]/g, "\\.")));
  assert.match(body, /"publicKey":"pk_test_public_from_environment"/);
  assert.match(body, new RegExp(`"externalReference":"${order.id}"`));
  assert.match(body, new RegExp(`"idempotencyKey":"${order.id}"`));
  assert.match(body, /"allowCard":true/);
  assert.match(body, /"allowBank":true/);
  assert.match(body, /"allowCrypto":true/);
  assert.match(body, /href="\/orders\/status"/);
  assert.equal(body.includes(order.access_token), false, "third-party checkout script must never share a page with the private order token");
  assert.match(body, new RegExp(BASE_USDC_CONTRACT));
  assert.match(body, /verified card or bank payment remains in payment review/i);
  assert.doesNotMatch(body, /SATURNSHIFT_WEBHOOK_SECRET/);
  assert.match(response.headers.get("content-security-policy"), /api\.saturnshift\.io\/checkout\.js/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("checkout fails closed for hosted payment when no public key exists while keeping direct Base USDC visible", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const response = await saturnShiftCheckoutResponse({ DB: db, TREASURY_WALLET_ADDRESS: TREASURY }, order.id, order.access_token, "https://example.test/checkout");
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /Hosted checkout unavailable/);
  assert.doesNotMatch(body, /<script src=/);
  assert.match(body, /submit a Base receipt/);
});

test("redirect response never changes payment state or claims payment proof", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const response = saturnShiftReturnResponse(order.id);
  assert.equal(response.status, 202);
  assert.match(await response.text(), /redirect is not proof of payment/i);
  const stored = db.prepare("SELECT status,payment_status,published_task_id FROM service_orders WHERE id=?").bind(order.id).first();
  assert.deepEqual({ ...stored }, { status: "awaiting_payment", payment_status: "unsubmitted", published_task_id: null });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count, 0);
});

test("hosted financial checkout stays disabled until the documented endpoint is registered", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const incomplete = { DB: db, SATURNSHIFT_WEBHOOK_SECRET: WEBHOOK_SECRET };
  assert.equal(webhookVerificationReadiness(incomplete).ready, false);
  const response = await handleSaturnShiftWebhook(new Request("https://example.test/webhooks/saturnshift", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(providerEvent(order)),
  }), incomplete);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "saturnshift_webhook_verification_not_configured" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM tasks").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count, 0);
});

test("invalid webhook HMAC fails closed without durable payment state", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const env = webhookEnv(db);
  const request = await signedRequest(providerEvent(order), env, { signature: `sha256=${"0".repeat(64)}` });
  const response = await handleSaturnShiftWebhook(request, env);
  assert.equal(response.status, 401);
  assert.equal(db.prepare("SELECT payment_status FROM service_orders WHERE id=?").bind(order.id).first().payment_status, "unsubmitted");
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_receipt_claims").first().count, 0);
});

test("verified crypto event publishes exactly one task only for explicit USDC-on-Base settlement", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const env = webhookEnv(db);
  const payload = providerEvent(order);
  const first = await handleSaturnShiftWebhook(await signedRequest(payload, env), env);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.payment_status, "verified");
  assert.equal(firstBody.reserve_required, false);
  assert.ok(firstBody.task_id > 0);

  const stored = db.prepare("SELECT payment_provider,provider_payment_id,provider_external_reference,provider_idempotency_key,payment_status,status,published_task_id,payment_tx_hash FROM service_orders WHERE id=?").bind(order.id).first();
  assert.deepEqual({ ...stored }, {
    payment_provider: "saturnshift",
    provider_payment_id: "pay_test_crypto_1",
    provider_external_reference: order.id,
    provider_idempotency_key: order.id,
    payment_status: "verified",
    status: "open",
    published_task_id: firstBody.task_id,
    payment_tx_hash: null,
  });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM tasks").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events WHERE processing_status='applied'").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_receipt_claims").first().count, 1);
  const event = db.prepare("SELECT details FROM order_events WHERE order_id=? AND kind='saturnshift_payment_verified_and_task_published'").bind(order.id).first();
  assert.equal(JSON.parse(event.details).settlement_asset, "USDC");
  assert.equal(JSON.parse(event.details).settlement_network, "BASE");
  assert.equal(JSON.parse(event.details).payout_authority, "owner_signature_required");

  const replay = await handleSaturnShiftWebhook(await signedRequest(payload, env), env);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).duplicate, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM tasks").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count, 1);
});

test("an undocumented fiat-shaped event is rejected and does not publish work", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const env = webhookEnv(db);
  const payload = providerEvent(order, {
    id: "evt_test_card_1",
    paymentId: "pay_test_card_1",
    settlementAsset: "USD",
    settlementNetwork: "BANK",
  });
  const response = await handleSaturnShiftWebhook(await signedRequest(payload, env), env);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(),{error:"saturnshift_crypto_settlement_is_not_base_usdc"});
  const stored = db.prepare("SELECT status,payment_status,published_task_id,payment_provider FROM service_orders WHERE id=?").bind(order.id).first();
  assert.deepEqual({ ...stored }, { status: "awaiting_payment", payment_status: "unsubmitted", published_task_id: null, payment_provider: "base_usdc_direct" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM tasks").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count,0);
});

test("crypto success on any settlement other than USDC on Base is rejected without claims", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const env = webhookEnv(db);
  const payload = providerEvent(order, { settlementNetwork: "Ethereum" });
  const response = await handleSaturnShiftWebhook(await signedRequest(payload, env), env);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "saturnshift_crypto_settlement_is_not_base_usdc" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM tasks").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_receipt_claims").first().count, 0);
});

test("a direct Base receipt winning the race leaves no orphan SaturnShift event or receipt claim", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const env = webhookEnv(db);
  db.beforeBatch = (sqlite) => {
    sqlite.prepare("UPDATE service_orders SET payment_status='pending_verification',status='payment_review',payment_tx_hash=? WHERE id=?").run(`0x${"9".repeat(64)}`, order.id);
  };
  const response = await handleSaturnShiftWebhook(await signedRequest(providerEvent(order), env), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "saturnshift_payment_state_conflict" });
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_events").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM payment_provider_receipt_claims").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM tasks").first().count, 0);
  const stored = db.prepare("SELECT payment_provider,payment_status,status FROM service_orders WHERE id=?").bind(order.id).first();
  assert.deepEqual({ ...stored }, { payment_provider: "base_usdc_direct", payment_status: "pending_verification", status: "payment_review" });
});

test("existing direct Base receipt path keeps its provider default after the migration", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const order = await orderFixture(db);
  const { createPaymentIntent } = await import("../src/payment-intents.js");
  await createPaymentIntent(db,"service_order",order.id,TREASURY,order.quoted_atomic);
  await submitPaymentReceipt(db, order.id, order.access_token, { tx_hash: `0x${"1".repeat(64)}` });
  const stored = db.prepare("SELECT payment_provider,payment_status,status FROM service_orders WHERE id=?").bind(order.id).first();
  assert.deepEqual({ ...stored }, { payment_provider: "base_usdc_direct", payment_status: "pending_verification", status: "payment_review" });
  const options = paymentProviderOptions({ TREASURY_WALLET_ADDRESS: TREASURY });
  assert.equal(options.base_usdc_direct.configured, true);
  assert.equal(options.saturnshift.checkout_configured, false);
});

test("synthetic signed provider settlement supports claimed delivery and one acceptance without a fabricated chain hash", async t => {
  const db = new TestD1(); t.after(()=>db.close());
  const order = await orderFixture(db), env = webhookEnv(db);
  const paid = await handleSaturnShiftWebhook(await signedRequest(providerEvent(order),env),env);
  const taskId = (await paid.json()).task_id;
  db.prepare("INSERT INTO guild_applications(id,handle,status,created_at,updated_at) VALUES('test-member','agent-one','active',1,1)").run();
  const pair = await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw",pair.publicKey)).toString("base64url");
  const fetcher = async()=>Response.json({keys:[{status:"active",public_key:publicKey}]});
  const sign = async text => Buffer.from(await crypto.subtle.sign({name:"Ed25519"},pair.privateKey,new TextEncoder().encode(text))).toString("base64url");
  const signed_at = Date.now(), handle = "agent-one", artifact = "https://example.test/test-artifact";
  await claimTask(db,taskId,{handle,signed_at,signature:await sign(claimPreimage({taskId,handle,signedAt:signed_at}))},fetcher);
  const submission = await submitWork(db,taskId,{handle,signed_at,artifact,signature:await sign(submissionPreimage({taskId,handle,artifact,signedAt:signed_at}))},fetcher);
  const acceptance = await completeSubmission(db,submission.id,{verification_summary:"Synthetic integration fixture passed the documented acceptance checks.",evidence_url:"https://example.test/test-receipt"});
  assert.equal(acceptance.submission.status,"accepted");
  assert.equal(acceptance.payout_proposal.status,"awaiting_owner_signature");
  assert.equal(db.prepare("SELECT payment_tx_hash FROM service_orders WHERE id=?").bind(order.id).first().payment_tx_hash,null);
  assert.equal((await completeSubmission(db,submission.id,{})).notification,"deduplicated");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_events").first().n,1);
});

test("MAG subscription checkout uses the tenant-independent merchant rail and extends access once",async t=>{
  const db=new TestD1();t.after(()=>db.close());
  const now=Date.now(),env={...webhookEnv(db),SCOUT_ADMIN_TOKEN:"test-owner",TREASURY_WALLET_ADDRESS:TREASURY,MAG_SUBSCRIPTION_PLANS:"psa-workspace",SATURNSHIFT_PUBLIC_KEY:"pk_test_mag_merchant",SCOUT_ENVIRONMENT:"production"};
  const created=await createSubscription(env,{name:"Tenant customer",contact_email:"owner@tenant-pay.example",plan_id:"psa-workspace",max_assets:4,authorized_domains:["tenant-pay.example"],authorization_attested:true,data_processing_consent:true,terms_accepted:true,request_key:crypto.randomUUID()},now);
  const checkout=await saturnShiftSubscriptionCheckoutResponse(env,created.id,created.invoice_id,created.access_token,"https://example.test/subscriptions/checkout");
  assert.equal(checkout.status,200);const markup=await checkout.text();
  assert.match(markup,new RegExp(`subscription_invoice:${created.invoice_id}`));assert.match(markup,/does not need a SaturnShift account/);assert.match(markup,/allowBank":true/);
  const payload=providerEvent({id:created.invoice_id},{paymentId:"pay_subscription_1",amount:"79.00",externalReference:`subscription_invoice:${created.invoice_id}`});
  const paid=await handleSaturnShiftWebhook(await signedRequest(payload,env),env);
  assert.equal(paid.status,200);assert.deepEqual(await paid.json(),{received:true,signature_verified:true,duplicate:false,subscription_id:created.id,invoice_id:created.invoice_id,payment_status:"verified"});
  assert.equal(db.prepare("SELECT status FROM subscription_invoices WHERE id=?").bind(created.invoice_id).first().status,"paid");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks").first().n,0);
  const state=await subscriptionState(db,created.id,created.access_token,now);assert.equal(state.entitled,true);assert.ok(Number(state.subscription.paid_through)>created.trial_ends_at);
  const replay=await handleSaturnShiftWebhook(await signedRequest(payload,env),env);assert.equal((await replay.json()).duplicate,true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM subscription_events WHERE kind='saturnshift_payment_verified'").first().n,1);
});
