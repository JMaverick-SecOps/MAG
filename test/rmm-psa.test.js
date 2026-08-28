import test from "node:test";
import assert from "node:assert/strict";
import { TestD1 } from "./helpers/d1.js";
import { createManagedTenant, registerDevice, deviceEnrollmentPreimage } from "../src/managed-ops.js";
import { createTicket } from "../src/service-desk.js";
import { createContract, logTime, reviewTime, draftInvoice, billingSummary } from "../src/psa-billing.js";
import { validateRunbook, devicePreimage, createJob, decideJob, leaseJob, recordJobResult } from "../src/rmm-jobs.js";
import { executeRunbook, assertService, telemetryEvents } from "../agents/mag-endpoint.mjs";

test("endpoint outbox retries delivery after lost acknowledgements without executing again",async()=>{
 const {DatabaseSync}=await import("node:sqlite");
 const {persistJobExecution,flushJobResults}=await import("../agents/mag-endpoint.mjs");
 const db=new DatabaseSync(":memory:");db.exec("CREATE TABLE result_outbox(id TEXT PRIMARY KEY,result_json TEXT NOT NULL,acknowledged INTEGER DEFAULT 0,created_at INTEGER NOT NULL)");
 try{
  const job={id:crypto.randomUUID(),lease_token:"fixture"},execute=async()=>{calls++;return {status:"succeeded",result_code:"done"};};let calls=0;
  await persistJobExecution(db,job,execute);
  await assert.rejects(()=>flushJobResults(db,async()=>{throw new Error("lost_ack");}),/lost_ack/);
  await persistJobExecution(db,job,execute);
  assert.equal(calls,1);
  await flushJobResults(db,async p=>{assert.equal(p.job_id,job.id);return {recorded:true};});
  assert.equal(db.prepare("SELECT acknowledged FROM result_outbox WHERE id=?").get(job.id).acknowledged,1);
  assert.equal(calls,1);
 }finally{db.close();}
});

