import { authorizedTenant } from "./managed-ops.js";
import { tenantEntitled } from "./subscriptions.js";
const SERVICE=/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
const PROTECTED=/^(windefend|mpssvc|eventlog|securityhealthservice|rpcss|dcomlaunch|samss|lsass|bfe|wuauserv|winmgmt|sense|sshd)$/i;
async function sha(value){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,"0")).join("");}
function decode(value){return Uint8Array.from(atob(String(value).replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(String(value).length/4)*4,"=")),x=>x.charCodeAt(0));}
function validateRunbook(input) {
  const runbook=String(input.runbook||"");
  if(!["collect_inventory","service_health","restart_service"].includes(runbook))throw new Error("unsupported bounded runbook");
  const service=String(input.parameters?.service||"");
  if(runbook!=="collect_inventory"&&(!SERVICE.test(service)||PROTECTED.test(service)))throw new Error("service is invalid or protected");
  return {runbook,parameters:runbook==="collect_inventory"?{}:{service}};
}
async function tenant(db,id,token) {
  const t=await authorizedTenant(db,id,token);
  if(!t||t.status!=="active"||!await tenantEntitled(db,id))throw new Error("active tenant authorization required");
  return t;
}
async function createJob(db,tenantId,token,input,env={},now=Date.now()) {
  await tenant(db,tenantId,token);
  const spec=validateRunbook(input),asset=String(input.asset_id||"");
  if(spec.runbook==="restart_service"&&env.MAG_RMM_CONTROL_ENABLED!=="true")throw new Error("change runbooks require live acceptance certification before activation");
  if(!/^[0-9a-f-]{36}$/i.test(input.request_key||""))throw new Error("request_key required");
  if(!await db.prepare("SELECT asset_id FROM managed_devices WHERE tenant_id=? AND asset_id=? AND status='active'").bind(tenantId,asset).first())throw new Error("active enrolled target required");
  const id=crypto.randomUUID(),status=spec.runbook==="restart_service"?"pending_approval":"approved";
  await db.batch([
    db.prepare("INSERT INTO managed_jobs(id,tenant_id,asset_id,runbook,parameters_json,request_key,status,expires_at,approved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(id,tenantId,asset,spec.runbook,JSON.stringify(spec.parameters),input.request_key,status,now+900000,status==="approved"?now:null,now,now),
    db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'runbook_requested',?,?)").bind(tenantId,JSON.stringify({job_id:id,asset_id:asset,runbook:spec.runbook,status}),now)
  ]);
  return {id,status,expires_at:now+900000};
}
async function decideJob(db,tenantId,token,id,input,now=Date.now()) {
  await tenant(db,tenantId,token);
  if(!["approve","deny"].includes(input.decision)||input.scope_confirmed!==true)throw new Error("explicit decision and exact target scope confirmation required");
  const status=input.decision==="approve"?"approved":"denied";
  const rows=await db.batch([
    db.prepare("UPDATE managed_jobs SET status=?,approved_at=?,updated_at=? WHERE id=? AND tenant_id=? AND status='pending_approval' AND expires_at>?").bind(status,now,now,id,tenantId,now),
    db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,CASE WHEN changes()=1 THEN 'runbook_decided' ELSE NULL END,?,?)").bind(tenantId,JSON.stringify({job_id:id,status}),now)
  ]);
  return {id,status,changed:rows[0].meta.changes===1};
}
async function devicePreimage(action,input) {
  return `mag.rmm.${action}.v1:${input.tenant_id}:${input.asset_id}:${input.nonce}:${input.signed_at}:${await sha(JSON.stringify(input.payload||{}))}`;
}
async function authenticateDevice(db,action,input,now) {
  if(!/^[0-9a-f-]{36}$/i.test(input.nonce||"")||!Number.isSafeInteger(input.signed_at)||Math.abs(now-input.signed_at)>60000)throw new Error("fresh signed device request required");
  const d=await db.prepare("SELECT d.public_key FROM managed_devices d JOIN managed_tenants t ON t.id=d.tenant_id WHERE d.tenant_id=? AND d.asset_id=? AND d.status='active' AND t.status='active'").bind(input.tenant_id,input.asset_id).first();
  if(!d||!await tenantEntitled(db,input.tenant_id,now))throw new Error("active enrolled and entitled device required");
  const key=await crypto.subtle.importKey("raw",decode(d.public_key),{name:"Ed25519"},false,["verify"]);
  if(!await crypto.subtle.verify({name:"Ed25519"},key,decode(input.signature),new TextEncoder().encode(await devicePreimage(action,input))))throw new Error("invalid device signature");
  await db.prepare("INSERT INTO managed_device_requests(tenant_id,asset_id,nonce,created_at) VALUES(?,?,?,?)").bind(input.tenant_id,input.asset_id,input.nonce,now).run();
}
async function leaseJob(db,input,now=Date.now()) {
  await authenticateDevice(db,"poll",input,now);
  await db.prepare("DELETE FROM managed_device_requests WHERE created_at<?").bind(now-86400000).run();
  await db.prepare("UPDATE managed_jobs SET status='unknown',updated_at=? WHERE tenant_id=? AND asset_id=? AND status='leased' AND leased_at<=?").bind(now,input.tenant_id,input.asset_id,now-3600000).run();
  await db.prepare("UPDATE managed_jobs SET status='expired',updated_at=? WHERE tenant_id=? AND asset_id=? AND status IN ('approved','pending_approval') AND expires_at<=?").bind(now,input.tenant_id,input.asset_id,now).run();
  const next=await db.prepare("SELECT * FROM managed_jobs WHERE tenant_id=? AND asset_id=? AND status='approved' AND expires_at>? ORDER BY created_at LIMIT 1").bind(input.tenant_id,input.asset_id,now).first();
  if(!next)return {job:null};
  const lease=crypto.randomUUID()+crypto.randomUUID();
  const result=await db.prepare("UPDATE managed_jobs SET status='leased',lease_token_hash=?,leased_at=?,updated_at=? WHERE id=? AND status='approved' AND expires_at>?").bind(await sha(lease),now,now,next.id,now).run();
  if(result.meta.changes!==1)return {job:null};
  return {job:{id:next.id,runbook:next.runbook,parameters:JSON.parse(next.parameters_json),expires_at:next.expires_at,lease_token:lease,execution_policy:"at_most_once_no_automatic_retry"}};
}
async function recordJobResult(db,input,now=Date.now()) {
  await authenticateDevice(db,"result",input,now);
  const p=input.payload||{};
  if(!["succeeded","failed","unknown"].includes(p.status)||!/^[a-zA-Z0-9_.:-]{1,100}$/.test(p.result_code||""))throw new Error("bounded result status and code required");
  const data={status:p.status,result_code:p.result_code}; // No arbitrary command output or secrets.
  const leaseHash=await sha(String(p.lease_token||""));
  const prior=await db.prepare("SELECT status,result_json FROM managed_jobs WHERE id=? AND tenant_id=? AND asset_id=? AND lease_token_hash=?").bind(p.job_id,input.tenant_id,input.asset_id,leaseHash).first();
  if(prior?.status===p.status&&prior.result_json===JSON.stringify(data))return {recorded:true,duplicate:true};
  const results=await db.batch([
    db.prepare("UPDATE managed_jobs SET status=?,result_json=?,updated_at=? WHERE id=? AND tenant_id=? AND asset_id=? AND (status='leased' OR (status='unknown' AND result_json IS NULL)) AND lease_token_hash=? AND leased_at>?").bind(p.status,JSON.stringify(data),now,p.job_id,input.tenant_id,input.asset_id,leaseHash,now-86400000),
    db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,CASE WHEN changes()=1 THEN 'runbook_result' ELSE NULL END,?,?)").bind(input.tenant_id,JSON.stringify({job_id:p.job_id,...data}),now)
  ]);
  return {recorded:results[0].meta.changes===1};
}
async function listJobs(db,tenantId,token) {
  await tenant(db,tenantId,token);
  return (await db.prepare("SELECT id,asset_id,runbook,parameters_json,status,expires_at,approved_at,leased_at,result_json,created_at FROM managed_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100").bind(tenantId).all()).results;
}
export { validateRunbook, devicePreimage, createJob, decideJob, leaseJob, recordJobResult, listJobs };
