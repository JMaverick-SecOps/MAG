import test from "node:test";
import assert from "node:assert/strict";
import { TestD1 } from "./helpers/d1.js";
import { scanPublicWork, runHostedAgentCycle, recentHostedRuns, INTERVAL } from "../src/hosted-agent.js";
const NOW=Date.parse("2026-08-30T22:45:00Z"), DAY=86400000;
const row={id:17,title:"Documentation subject binding",amount_atomic:"500000",funds_seen_atomic:"71000000",chain_id:8453,token:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",expiry:Math.floor(NOW/1000)+864000,withdrawn_at:null,submissions:6,record:"https://evil.invalid/run"};
function sources(mutate=()=>{}){
 const calls=[];
 const fetcher=async (url,init)=>{
  calls.push(url);assert.equal(init.method,"GET");assert.equal(init.redirect,"manual");assert.ok(init.signal);
  const path=new URL(url).pathname;assert.equal(new URL(url).origin,"https://1f916.ai");
  let value=path.endsWith("/guide")||path.endsWith("/security")?{rules_version:"2026-08-17.1"}:path==="/api/listings"?{listings:[{...row}],has_more:false}:{listing:{id:17,condition:"Document and test the exact named revision and reject any mismatched checkout."}};
  const changed=mutate(value,path);
  return changed instanceof Response?changed:Response.json(value);
 };
 return {fetcher,calls};
}
function fixture(t,handles=["citizen-test"]){
 const db=new TestD1();t.after(()=>db.close());
 for(const handle of handles){
  db.prepare("INSERT INTO guild_applications(id,handle,status,registry_verified_at,created_at,updated_at) VALUES(?,?,'active',?,?,?)").bind(crypto.randomUUID(),handle,NOW,NOW,NOW).run();
  db.prepare("INSERT INTO agent_connection_invoices(id,handle,amount_atomic,treasury_address,calldata,status,tx_hash,period_start,period_end,created_at,verified_at) VALUES(?,?,'1000000',?,?,'paid',?,?,?,?,?)")
   .bind(crypto.randomUUID(),handle,"0x"+"a".repeat(40),"fixture-"+handle,"0x"+"b".repeat(64),NOW,NOW+DAY,NOW,NOW).run();
 }
 return {db,env:{DB:db,MAG_AGENT_CONNECTIONS_ENABLED:"true",MAG_HOSTED_WORK_WATCH_ENABLED:"true"}};
}
test("hosted recipe reads policy before listings, hashes sources, scores conservatively and never follows source URLs",async()=>{
 const s=sources(),report=await scanPublicWork(s.fetcher,NOW);
 assert.deepEqual(s.calls,["https://1f916.ai/api/listings/guide","https://1f916.ai/api/listings/security","https://1f916.ai/api/listings","https://1f916.ai/api/listings/17"]);
 assert.equal(report.listing_count,1);assert.equal(report.listings[0].review_priority,44);
 assert.equal(report.listings[0].funding.current_available,"unverified");
 assert.equal(report.listings[0].novelty,"unverified");assert.equal(report.accepted_work,false);
 assert.match(report.semantic_sha256,/^[0-9a-f]{64}$/);assert.equal(report.sources.length,4);
});
test("unavailable, oversized, partial or substituted listing sources fail closed",async()=>{
 const mutations=[
  (v,p)=>p.endsWith("/guide")?new Response("",{status:503}):null,
  (v,p)=>{if(p.endsWith("/security"))delete v.rules_version;},
  (v,p)=>{if(p==="/api/listings")v.has_more=true;},
  (v,p)=>{if(p==="/api/listings")v.listings[0].id="../admin";},
  (v,p)=>{if(p==="/api/listings/17")v.listing.id=18;},
  (v,p)=>{if(p==="/api/listings")v.listings[0].payload_hash="a".repeat(64);},
  (v,p)=>p.endsWith("/guide")?new Response("x".repeat(131073)):null
 ];
 for(const mutation of mutations)await assert.rejects(()=>scanPublicWork(sources(mutation).fetcher,NOW));
});
test("live detail shape binds listing_id, not its opaque record id",async()=>{
 const fetched=sources((v,p)=>{
  if(p==="/api/listings/17")return Response.json({id:"opaque-public-record",listing_id:17,condition:v.listing.condition});
 });
 assert.equal((await scanPublicWork(fetched.fetcher,NOW)).listings[0].id,17);
 const substituted=sources((v,p)=>p==="/api/listings/17"?Response.json({id:17,listing_id:18,condition:v.listing.condition}):null);
 await assert.rejects(()=>scanPublicWork(substituted.fetcher,NOW),/schema_changed/);
});
test("disabled, unpaid, expired and suspended connections do no network work",async t=>{
 const f=fixture(t);let calls=0;const denied=async()=>{calls++;throw Error("unexpected");};
 assert.equal((await runHostedAgentCycle({...f.env,MAG_HOSTED_WORK_WATCH_ENABLED:"false"},denied,NOW,()=>NOW)).enabled,false);
 assert.equal((await runHostedAgentCycle(f.env,denied,NOW+DAY,()=>NOW+DAY)).claimed,0);
 f.db.prepare("UPDATE guild_applications SET status='suspended'").run();
 assert.equal((await runHostedAgentCycle(f.env,denied,NOW,()=>NOW)).claimed,0);
 const empty=fixture(t,[]);
 assert.equal((await runHostedAgentCycle(empty.env,denied,NOW,()=>NOW)).claimed,0);
 assert.equal(calls,0);
});
test("paid connection yields an immutable retrievable artifact and one deduplicated delivery event",async t=>{
 const f=fixture(t),s=sources();
 assert.equal((await runHostedAgentCycle(f.env,s.fetcher,NOW,()=>NOW+5)).completed,1);
 const runs=await recentHostedRuns(f.db,"citizen-test");
 assert.equal(runs[0].status,"completed");assert.equal(runs[0].artifact.handle,"citizen-test");
 const hash=Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(runs[0].artifact)))).toString("hex");
 assert.equal(runs[0].artifact_sha256,hash);
 assert.throws(()=>f.db.prepare("UPDATE agent_hosted_runs SET status='failed'").run(),/retain/);
 assert.equal((await runHostedAgentCycle(f.env,s.fetcher,NOW+INTERVAL,()=>NOW+INTERVAL)).completed,1);
 const newer=await recentHostedRuns(f.db,"citizen-test");
 assert.equal(newer[0].artifact.observation,"no_new_signal");
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_events").first().n,1);
 assert.equal(f.db.prepare("SELECT kind FROM notification_events").first().kind,"agent_connection_delivery");
 assert.equal((await recentHostedRuns(f.db,"other-citizen")).length,0);
});
test("concurrent cron deliveries have one winner per citizen and time slot",async t=>{
 const f=fixture(t),s=sources();
 const results=await Promise.all([runHostedAgentCycle(f.env,s.fetcher,NOW,()=>NOW),runHostedAgentCycle(f.env,s.fetcher,NOW,()=>NOW)]);
 assert.equal(results.reduce((n,r)=>n+r.completed,0),1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM agent_hosted_runs").first().n,1);
 assert.equal(s.calls.length,4);
});
test("source failure records failure, not a fake completed artifact",async t=>{
 const f=fixture(t);
 const outcome=await runHostedAgentCycle(f.env,async()=>new Response("",{status:503}),NOW,()=>NOW);
 assert.equal(outcome.failed,1);assert.equal(outcome.completed,0);
 const run=(await recentHostedRuns(f.db,"citizen-test"))[0];
 assert.equal(run.status,"failed");assert.equal(run.artifact,null);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM notification_events").first().n,0);
});
test("expiry or suspension during a scan cancels delivery",async t=>{
 for(const suspend of [false,true]){
  const f=fixture(t),s=sources((v,p)=>{if(suspend&&p==="/api/listings")f.db.prepare("UPDATE guild_applications SET status='suspended'").run();});
  const result=await runHostedAgentCycle(f.env,s.fetcher,NOW,()=>suspend?NOW:NOW+DAY);
  assert.equal(result.completed,0);
  assert.equal((await recentHostedRuns(f.db,"citizen-test"))[0].status,"cancelled");
 }
});
test("five-identity cap is fair and shares the public read set",async t=>{
 const handles=Array.from({length:6},(_,i)=>"citizen-"+i),f=fixture(t,handles),s=sources();
 assert.equal((await runHostedAgentCycle(f.env,s.fetcher,NOW,()=>NOW)).completed,5);
 assert.equal(s.calls.length,4);
 await runHostedAgentCycle(f.env,s.fetcher,NOW+INTERVAL,()=>NOW+INTERVAL);
 assert.equal(f.db.prepare("SELECT COUNT(DISTINCT handle) n FROM agent_hosted_runs WHERE status='completed'").first().n,6);
});
test("expired leases recover without allowing a late worker to overwrite delivery",async t=>{
 const f=fixture(t),invoice=f.db.prepare("SELECT id FROM agent_connection_invoices").first().id;
 f.db.prepare("INSERT INTO agent_hosted_runs(id,handle,invoice_id,slot,lease_token,status,started_at) VALUES(?,'citizen-test',?,?,'old','running',?)")
  .bind(crypto.randomUUID(),invoice,Math.floor(NOW/INTERVAL),NOW-300001).run();
 assert.equal((await runHostedAgentCycle(f.env,sources().fetcher,NOW,()=>NOW)).completed,1);
 assert.notEqual(f.db.prepare("SELECT lease_token FROM agent_hosted_runs").first().lease_token,"old");
 assert.throws(()=>f.db.prepare("UPDATE agent_hosted_runs SET artifact_json='{}'").run(),/retain/);
});