async function fixture(db) {
 const t=await createManagedTenant(db,{name:"Authorized Org",contact_email:"owner@example.test",plan_id:"psa-workspace",max_assets:3,authorized_domains:["example.test"],authorization_attested:true,data_processing_consent:true});
 db.prepare("UPDATE managed_tenants SET status='active' WHERE id=?").bind(t.id).run();
 return t;
}
test("PSA time billing is scoped, reviewed, snapshotted and cannot invoice work twice",async t=>{
 const db=new TestD1();t.after(()=>db.close());const tenant=await fixture(db),other=await fixture(db);
 const contract=await createContract(db,tenant.id,tenant.access_token,{name:"Support agreement",customer_name:"Example Customer",hourly_atomic:"90000000"});
 const ticket=await createTicket(db,tenant.id,tenant.access_token,{title:"Customer diagnostic request",description:"Inspect the authorized application behavior and document the result.",request_key:crypto.randomUUID()});
 const input={contract_id:contract.id,ticket_id:ticket.id,minutes:30,note:"Verified the configuration against the approved test plan.",request_key:crypto.randomUUID()};
 await assert.rejects(()=>logTime(db,other.id,other.access_token,input),/belong/);
 const entry=await logTime(db,tenant.id,tenant.access_token,input);
 assert.equal(entry.amount_atomic,"45000000");
 await assert.rejects(()=>draftInvoice(db,tenant.id,tenant.access_token,{contract_id:contract.id,request_key:crypto.randomUUID()}),/no approved/);
 await reviewTime(db,tenant.id,tenant.access_token,entry.id,{status:"approved"});
 const request={contract_id:contract.id,request_key:crypto.randomUUID()},invoice=await draftInvoice(db,tenant.id,tenant.access_token,request);
 assert.equal(invoice.amount_atomic,"45000000");assert.equal(invoice.automatic_charge,false);
 assert.equal((await draftInvoice(db,tenant.id,tenant.access_token,request)).id,invoice.id);
 await assert.rejects(()=>draftInvoice(db,tenant.id,tenant.access_token,{...request,request_key:crypto.randomUUID()}),/no approved/);
 assert.equal((await billingSummary(db,tenant.id,tenant.access_token)).invoices.length,1);
});
async function device(db,tenant) {
 const pair=await crypto.subtle.generateKey({name:"Ed25519"},true,["sign","verify"]);
 const publicKey=Buffer.from(await crypto.subtle.exportKey("raw",pair.publicKey)).toString("base64url");
 const sign=async v=>Buffer.from(await crypto.subtle.sign({name:"Ed25519"},pair.privateKey,new TextEncoder().encode(v))).toString("base64url");
 const asset="test-device",now=Date.now();
 await registerDevice(db,tenant.id,tenant.access_token,{asset_id:asset,public_key:publicKey,signed_at:now,signature:await sign(deviceEnrollmentPreimage({tenantId:tenant.id,assetId:asset,publicKey,signedAt:now}))});
 return async(action,payload={})=>{const input={tenant_id:tenant.id,asset_id:asset,nonce:crypto.randomUUID(),signed_at:Date.now(),payload};return {...input,signature:await sign(await devicePreimage(action,input))};};
}
test("RMM jobs require a signed enrolled device and are leased at most once",async t=>{
 const db=new TestD1();t.after(()=>db.close());const tenant=await fixture(db),envelope=await device(db,tenant);
 const job=await createJob(db,tenant.id,tenant.access_token,{asset_id:"test-device",runbook:"collect_inventory",request_key:crypto.randomUUID()});
 const poll=await envelope("poll"),leased=await leaseJob(db,poll);
 assert.equal(leased.job.id,job.id);
 await assert.rejects(()=>leaseJob(db,poll));
 assert.equal((await leaseJob(db,await envelope("poll"))).job,null);
 await recordJobResult(db,await envelope("result",{job_id:job.id,lease_token:leased.job.lease_token,status:"succeeded",result_code:"inventory_collected",password:"discard-this"}));
 const row=db.prepare("SELECT status,result_json FROM managed_jobs WHERE id=?").bind(job.id).first();
 assert.equal(row.status,"succeeded");assert.ok(!row.result_json.includes("discard-this"));
});
test("change runbooks require both activation and explicit approval; protected services are rejected",async t=>{
 const db=new TestD1();t.after(()=>db.close());const tenant=await fixture(db),envelope=await device(db,tenant);
 const input={asset_id:"test-device",runbook:"restart_service",parameters:{service:"ExampleWorker"},request_key:crypto.randomUUID()};
 await assert.rejects(()=>createJob(db,tenant.id,tenant.access_token,input,{}),/certification/);
 for(const service of ["WinDefend","EventLog","anything;whoami","*","C:\\bin"])assert.throws(()=>validateRunbook({...input,parameters:{service}}));
 const job=await createJob(db,tenant.id,tenant.access_token,input,{MAG_RMM_CONTROL_ENABLED:"true"});
 assert.equal((await leaseJob(db,await envelope("poll"))).job,null);
 await assert.rejects(()=>decideJob(db,tenant.id,tenant.access_token,job.id,{decision:"approve"}),/confirmation/);
 await decideJob(db,tenant.id,tenant.access_token,job.id,{decision:"approve",scope_confirmed:true});
 assert.equal((await leaseJob(db,await envelope("poll"))).job.id,job.id);
});
test("endpoint dispatcher never executes supplied commands or unapproved service names",async()=>{
 let calls=0;const mock=async(executable,args,options)=>{calls++;assert.equal(options.env.MAG_SERVICE_NAME,"ExampleWorker");assert.equal(options.windowsHide,true);assert.ok(!args.some(x=>x==="ExampleWorker"));return {stdout:"Running\r\n"};};
 const job={id:crypto.randomUUID(),runbook:"restart_service",parameters:{service:"ExampleWorker"},expires_at:Date.now()+60000};
 await assert.rejects(()=>executeRunbook(job,{platform:"win32",allowedServices:["ExampleWorker"]},mock),/consent/);
 assert.equal(calls,0);
 assert.equal((await executeRunbook(job,{platform:"win32",allowedServices:["ExampleWorker"],allowRestart:true},mock)).status,"succeeded");
 assert.equal(calls,1);
 assert.throws(()=>assertService("WinDefend",["WinDefend"]));
 await assert.rejects(()=>executeRunbook({...job,runbook:"shell",command:"whoami"},{},mock),/unsupported/);
 assert.equal(calls,1);
 assert.ok(!JSON.stringify(telemetryEvents()).match(/username|hostname|ip_address|password|token/));
});
