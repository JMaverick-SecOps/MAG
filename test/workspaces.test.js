import test from "node:test";
import assert from "node:assert/strict";
import { TestD1 } from "./helpers/d1.js";
import worker from "../src/index.js";
import { createManagedTenant } from "../src/managed-ops.js";
import { createTicket, listTickets, updateTicket } from "../src/service-desk.js";
import { managedConsoleResponse, renderConsole } from "../src/managed-console.js";
import { createOrder } from "../src/commerce.js";
import { orderStatusResponse } from "../src/order-views.js";

async function tenant(db,name="Example IT"){
 const created=await createManagedTenant(db,{name,contact_email:"owner@example.test",plan_id:"psa-workspace",max_assets:25,authorized_domains:["example.test"],authorization_attested:true,data_processing_consent:true});
 await db.prepare("UPDATE managed_tenants SET status='active' WHERE id=?").bind(created.id).run();
 return created;
}
const request={title:"Review backup evidence",description:"The approved backup status report needs review.",severity:"high",request_key:"test_request_000001"};
const metricCards=body=>Object.fromEntries([...body.matchAll(new RegExp('<div class="card">([^<]+)<b>([^<]*)</b></div>',"g"))].map(match=>[match[1],match[2]]));
const dashboardFixture=coverage=>({
 tenant:{id:"test-only-tenant",name:"Example IT"},branding:{},
 assets:{total:0,reporting:0,stale:0},tickets:{open:0,pending_approvals:0},
 patch:{coverage_percent:coverage},backup:{coverage_percent:coverage},
 security:{recent_findings_30d:0},generated_at:0
});
test("service desk creates one ticket, enforces tenant scope and preserves immutable history",async t=>{
 const db=new TestD1();t.after(()=>db.close());const owner=await tenant(db),other=await tenant(db,"Other IT");
 const ticket=await createTicket(db,owner.id,owner.access_token,request);
 assert.equal((await createTicket(db,owner.id,owner.access_token,request)).duplicate,true);
 await assert.rejects(()=>createTicket(db,owner.id,owner.access_token,{...request,title:"Different same request"}),/different ticket/);
 await assert.rejects(()=>listTickets(db,owner.id,other.access_token),/authorization/);
 await assert.rejects(()=>updateTicket(db,other.id,other.access_token,ticket.id,{status:"resolved",note:"Evidence shows the backup succeeded",expected_version:1}),/not found/);
 await updateTicket(db,owner.id,owner.access_token,ticket.id,{status:"resolved",note:"Verified the backup receipt against the approved evidence.",expected_version:1});
 await assert.rejects(()=>updateTicket(db,owner.id,owner.access_token,ticket.id,{status:"closed",note:"Close after independent verification",expected_version:1}),/reload/);
 const rows=await listTickets(db,owner.id,owner.access_token);assert.equal(rows[0].version,2);assert.equal(rows[0].status,"resolved");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM managed_ticket_events").first().n,2);
 assert.throws(()=>db.prepare("DELETE FROM managed_ticket_events").run(),/append-only/);
});
test("live white-label console renders scoped database metrics and working ticket forms",async t=>{
 const db=new TestD1();t.after(()=>db.close());const owner=await tenant(db);
 const response=await managedConsoleResponse({DB:db},{tenant_id:owner.id,access_token:owner.access_token});
 assert.equal(response.status,200);const body=await response.text();
 assert.match(body,/Example IT/);assert.match(body,/No service requests/);assert.match(body,/action="\/ops\/console"/);
 assert.equal(metricCards(body).Assets,"0");
 assert.equal(metricCards(body)["Open tickets"],"0");
 assert.doesNotMatch(body,/NS-DEN-LT/);
 assert.equal(response.headers.get("referrer-policy"),"no-referrer");
});
test("console metric assertions ignore numeric fragments in opaque test credentials",async()=>{
 const d=dashboardFixture(0);
 const body=await renderConsole(d,[],"test-only-opaque-148-token").text();
 assert.equal(metricCards(body).Assets,"0");
 const actualCount=await renderConsole({...d,assets:{...d.assets,total:148}},[],"test-only-token").text();
 assert.equal(metricCards(actualCount).Assets,"148");
});
test("console renders missing and invalid coverage as Unknown",async()=>{
 for(const value of [null,undefined,NaN,Infinity,-1,101,"0"]){
  const cards=metricCards(await renderConsole(dashboardFixture(value),[],"test-only-token").text());
  assert.equal(cards["Patch evidence"],"Unknown");
  assert.equal(cards["Backup evidence"],"Unknown");
 }
});
test("console preserves measured coverage including zero",async()=>{
 for(const value of [0,25.5,100]){
  const cards=metricCards(await renderConsole(dashboardFixture(value),[],"test-only-token").text());
  assert.equal(cards["Patch evidence"],String(value)+"%");
  assert.equal(cards["Backup evidence"],String(value)+"%");
 }
});
test("customer invoice is clickable and private status never accepts an invalid token",async t=>{
 const db=new TestD1();t.after(()=>db.close());
 const form=new URLSearchParams({buyer_name:"Buyer",buyer_email:"buyer@example.test",service_id:"website-starter",objective:"Build an accessible one page website for our approved demo.",acceptance_criteria:"All responsive checks and accessibility tests pass in the artifact.",target_scope:"Customer-owned example.test staging repository",execution_mode:"pull_request",max_budget_atomic:"99000000",authorization_attested:"yes"});
 const response=await worker.fetch(new Request("https://example.test/orders",{method:"POST",body:form}),{DB:db,SCOUT_ADMIN_TOKEN:"test-only-owner-token",TREASURY_WALLET_ADDRESS:"0x"+"a".repeat(40)});
 assert.equal(response.status,201);const body=await response.text();
 assert.match(body,/View order progress and delivery/);
 assert.doesNotMatch(body,/Open SaturnShift payment options/);
 const order=db.prepare("SELECT id FROM service_orders").first();
 assert.equal((await orderStatusResponse({DB:db},order.id,"wrong-token")).status,404);
});
test("integration and console routes are available but fail closed without configuration",async()=>{
 for(const path of ["/ops/console","/ops/screenconnect","/orders/status"]) assert.equal((await worker.fetch(new Request("https://example.test"+path),{})).status,200);
 const res=await worker.fetch(new Request("https://example.test/api/webhooks/saturnshift",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),{});
 assert.equal(res.status,503);
});
test("generic orders cannot bypass preflight for unconfigured products",async t=>{
 const db=new TestD1();t.after(()=>db.close());
 for(const service_id of ["migration-fabric","managed-ops-psa","static-scan-review"]) await assert.rejects(()=>createOrder(db,{service_id}),/preflight/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM service_orders").first().n,0);
});

test("paid intake fails closed without owner review access, storage, or treasury configuration", async t => {
 const db = new TestD1(); t.after(() => db.close());
 const ready = { DB: db, SCOUT_ADMIN_TOKEN: "test-only-owner-token", TREASURY_WALLET_ADDRESS: "0x" + "a".repeat(40) };
 for (const missing of ["DB", "SCOUT_ADMIN_TOKEN", "TREASURY_WALLET_ADDRESS"]) {
  const unavailable = { ...ready, [missing]: undefined };
  for (const path of ["/orders", "/api/orders", "/bounties", "/api/bounties", "/orders/00000000-0000-4000-8000-000000000001/checkout"]) {
   const res = await worker.fetch(new Request("https://example.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), unavailable);
   assert.equal(res.status, 503);
   assert.equal((await res.json()).error, "paid_intake_unavailable");
  }
  const catalog = await worker.fetch(new Request("https://example.test/hire?service=website-starter"), unavailable);
  assert.match(await catalog.text(), /Paid intake is temporarily unavailable/);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  const providers = await worker.fetch(new Request("https://example.test/api/payment-providers"), unavailable);
  assert.equal((await providers.json()).paid_intake_ready, false);
 }
 assert.equal(db.prepare("SELECT COUNT(*) n FROM service_orders").first().n, 0);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM bounty_requests").first().n, 0);
 const catalog = await worker.fetch(new Request("https://example.test/hire"), ready);
 assert.doesNotMatch(await catalog.text(), /Paid intake is temporarily unavailable/);
});
