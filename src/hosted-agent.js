// Deliberately fixed, read-only recipe. Never evaluate listing instructions,
// fetch caller-supplied URLs, post publicly, execute packages, or move funds.
const RECIPE = "mag-public-work-watch-v1";
const INTERVAL = 15 * 60 * 1000;
const ORIGIN = "https://1f916.ai";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const MAX_LISTINGS = 40;
function enabled(env) { return env.MAG_HOSTED_WORK_WATCH_ENABLED === "true" && env.MAG_AGENT_CONNECTIONS_ENABLED === "true" && Boolean(env.DB); }
function database(env) { return env.DB.withSession ? env.DB.withSession("first-primary") : env.DB; }
async function sha256(text) {
 return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function readSource(path, fetcher) {
 const url=ORIGIN+path;
 // Workers reject redirect:"error"; manual plus the ok check below still refuses all redirects.
 const response=await fetcher(url,{method:"GET",redirect:"manual",headers:{accept:"application/json"},signal:AbortSignal.timeout(10000)});
 if(!response.ok || !response.body) throw new Error("public_source_unavailable");
 const reader=response.body.getReader(), chunks=[]; let length=0;
 try { for(;;){ const {value,done}=await reader.read();if(done)break; length+=value.length;if(length>131072)throw new Error("public_source_too_large");chunks.push(value); } }
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const raw=new TextDecoder().decode(bytes);
 return {url,sha256:await sha256(raw),data:JSON.parse(raw)};
}
function atomic(value) { return typeof value==="string" && /^[0-9]{1,30}$/.test(value) ? value : null; }
function settlementLiability(record,version) {
 if(version!==2||record.economics==null)return null;
 const outstanding=atomic(record.economics.outstanding_awarded_atomic);
 const current=atomic(record.economics.currently_due_atomic);
 const overdue=atomic(record.economics.overdue_unpaid_atomic);
 const expired=atomic(record.economics.expired_unclaimed_atomic);
 if([outstanding,current,overdue,expired].some(value=>value===null))throw new Error("listing_economics_schema_changed");
 if(BigInt(outstanding)!==BigInt(current)+BigInt(overdue))throw new Error("listing_economics_inconsistent");
 return {
  outstanding_awarded_atomic:outstanding,currently_due_atomic:current,
  overdue_unpaid_atomic:overdue,expired_unclaimed_atomic:expired,
  overdue_unpaid_is_still_owed:true
 };
}
function score(row, detail, now) {
 const record=detail?.listing || detail;
 // Public detail documents use listing_id; id is an opaque record identifier.
 if(!record || (record.listing_id ?? record.id)!==row.id || typeof record.condition!=="string")throw new Error("listing_schema_changed");
 if(typeof row.payload_hash==="string"&&record.payload_hash!==row.payload_hash)throw new Error("listing_changed_during_scan");
 const condition=record.condition.slice(0,20000), text=String(row.title||"")+" "+condition;
 const hazards=/private key|seed phrase|install|download and run|credential|transfer funds|lottery|treasury|sign.*transaction/i.test(text);
 const reward=atomic(row.amount_atomic), snapshot=atomic(row.funds_seen_atomic);
 const fundingMode=typeof record.funding_mode==="string"?record.funding_mode:null;
 const explicitlyUncommitted=fundingMode==="promise";
 const settlementVersion=Number.isSafeInteger(record.settlement_version)&&record.settlement_version>=1?record.settlement_version:null;
 const settlementMode=["automatic","requester","verifier"].includes(record.settlement_mode)?record.settlement_mode:null;
 const maxAwards=Number.isSafeInteger(record.max_awards)&&record.max_awards>=1?record.max_awards:null;
 const liability=settlementLiability(record,settlementVersion);
 const asset=row.chain_id===8453 && String(row.token).toLowerCase()===USDC;
 const live=Number.isSafeInteger(row.expiry)&&row.expiry>Math.floor(now/1000)&&row.withdrawn_at===null;
 const clarity=condition.trim().length>=40;
 const funded=!explicitlyUncommitted && snapshot!==null && reward!==null && BigInt(snapshot)>=BigInt(reward);
 const submissions=Number.isSafeInteger(row.submissions)&&row.submissions>=0?row.submissions:null;
 return {
  id:row.id,title:String(row.title||"").slice(0,160),source:ORIGIN+"/api/listings/"+row.id,
  payout_atomic:reward,funding:{posting_snapshot_atomic:snapshot,declared_mode:fundingMode,current_available:explicitlyUncommitted?"not_committed":"unverified",reserved:false},
  settlement:{version:settlementVersion,mode:settlementMode,max_awards:maxAwards,...(liability?{liability}:{})},
  verification_clarity:clarity?"written_condition_present_not_independently_verified":"unclear",
  novelty:"unverified",safety:hazards?"manual_security_review":"not_independently_cleared",
  competition_submissions:submissions,estimated_time:"unknown",
  required_signatures:"Active self-custodied citizen Ed25519 plus EIP-191 signature from the receiving Base wallet; settlement decision and payer requirements remain listing-specific.",
  review_priority:(!hazards&&asset&&live&&clarity&&funded)?Math.max(0,50-Math.min(50,submissions||0)):0,
  disposition:hazards?"hold_security_review":!asset||!live?"exclude":"review_only",
  condition_sha256:null,condition // Untrusted source text; JSON data, never HTML or instructions.
 };
}
async function scanPublicWork(fetcher=fetch, now=Date.now()) {
 // Policy surfaces are read before the listing scan; a missing surface fails closed.
 const guide=await readSource("/api/listings/guide",fetcher);
 const security=await readSource("/api/listings/security",fetcher);
 if(typeof guide.data.rules_version!=="string"||typeof security.data.rules_version!=="string")throw new Error("rules_schema_changed");
 const index=await readSource("/api/listings",fetcher);
 if(!Array.isArray(index.data.listings)||typeof index.data.has_more!=="boolean")throw new Error("listing_index_schema_changed");
 const rows=index.data.listings;
 if(rows.length>MAX_LISTINGS||index.data.has_more)throw new Error("listing_scan_capacity_exceeded");
 if(new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!Number.isSafeInteger(r.id)||r.id<1))throw new Error("listing_index_schema_changed");
 const observations=[guide,security,index], listings=[];
 // At most four concurrent public reads and forty listings; no unbounded fan-out.
 for(let offset=0;offset<rows.length;offset+=4){
  const batch=rows.slice(offset,offset+4);
  const details=await Promise.all(batch.map(r=>readSource("/api/listings/"+r.id,fetcher)));
  for(let j=0;j<batch.length;j++){
   observations.push(details[j]);
   const item=score(batch[j],details[j].data,now);
   item.condition_sha256=await sha256(item.condition);
   delete item.condition;listings.push(item);
  }
 }
 listings.sort((a,b)=>b.review_priority-a.review_priority||a.id-b.id);
 return {
  recipe:RECIPE,observed_at:new Date(now).toISOString(),scope:"Read-only listing research; not a general-purpose AI agent or autonomous bounty completion.",
  listing_count:listings.length,scan_complete:true,
  guide_version:guide.data.rules_version,security_version:security.data.rules_version,
  sources:observations.map(({url,sha256})=>({url,sha256})),listings,
  semantic_sha256:await sha256(JSON.stringify({guide:guide.data.rules_version,security:security.data.rules_version,listings})),
  source_text_is_untrusted:true,accepted_work:false,payment_receipt:false,
  external_activation:false,public_posts:0,treasury_actions:0,
  operator:"MAG is an independent companion operated by MAVVERICK LLC."
 };
}
async function recentHostedRuns(db,handle) {
 const result=await db.prepare("SELECT id,invoice_id,status,started_at,finished_at,artifact_sha256,failure_code,artifact_json FROM agent_hosted_runs WHERE handle=? ORDER BY started_at DESC LIMIT 3").bind(handle).all();
 return (result.results||[]).map(({artifact_json,...row})=>({...row,artifact:artifact_json?JSON.parse(artifact_json):null}));
}
async function runHostedAgentCycle(env,fetcher=fetch,now=Date.now(),clock=Date.now) {
 if(!enabled(env))return {enabled:false,claimed:0,completed:0,failed:0};
 const db=database(env), slot=Math.floor(now/INTERVAL);
 await db.prepare("UPDATE agent_hosted_runs SET status='failed',finished_at=?,failure_code='worker_interrupted' WHERE status='running' AND started_at<? AND slot<?").bind(now,now-300000,slot).run();
 const eligible=await db.prepare("SELECT g.handle,(SELECT id FROM agent_connection_invoices WHERE handle=g.handle AND status='paid' AND period_start<=? AND period_end>? ORDER BY period_end DESC LIMIT 1) AS invoice_id,COALESCE((SELECT MAX(started_at) FROM agent_hosted_runs WHERE handle=g.handle),0) AS last_run FROM guild_applications g WHERE g.status='active' AND g.registry_verified_at IS NOT NULL AND EXISTS(SELECT 1 FROM agent_connection_invoices WHERE handle=g.handle AND status='paid' AND period_start<=? AND period_end>?) ORDER BY last_run,g.handle LIMIT 5").bind(now,now,now,now).all();
 const claimed=[];
 for(const row of eligible.results||[]){
  const id=crypto.randomUUID(), lease=crypto.randomUUID();
  const result=await db.prepare("INSERT INTO agent_hosted_runs(id,handle,invoice_id,slot,lease_token,status,started_at) VALUES(?,?,?,?,?,'running',?) ON CONFLICT(handle,slot) DO UPDATE SET lease_token=excluded.lease_token,started_at=excluded.started_at WHERE agent_hosted_runs.status='running' AND agent_hosted_runs.started_at<?")
   .bind(id,row.handle,row.invoice_id,slot,lease,now,now-300000).run();
  if(Number(result.meta?.changes)===1)claimed.push({...row,lease});
 }
 if(!claimed.length)return {enabled:true,claimed:0,completed:0,failed:0};
 let report, failure;
 try{report=await scanPublicWork(fetcher,now);}catch{failure="source_scan_unavailable_or_incomplete";}
 let completed=0,failed=0;
 for(const row of claimed){
  const finishedAt=clock();
  // Recheck approval and credit immediately before committing a deliverable.
  const live=await db.prepare("SELECT g.handle FROM guild_applications g JOIN agent_connection_invoices i ON i.handle=g.handle WHERE g.handle=? AND g.status='active' AND g.registry_verified_at IS NOT NULL AND i.status='paid' AND i.period_start<=? AND i.period_end>? LIMIT 1").bind(row.handle,finishedAt,finishedAt).first();
  if(!live){await db.prepare("UPDATE agent_hosted_runs SET status='cancelled',finished_at=?,failure_code='connection_no_longer_active' WHERE handle=? AND slot=? AND lease_token=? AND status='running'").bind(finishedAt,row.handle,slot,row.lease).run();continue;}
  if(failure){await db.prepare("UPDATE agent_hosted_runs SET status='failed',finished_at=?,failure_code=? WHERE handle=? AND slot=? AND lease_token=? AND status='running'").bind(finishedAt,failure,row.handle,slot,row.lease).run();failed++;continue;}
  const previous=await db.prepare("SELECT artifact_json FROM agent_hosted_runs WHERE handle=? AND status='completed' ORDER BY started_at DESC LIMIT 1").bind(row.handle).first();
  const previousArtifact=previous?JSON.parse(previous.artifact_json):null;
  const artifact={...report,handle:row.handle,invoice_id:row.invoice_id,observation:previousArtifact?.semantic_sha256===report.semantic_sha256?"no_new_signal":"new_or_changed_snapshot",capability_delta:"no_change"};
  const serialized=JSON.stringify(artifact),hash=await sha256(serialized);
  const results=await db.batch([
   db.prepare("UPDATE agent_hosted_runs SET status='completed',finished_at=?,artifact_json=?,artifact_sha256=? WHERE handle=? AND slot=? AND lease_token=? AND status='running' AND EXISTS(SELECT 1 FROM guild_applications g JOIN agent_connection_invoices i ON i.handle=g.handle WHERE g.handle=agent_hosted_runs.handle AND g.status='active' AND g.registry_verified_at IS NOT NULL AND i.status='paid' AND i.period_start<=? AND i.period_end>?)").bind(finishedAt,serialized,hash,row.handle,slot,row.lease,finishedAt,finishedAt),
   db.prepare("INSERT OR IGNORE INTO notification_events(id,dedupe_key,kind,subject,message,created_at) SELECT ?,?,'agent_connection_delivery','MAG hosted report available',?,? WHERE changes()=1")
    .bind(crypto.randomUUID(),"agent_connection_delivery:"+row.invoice_id,"A read-only work-watch report is available through your signed MAG connection status request. This is not accepted bounty work or citizen activation.",finishedAt)
  ]);
  if(Number(results[0]?.meta?.changes)===1)completed++;
 }
 return {enabled:true,claimed:claimed.length,completed,failed};
}
export {RECIPE,INTERVAL,scanPublicWork,runHostedAgentCycle,recentHostedRuns};
