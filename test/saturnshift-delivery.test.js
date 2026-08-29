import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifySaturnShiftDelivery } from "../src/saturnshift-delivery.js";
import { handleSaturnShiftWebhook, paymentProviderOptions } from "../src/saturnshift-checkout.js";
const SECRET = "fixture-only-not-a-provider-credential";
function delivery(body = JSON.stringify({type:"webhook.test"}), options = {}) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const bytes = Buffer.from(body);
  const signature = createHmac("sha256", options.secret ?? SECRET).update(timestamp + ".").update(bytes).digest("hex");
  return new Request("https://mag.example/api/webhooks/saturnshift", {
    method:"POST", headers:{"content-type":"application/json","SaturnShift-Signature":options.header ?? `t=${timestamp},v1=${signature}`},
    body:options.wireBody ?? bytes,
  });
}
const noWrites = { prepare() { assert.fail("test delivery must not query or mutate the database"); }, batch() { assert.fail("no financial write"); } };
test("provider-style signed test acknowledges delivery, never payment or fulfillment", async()=>{
  for(let retry=0;retry<2;retry++){
    const response=await handleSaturnShiftWebhook(delivery(),{DB:noWrites,SATURNSHIFT_WEBHOOK_SECRET:SECRET});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{received:true,signature_verified:true,test_event:true,applied:false,payment_intake_enabled:false});
  }
  const provider=paymentProviderOptions({SATURNSHIFT_WEBHOOK_SECRET:SECRET}).saturnshift;
  assert.equal(provider.delivery_test.secret_configured,true);
  assert.equal(provider.configured,false);
});
test("signed test handshake does not require a marketplace database",async()=>{
  assert.equal((await handleSaturnShiftWebhook(delivery(),{SATURNSHIFT_WEBHOOK_SECRET:SECRET})).status,200);
});
test("missing secret cannot claim a verified test",async()=>{
  const response=await handleSaturnShiftWebhook(delivery(),{});
  assert.equal(response.status,503);
  assert.equal((await response.json()).signature_verified,undefined);
});
test("tampering, a wrong key and altered whitespace fail exact-byte verification",async()=>{
  for(const request of [delivery(undefined,{secret:"wrong-fixture-secret-value"}),delivery(undefined,{wireBody:'{"type": "webhook.test"}'})]){
    assert.equal((await handleSaturnShiftWebhook(request,{SATURNSHIFT_WEBHOOK_SECRET:SECRET,DB:noWrites})).status,401);
  }
});
test("stale, future and duplicate signature headers are rejected",async()=>{
  const now=1787860000;
  for(const timestamp of [now-301,now+301]){
    await assert.rejects(()=>verifySaturnShiftDelivery(delivery(undefined,{timestamp}),SECRET,now),/stale/);
  }
  for(const header of ["t=1787860000,v1="+"a".repeat(64)+",v1="+"b".repeat(64),"t=1787860000,t=1787860001,v1="+"a".repeat(64),"t=1787860000,v1=00"]){
    await assert.rejects(()=>verifySaturnShiftDelivery(delivery(undefined,{header}),SECRET,now),/invalid.*signature/);
  }
});
test("oversized, malformed and structurally invalid signed bodies are rejected",async()=>{
  for(const [body,status] of [[" ".repeat(65537),413],["not-json",400],["[]",400],['{"type":2}',400],[Buffer.from([255]),400]]){
    assert.equal((await handleSaturnShiftWebhook(delivery(body),{SATURNSHIFT_WEBHOOK_SECRET:SECRET,DB:noWrites})).status,status);
  }
});
test("structurally incomplete payment, settlement and refund deliveries are rejected without writes",async()=>{
  for(const type of ["payment.succeeded","payment.paid","payment.refunded","payment.expired","payment.pending"]){
    const response=await handleSaturnShiftWebhook(delivery(JSON.stringify({type,data:{external_reference:crypto.randomUUID()}})),{SATURNSHIFT_WEBHOOK_SECRET:SECRET,DB:noWrites});
    assert.equal(response.status,422);
    assert.match((await response.json()).error,/invalid_saturnshift_payload_contract/);
  }
});
