import test from "node:test";
import assert from "node:assert/strict";
import { TestD1 } from "./helpers/d1.js";
import { USDC, createPaymentIntent, transferRequest, verifyPaymentIntent } from "../src/payment-intents.js";
import { createSubscription, subscriptionIntent, submitSubscriptionReceipt, processSubscriptions, subscriptionState, cancelSubscription, nextCalendarMonth, monthlyQuote } from "../src/subscriptions.js";
import { SERVICES, createOrder, processPendingOrders, submitPaymentReceipt } from "../src/commerce.js";
import { catalogDefaults, catalogPage } from "../src/catalog-checkout.js";
import worker from "../src/index.js";
const TREASURY="0x"+"a".repeat(40), TX="0x"+"b".repeat(64);
function rpcFixture(intent,hash=TX,change={}) {
  const receipt={transactionHash:hash,blockHash:"0x"+"c".repeat(64),blockNumber:"0x100",status:"0x1",logs:[{address:USDC,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(64),"0x"+TREASURY.slice(2).padStart(64,"0")],data:"0x"+BigInt(intent.amount_atomic).toString(16)}]};
  const tx={hash,blockHash:receipt.blockHash,to:USDC,input:intent.calldata,value:"0x0"};
  return async(url,init)=>{
    const q=JSON.parse(init.body);
    let result=q.method==="eth_getTransactionReceipt"?receipt:q.method==="eth_getTransactionByHash"?tx:{number:"0x101"};
    if(change[q.method])result=change[q.method](structuredClone(result),url);
    return Response.json({jsonrpc:"2.0",id:1,result});
  };
}
test("every catalog service opens a preselected checkout; product prices are not editable",()=>{
  const catalog=catalogPage("",true);
  for(const service of SERVICES)assert.ok(catalog.includes('href="/hire?service='+service.id+'#checkout"'),service.id);
  for(const service of SERVICES.filter(s=>!["migration-fabric","managed-ops-psa","static-scan-review","focused-code-review","application-review"].includes(s.id))) {
    const page=catalogPage(service.id,true),defaults=catalogDefaults(service);
    assert.ok(defaults.objective.length>=30);assert.ok(defaults.acceptance_criteria.length>=30);
    assert.ok(page.includes('type="hidden" name="max_budget_atomic"'));
    assert.ok(page.includes('name="catalog_checkout" value="yes"'));
    assert.ok(!page.includes('name="objective"'));assert.ok(!page.includes('name="acceptance_criteria"'));
  }
});
test("payment intents encode exact transfer without allowance and cannot be changed",async t=>{
  const db=new TestD1();t.after(()=>db.close());const id=crypto.randomUUID();
  const p=await createPaymentIntent(db,"service_order",id,TREASURY,"49000000");
  assert.equal(p.chainId,"0x2105");assert.equal(p.to,USDC);assert.equal(p.value,"0x0");assert.equal(p.data.length,202);assert.ok(p.data.startsWith("0xa9059cbb"));
  assert.deepEqual(await createPaymentIntent(db,"service_order",id,TREASURY,"49000000"),p);
  await assert.rejects(()=>createPaymentIntent(db,"service_order",id,TREASURY,"1"),/immutable invoice/);
  assert.notEqual((await transferRequest("service_order",crypto.randomUUID(),TREASURY,"49000000")).data,p.data);
});
test("payment proof requires both finalized RPCs and the exact purchase-specific calldata",async t=>{
  const db=new TestD1();t.after(()=>db.close());
  await createPaymentIntent(db,"service_order",crypto.randomUUID(),TREASURY,"49000000");
  const intent=db.prepare("SELECT * FROM checkout_payment_intents").first();
  assert.equal((await verifyPaymentIntent(intent,TX,rpcFixture(intent))).verified,true);
  for(const change of [
    {eth_getTransactionByHash:x=>({...x,input:x.input.slice(0,-1)+(x.input.endsWith("0")?"1":"0")})},
    {eth_getTransactionByHash:x=>({...x,to:TREASURY})},
    {eth_getTransactionByHash:x=>({...x,value:"0x1"})},
    {eth_getBlockByNumber:()=>({number:"0xff"})},
    {eth_getTransactionReceipt:(x,url)=>({...x,blockHash:url.includes("publicnode")?"0x"+"d".repeat(64):x.blockHash})}
  ])assert.equal((await verifyPaymentIntent(intent,TX,rpcFixture(intent,TX,change))).verified,false);
});
test("new orders cannot submit an unbound payment and publish only once after finalized proof",async t=>{
  const db=new TestD1();t.after(()=>db.close());
  const service=SERVICES[0],order=await createOrder(db,{service_id:service.id,buyer_name:"Buyer",buyer_email:"buyer@example.test",...catalogDefaults(service),target_scope:"Customer-owned requirements document",authorization_attested:true});
  await assert.rejects(()=>submitPaymentReceipt(db,order.id,order.access_token,{tx_hash:TX}),/order-bound/);
  await createPaymentIntent(db,"service_order",order.id,TREASURY,order.quoted_atomic);
  await submitPaymentReceipt(db,order.id,order.access_token,{tx_hash:TX});
  const intent=db.prepare("SELECT * FROM checkout_payment_intents").first(),env={DB:db,TREASURY_WALLET_ADDRESS:TREASURY};
  assert.equal((await processPendingOrders(env,rpcFixture(intent))).verified,1);
  assert.equal((await processPendingOrders(env,rpcFixture(intent))).verified,0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks").first().n,1);
});
const subscribe=()=>({name:"Example business",contact_email:"owner@example.test",plan_id:"psa-workspace",max_assets:3,authorized_domains:["example.test"],authorization_attested:true,data_processing_consent:true,terms_accepted:true,request_key:crypto.randomUUID()});
const environment=db=>({DB:db,SCOUT_ADMIN_TOKEN:"test-only-owner-token",TREASURY_WALLET_ADDRESS:TREASURY,MAG_SUBSCRIPTION_PLANS:"psa-workspace"});
test("subscription quote is server-controlled and calendar month handling clamps month end",()=>{
  assert.equal(monthlyQuote("psa-workspace",100),"79000000");
  assert.equal(monthlyQuote("managed-visibility",2),"79000000");
  assert.equal(new Date(nextCalendarMonth(Date.UTC(2028,0,31))).toISOString(),"2028-02-29T00:00:00.000Z");
  assert.throws(()=>monthlyQuote("unknown",1));
});
test("paid subscription activates once, renews once, cancels and expires without any debit",async t=>{
  const db=new TestD1();t.after(()=>db.close());const env=environment(db),now=Date.now();
  const s=await createSubscription(env,subscribe(),now);
  assert.equal((await subscriptionState(db,s.id,s.access_token,now)).entitled,false);
  await subscriptionIntent(env,s.id,s.invoice_id,s.access_token);
  await submitSubscriptionReceipt(env,s.id,s.invoice_id,s.access_token,{tx_hash:TX},now);
  const intent=db.prepare("SELECT * FROM checkout_payment_intents").first();
  assert.equal((await processSubscriptions(env,rpcFixture(intent),now)).activated,1);
  assert.equal((await processSubscriptions(env,rpcFixture(intent),now)).activated,0);
  assert.equal((await subscriptionState(db,s.id,s.access_token,now)).entitled,true);
  const end=db.prepare("SELECT paid_through FROM managed_subscriptions").first().paid_through;
  assert.equal((await processSubscriptions(env,rpcFixture(intent),end-3*86400000)).renewal_invoices,1);
  assert.equal((await processSubscriptions(env,rpcFixture(intent),end-2*86400000)).renewal_invoices,0);
  await cancelSubscription(db,s.id,s.access_token,end-10000);
  assert.equal((await subscriptionState(db,s.id,s.access_token,end-1)).entitled,true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM subscription_invoices WHERE status='void'").first().n,1);
  await processSubscriptions(env,rpcFixture(intent),end+1);
  const state=await subscriptionState(db,s.id,s.access_token,end+1);
  assert.equal(state.entitled,false);assert.equal(state.subscription.status,"cancelled");assert.equal(state.automatic_debit,false);
});
test("subscription checkout refuses cross-tenant access, disabled plans and replayed transaction receipts",async t=>{
  const db=new TestD1();t.after(()=>db.close());const env=environment(db),input=subscribe();
  const first=await createSubscription(env,input);
  await assert.rejects(()=>createSubscription(env,input),/already created/);
  await assert.rejects(()=>createSubscription({...env,MAG_SUBSCRIPTION_PLANS:""},subscribe()),/not enabled/);
  await assert.rejects(()=>subscriptionState(db,first.id,"wrong"),/unauthorized/);
  await subscriptionIntent(env,first.id,first.invoice_id,first.access_token);
  await submitSubscriptionReceipt(env,first.id,first.invoice_id,first.access_token,{tx_hash:TX});
  await assert.rejects(()=>cancelSubscription(db,first.id,first.access_token),/being verified/);
  const second=await createSubscription(env,subscribe());
  await subscriptionIntent(env,second.id,second.invoice_id,second.access_token);
  await assert.rejects(()=>submitSubscriptionReceipt(env,second.id,second.invoice_id,second.access_token,{tx_hash:TX}),/already claimed/);
  assert.equal(db.prepare("SELECT status FROM subscription_invoices WHERE id=?").bind(second.invoice_id).first().status,"unpaid");
});
test("browser checkout accepts prefilled catalog data and overrides tampered prices and modes",async t=>{
  const db=new TestD1();t.after(()=>db.close());
  const body=new URLSearchParams({service_id:"sow-studio",catalog_checkout:"yes",buyer_name:"Buyer",buyer_email:"buyer@example.test",target_scope:"Our business requirements document",authorization_attested:"yes",max_budget_atomic:"1",execution_mode:"arbitrary"});
  const response=await worker.fetch(new Request("https://example.test/orders",{method:"POST",body}),environment(db));
  assert.equal(response.status,201);
  const html=await response.text();
  assert.ok(html.includes('id="wallet-pay"'));assert.ok(html.includes('/wallet-checkout.js'));
  assert.equal(db.prepare("SELECT quoted_atomic,execution_mode FROM service_orders").first().quoted_atomic,"49000000");
  assert.match(response.headers.get("content-security-policy"),/script-src 'self'/);
});
export { rpcFixture };

test("flat-rate PSA payment never grants per-device monitoring",async t=>{
 const db=new TestD1();t.after(()=>db.close());const env=environment(db),now=Date.now();
 const s=await createSubscription(env,subscribe(),now);
 await subscriptionIntent(env,s.id,s.invoice_id,s.access_token);
 await submitSubscriptionReceipt(env,s.id,s.invoice_id,s.access_token,{tx_hash:TX});
 await processSubscriptions(env,rpcFixture(db.prepare("SELECT * FROM checkout_payment_intents").first()),now);
 const {monitoringEntitled,registerDevice}=await import("../src/managed-ops.js");
 assert.equal(await monitoringEntitled(db,s.tenant_id,now),false);
 await assert.rejects(()=>registerDevice(db,s.tenant_id,s.access_token,{}),/paid monitoring/);
 const {createContract}=await import("../src/psa-billing.js");
 assert.ok((await createContract(db,s.tenant_id,s.access_token,{name:"Support agreement",customer_name:"Customer",hourly_atomic:"75000000"})).id);
});
test("paid monitoring enforces device capacity while allowing a same-device enrollment retry",async t=>{
 const db=new TestD1();t.after(()=>db.close());const env={...environment(db),MAG_SUBSCRIPTION_PLANS:"managed-visibility"},now=Date.now();
 const s=await createSubscription(env,{...subscribe(),plan_id:"managed-visibility",max_assets:1},now);
 await subscriptionIntent(env,s.id,s.invoice_id,s.access_token);
 await submitSubscriptionReceipt(env,s.id,s.invoice_id,s.access_token,{tx_hash:TX});
 await processSubscriptions(env,rpcFixture(db.prepare("SELECT * FROM checkout_payment_intents").first()),now);
 const {monitoringEntitled,registerDevice,deviceEnrollmentPreimage}=await import("../src/managed-ops.js");
 assert.equal(await monitoringEntitled(db,s.tenant_id,now),true);
 const key=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);
 const publicKey=Buffer.from(await crypto.subtle.exportKey("raw",key.publicKey)).toString("base64url");
 const input=async asset=>({asset_id:asset,public_key:publicKey,signed_at:now,signature:Buffer.from(await crypto.subtle.sign({name:"Ed25519"},key.privateKey,new TextEncoder().encode(deviceEnrollmentPreimage({tenantId:s.tenant_id,assetId:asset,publicKey,signedAt:now})))).toString("base64url")});
 const first=await input("device-one");
 await registerDevice(db,s.tenant_id,s.access_token,first,now);
 await registerDevice(db,s.tenant_id,s.access_token,first,now);
 const second=await input("device-two");
 await assert.rejects(()=>registerDevice(db,s.tenant_id,s.access_token,second,now),/asset limit/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM managed_devices").first().n,1);
});


test("specialized catalog checkout records scope without requesting an unavailable service payment",async t=>{
 const db=new TestD1();t.after(()=>db.close());const env=environment(db);
 for(const id of ["migration-fabric","static-scan-review","focused-code-review","application-review"]){
  const html=catalogPage(id,true,["psa-workspace"]);
  assert.ok(html.includes('action="/intake/'),id);
  assert.ok(html.includes('no payment yet'),id);
 }
 const req=new Request("https://example.test/intake/security-reviews",{method:"POST",headers:{origin:"https://example.test"},body:new URLSearchParams({tier_id:"static-scan-review",organization:"Customer",contact_email:"owner@example.test",repository_url:"https://github.com/example/repository",commit_sha:"a".repeat(40),scope_paths:"src/",declared_loc:"100",declared_file_count:"5",authorization_attested:"yes",quoted_atomic:"1"})});
 const result=await worker.fetch(req,env);assert.equal(result.status,201);
 assert.equal(db.prepare("SELECT quoted_atomic,payment_status FROM security_reviews").first().quoted_atomic,"49000000");
 assert.equal(db.prepare("SELECT payment_status FROM security_reviews").first().payment_status,"not_requested");
 const bad=await worker.fetch(new Request("https://example.test/intake/security-reviews",{method:"POST",headers:{origin:"https://evil.example"},body:new URLSearchParams()}),env);
 assert.equal(bad.status,403);
});
test("subscription forms expose only enabled plans and reject cross-origin signup",async t=>{
 const db=new TestD1();t.after(()=>db.close());const env=environment(db);
 const page=await worker.fetch(new Request("https://example.test/hire?service=managed-ops-psa"),env);
 const html=await page.text();
 assert.ok(html.includes('<option value="psa-workspace">'));
 assert.ok(!html.includes('<option value="managed-security">'));
 const rejected=await worker.fetch(new Request("https://example.test/subscriptions",{method:"POST",headers:{origin:"https://evil.example"},body:new URLSearchParams()}),env);
 assert.equal(rejected.status,403);
});
test("receipt delivery can be retried without creating another event or claim",async t=>{
 const db=new TestD1();t.after(()=>db.close());const env=environment(db);
 const s=await createSubscription(env,subscribe());
 await subscriptionIntent(env,s.id,s.invoice_id,s.access_token);
 await submitSubscriptionReceipt(env,s.id,s.invoice_id,s.access_token,{tx_hash:TX});
 assert.equal((await submitSubscriptionReceipt(env,s.id,s.invoice_id,s.access_token,{tx_hash:TX})).status,"pending_verification");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM subscription_events WHERE kind='payment_submitted'").first().n,1);
 const service=SERVICES[0],order=await createOrder(db,{service_id:service.id,buyer_name:"Buyer",buyer_email:"buyer@example.test",...catalogDefaults(service),target_scope:"Customer-owned requirements document",authorization_attested:true});
 await createPaymentIntent(db,"service_order",order.id,TREASURY,order.quoted_atomic);
 const tx="0x"+"9".repeat(64);
 await submitPaymentReceipt(db,order.id,order.access_token,{tx_hash:tx});
 await submitPaymentReceipt(db,order.id,order.access_token,{tx_hash:tx});
 assert.equal(db.prepare("SELECT COUNT(*) n FROM order_events WHERE kind='payment_receipt_submitted'").first().n,1);
});
test("private invoice session reopens checkout without placing a token in the URL",async t=>{
 const db=new TestD1();t.after(()=>db.close());
 const form=new URLSearchParams({service_id:"sow-studio",catalog_checkout:"yes",buyer_name:"Buyer",buyer_email:"buyer@example.test",target_scope:"Our authorized project requirements",authorization_attested:"yes"});
 const first=await worker.fetch(new Request("https://example.test/orders",{method:"POST",body:form}),environment(db));
 assert.equal(first.status,201);
 const cookie=first.headers.get("set-cookie");
 assert.match(cookie,/Secure; HttpOnly; SameSite=Strict/);
 const reopened=await worker.fetch(new Request("https://example.test/orders/status",{headers:{cookie:cookie.split(";")[0]}}),environment(db));
 assert.equal(reopened.status,200);
 const html=await reopened.text();
 assert.ok(html.includes('id="wallet-pay"'));
 assert.ok(!html.includes('name="tx_hash"'));
});
