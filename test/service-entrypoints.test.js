import test from "node:test";
import assert from "node:assert/strict";
import { TIERS, securityReviewPage } from "../src/security-services.js";
import { catalogPage } from "../src/catalog-checkout.js";
import { serviceById, createOrder } from "../src/commerce.js";
import { managedOpsPage } from "../src/managed-ops.js";
import worker from "../src/index.js";
test("every security card selects its priced, scope-gated package",async()=>{
  const landing=securityReviewPage();
  for(const tier of TIERS){
    assert.ok(landing.includes('href="/hire?service='+tier.id+'#checkout"'));
    assert.equal(serviceById(tier.id).from_atomic,tier.price_atomic);
    const checkout=catalogPage(tier.id,true);
    assert.ok(checkout.includes('name="tier_id" value="'+tier.id+'"'));
    assert.ok(checkout.includes('action="/intake/security-reviews"'));
    assert.ok(checkout.includes('max="'+tier.max_loc+'"'));
    assert.ok(!checkout.includes('action="/orders"'));
    await assert.rejects(()=>createOrder({prepare(){assert.fail("must not write");}},{service_id:tier.id}),/preflight/);
  }
});
test("RMM product page connects sample demo, tenant signup and true integration readiness",()=>{
  const page=managedOpsPage();
  for(const href of ['#demo','/hire?service=managed-ops-psa#checkout','/ops/console','/ops/screenconnect']){
    assert.ok(page.includes('href="'+href+'"'));
  }
  assert.ok(page.includes('id="demo"'));
  assert.match(page,/logical isolation in shared infrastructure/);
  assert.match(page,/Microsoft 365 &amp; Intune/);
  assert.match(page,/Google Workspace/);
  assert.match(page,/Planned · not available for activation/);
  assert.match(page,/Sample dashboard · fictional data/);
});
test("RMM plan buttons preselect an allowed plan without trusting the query as pricing",async()=>{
  const env={DB:{},SCOUT_ADMIN_TOKEN:"test-owner",TREASURY_WALLET_ADDRESS:"0x"+"a".repeat(40),MAG_SUBSCRIPTION_PLANS:"psa-workspace,managed-visibility"};
  for(const plan of ["psa-workspace","managed-visibility"]){
    const response=await worker.fetch(new Request("https://mag.example/hire?service=managed-ops-psa&plan="+plan),env);
    assert.equal(response.status,200);
    const page=await response.text();
    assert.ok(page.includes('<option value="'+plan+'" selected>'));
    assert.ok(page.includes('action="/subscriptions"'));
    assert.ok(!page.includes('name="quoted_atomic"'));
  }
  const page=catalogPage("managed-ops-psa",true,["psa-workspace"],'"><script>alert(1)</script>');
  assert.ok(!page.includes("<script>"));assert.ok(!page.includes("managed-visibility\" selected"));
});
