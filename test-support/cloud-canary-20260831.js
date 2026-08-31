// Cloud-only, disposable verification harness. NEVER import from the production entrypoint.
import { signingPayload, operateConnection, processAgentConnections, handleAgentConnectionRoutes } from "../src/agent-connections.js";
import { runHostedAgentCycle, scanPublicWork } from "../src/hosted-agent.js";
import { RPCS, USDC } from "../src/payment-intents.js";
const PURPOSE="mag-agent-day-isolated-canary-v1";
const HANDLE="canary-synthetic-v4-not-a-citizen";
const TREASURY="0x"+"a".repeat(40), TX="0x"+"e".repeat(64), BLOCK="0x"+"c".repeat(64);
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const hex=bytes=>Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,"0")).join("");
function check(value,label){if(!value)throw Error(label);}
async function execute(env) {
 check(env.CANARY_PURPOSE===PURPOSE,"canary-only");
 check(env.CANARY_DATABASE_ID==="81efc150-ae75-4719-8d8b-db12f4a7acda","wrong-database");
 const db=env.DB.withSession("first-primary"), now=Date.now();
 const lock=await db.prepare("INSERT OR IGNORE INTO canary_receipts(id,status,created_at) VALUES('only-run-v4','running',?)").bind(now).run();
 if(lock.meta.changes!==1)return;
 let stage="setup";
 try {
  const core={DB:env.DB,MAG_AGENT_CONNECTIONS_ENABLED:"true",MAG_HOSTED_WORK_WATCH_ENABLED:"true",TREASURY_WALLET_ADDRESS:TREASURY};
  // Retain failed fixtures, but prevent them entering this separate test cohort.
  await db.prepare("UPDATE guild_applications SET status='suspended' WHERE handle IN ('canary-synthetic-not-a-citizen','canary-synthetic-v2-not-a-citizen','canary-synthetic-v3-not-a-citizen')").run();
  await db.prepare("INSERT INTO guild_applications(id,handle,status,registry_verified_at,created_at,updated_at) VALUES(?,?,'active',?,?,?)").bind(crypto.randomUUID(),HANDLE,now,now,now).run();
  const pair=await crypto.subtle.generateKey("Ed25519",false,["sign","verify"]);
  const publicKey=b64(await crypto.subtle.exportKey("raw",pair.publicKey));
  const keys=async url=>{check(url==="https://1f916.ai/api/keys/"+HANDLE,"unexpected-key-url");return Response.json({keys:[{public_key:publicKey,status:"active"}]});};
  const id=crypto.randomUUID();
  async function signed(action,tx=""){
   const payload=await signingPayload(core,{action,handle:HANDLE,invoice_id:id,tx_hash:tx});
   return {...payload,signature:b64(await crypto.subtle.sign("Ed25519",pair.privateKey,new TextEncoder().encode(payload.preimage)))};
  }
  // Payment providers were independently checked and are unavailable at this edge.
  // Do not retry their limits or call this a payment-readiness test. The test below
  // isolates signed accounting + actual hosted delivery using synthetic settlement.
  stage="live-identity-transport";
  const liveKeys=await fetch("https://1f916.ai/api/keys/mavverick-scout",{redirect:"manual",signal:AbortSignal.timeout(15000)});
  check(liveKeys.ok,"live-identity-http");
  stage="signed-invoice";
  const created=await operateConnection(core,await signed("invoice"),keys);
  check(created.invoice.status==="unpaid","must-start-unpaid");
  check((await runHostedAgentCycle(core,async()=>{throw Error("unpaid-fetch");})).claimed===0,"unpaid-execution");
  stage="signed-receipt";
  await operateConnection(core,await signed("receipt",TX),keys);
  const row=await db.prepare("SELECT calldata FROM agent_connection_invoices WHERE id=?").bind(id).first();
  function rpc(wrong=false){return async (url,init)=>{
   check(RPCS.includes(url),"unexpected-rpc");
   const method=JSON.parse(init.body).method;
   const result=method==="eth_chainId"?"0x2105":method==="eth_getTransactionReceipt"?{
    status:"0x1",transactionHash:TX,blockHash:BLOCK,blockNumber:"0x100",
    logs:[{address:USDC,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(64),"0x"+TREASURY.slice(2).padStart(64,"0")],data:wrong?"0xf4241":"0xf4240"}]
   }:method==="eth_getTransactionByHash"?{hash:TX,blockHash:BLOCK,to:USDC,input:row.calldata,value:"0x0"}:{number:"0x101"};
   return Response.json({result});
  };}
  stage="reject-wrong-amount";
  check((await processAgentConnections(core,rpc(true))).credited===0,"wrong-amount-credited");
  stage="synthetic-settlement";
  check((await processAgentConnections(core,rpc())).credited===1,"credit-not-committed");
  check((await processAgentConnections(core,rpc())).credited===0,"duplicate-credit");
  stage="live-public-hosted-scan";
  const outcome=await runHostedAgentCycle(core);
  check(outcome.completed===1,"hosted-scan-not-completed");
  stage="signed-artifact-retrieval";
  const response=await handleAgentConnectionRoutes(new Request("https://canary.invalid/api/agent-connections",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(await signed("status"))}),core,keys);
  check(response.status===200,"status-http");
  const status=await response.json(),run=status.hosted_runs[0];
  check(status.connection.connected&&run.status==="completed","not-connected-or-completed");
  const hash=hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(run.artifact))));
  check(hash===run.artifact_sha256,"artifact-hash");
  check(run.artifact.scan_complete&&run.artifact.listing_count>0,"incomplete-live-scan");
  stage="replay-and-isolation";
  check((await runHostedAgentCycle(core)).completed===0,"same-slot-duplicate");
  const forged=await signed("status");forged.signature=b64(new Uint8Array(64));
  const denied=await handleAgentConnectionRoutes(new Request("https://canary.invalid/api/agent-connections",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(forged)}),core,keys);
  check(denied.status===400,"forged-signature");
  const events=await db.prepare("SELECT kind,COUNT(*) n FROM notification_events WHERE dedupe_key IN (?,?) GROUP BY kind ORDER BY kind").bind("agent_connection_paid:"+id,"agent_connection_delivery:"+id).all();
  check(events.results.length===2&&events.results.every(x=>x.n===1),"notification-dedup");
  const result={passed:true,environment:"isolated-cloud-canary",worker_source:env.CANDIDATE_COMMIT,executed_at:new Date().toISOString(),database_id:env.CANARY_DATABASE_ID,real_payment:false,synthetic_payment_witnesses:true,synthetic_identity:true,production_records_written:0,public_posts:0,treasury_actions:0,hosted_execution:true,signed_status_retrieved:true,artifact_sha256:hash,listing_count:run.artifact.listing_count,source_count:run.artifact.sources.length,notification_events:events.results,notification_delivery_tested:false,artifact:run.artifact};
  result.production_enablement_ready=false;
  result.payment_readiness="blocked_public_rpc_limits";
  result.verification_scope="signed_synthetic_accounting_and_live_cloud_hosted_delivery";
  await db.prepare("UPDATE canary_receipts SET status='passed',result_json=? WHERE id='only-run-v4'").bind(JSON.stringify(result)).run();
 } catch(error) {
  await db.prepare("UPDATE canary_receipts SET status='failed',result_json=? WHERE id='only-run-v4'").bind(JSON.stringify({passed:false,stage,error:String(error.message).slice(0,300),real_payment:false,environment:"isolated-cloud-canary"})).run();
 }
}
export default {
 async fetch(request,env){
  if(request.method==="POST" && new URL(request.url).pathname==="/diagnose-rpc"){
   const trace=[];
   for(const url of ["https://public.1rpc.io/base","https://base-rpc.publicnode.com"]){
    const response=await fetch(url,{method:"POST",redirect:"manual",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"eth_chainId",params:[]}),signal:AbortSignal.timeout(15000)});
    const payload=response.ok?await response.json():{};
    trace.push({url,status:response.status,chain:payload.result??null,error:payload.error??null});
   }
   let scan;try{const report=await scanPublicWork();scan={complete:report.scan_complete,count:report.listing_count};}catch(error){scan={error:String(error.message).slice(0,200)};}
   return Response.json({trace,scan});
  }
  if(request.method==="POST" && new URL(request.url).pathname==="/diagnose"){
   const db=env.DB.withSession("first-primary");
   const lock=await db.prepare("INSERT OR IGNORE INTO canary_receipts(id,status,created_at) VALUES('source-diagnostic','running',?)").bind(Date.now()).run();
   if(lock.meta.changes===1){
    const trace=[];let diagnostic;
    try{const report=await scanPublicWork(async(url,init)=>{const response=await fetch(url,init);trace.push({url,status:response.status,type:response.headers.get("content-type")});return response;});diagnostic={passed:true,trace,listing_count:report.listing_count};}
    catch(error){diagnostic={passed:false,trace,error:String(error.message).slice(0,200)};}
    await db.prepare("UPDATE canary_receipts SET status='finished',result_json=? WHERE id='source-diagnostic'").bind(JSON.stringify(diagnostic)).run();
   }
   return Response.json(await db.prepare("SELECT status,result_json FROM canary_receipts WHERE id='source-diagnostic'").first());
  }
  // Explicit one-shot harness trigger; fixed synthetic data only, no caller inputs.
  if(request.method==="POST" && new URL(request.url).pathname==="/run")await execute(env);
  else if(request.method!=="GET")return new Response("unsupported canary method",{status:405});
  const row=await env.DB.withSession("first-primary").prepare("SELECT status,result_json FROM canary_receipts WHERE id='only-run-v4'").first();
  return Response.json({purpose:PURPOSE,harness_version:"v4",status:row?.status||"not-run",result:row?.result_json?JSON.parse(row.result_json):null},{headers:{"cache-control":"no-store"}});
 },
 scheduled(event,env,ctx){ctx.waitUntil(execute(env));}
};
