import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { arch, freemem, platform, release, totalmem, uptime } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute=promisify(execFile);
const ORIGIN="https://mavverick-scout.magai.workers.dev";
const VERSION="0.2.0";
const sha=s=>createHash("sha256").update(s).digest("hex");
function telemetryEvents(now=Date.now()) {
  return [
    {kind:"heartbeat",observed_at:now,data:{state:"online",agent_version:VERSION,uptime_seconds:uptime()}},
    {kind:"inventory",observed_at:now,data:{os_family:platform(),os_version:release(),cpu_arch:arch(),device_type:"endpoint",memory_mb:Math.round(totalmem()/1048576)}},
    {kind:"metric",observed_at:now,data:{name:"memory_free_mb",value:Math.round(freemem()/1048576),unit:"MiB"}},
  ];
}
function assertService(name,allowed=[]) {
  if(!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(name)||/^(windefend|mpssvc|eventlog|securityhealthservice|rpcss|dcomlaunch|samss|lsass|bfe|wuauserv|winmgmt|sense|sshd)$/i.test(name)||!allowed.includes(name))throw new Error("service_not_locally_authorized");
  return name;
}
async function executeRunbook(job,settings={},executor=execute) {
  if(Date.now()>=job.expires_at)throw new Error("job_expired");
  if(job.runbook==="collect_inventory")return {status:"succeeded",result_code:"inventory_collected"};
  if(!["service_health","restart_service"].includes(job.runbook))throw new Error("unsupported_runbook");
  if((settings.platform||platform())!=="win32")throw new Error("windows_service_runbook_only");
  const service=assertService(job.parameters?.service,settings.allowedServices||[]);
  if(job.runbook==="restart_service"&&settings.allowRestart!==true)throw new Error("local_restart_consent_required");
  // No supplied command string, executable, wildcard, credentials or shell input.
  const script=job.runbook==="restart_service"?
    "$ErrorActionPreference='Stop'; Restart-Service -Name $env:MAG_SERVICE_NAME -ErrorAction Stop; (Get-Service -Name $env:MAG_SERVICE_NAME).Status.ToString()":
    "$ErrorActionPreference='Stop'; (Get-Service -Name $env:MAG_SERVICE_NAME -ErrorAction Stop).Status.ToString()";
  const {stdout}=await executor("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,timeout:45000,maxBuffer:1024,env:{SystemRoot:process.env.SystemRoot||"C:\\Windows",MAG_SERVICE_NAME:service}});
  const running=String(stdout).trim()==="Running";
  return {status:running?"succeeded":"failed",result_code:running?"service_running":"service_not_running"};
}
async function flushJobResults(db,send) {
  for(const row of db.prepare("SELECT id,result_json FROM result_outbox WHERE acknowledged=0 ORDER BY created_at LIMIT 100").all()){
    const ack=await send(JSON.parse(row.result_json));
    if(ack?.recorded!==true)throw new Error("job_result_not_acknowledged");
    db.prepare("UPDATE result_outbox SET acknowledged=1 WHERE id=?").run(row.id);
  }
}
async function persistJobExecution(db,job,executeJob=executeRunbook) {
  // Persist an unknown outcome and the original lease BEFORE doing work. A crash
  // cannot cause a change action to be executed again.
  if(db.prepare("SELECT id FROM result_outbox WHERE id=?").get(job.id))return;
  const base={job_id:job.id,lease_token:job.lease_token}, unknown={...base,status:"unknown",result_code:"execution_outcome_unknown"};
  db.prepare("INSERT INTO result_outbox(id,result_json,created_at) VALUES(?,?,?)").run(job.id,JSON.stringify(unknown),Date.now());
  let result;
  try{result=await executeJob(job);}catch(error){result={status:"failed",result_code:/^[a-zA-Z0-9_.:-]{1,100}$/.test(error.message)?error.message:"runbook_failed"};}
  db.prepare("UPDATE result_outbox SET result_json=? WHERE id=?").run(JSON.stringify({...base,...result}),job.id);
}
async function main() {
  const config={tenant:process.env.MAG_TENANT_ID,asset:process.env.MAG_ASSET_ID,password:process.env.MAG_DEVICE_KEY_PASSWORD,state:process.env.MAG_DEVICE_STATE_PATH};
  if(!/^[0-9a-f-]{36}$/i.test(config.tenant||"")||!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/.test(config.asset||"")||String(config.password||"").length<24||!config.state)throw new Error("Set tenant ID, asset ID, a protected state path and a device-key passphrase of at least 24 characters. Do not pass credentials on the command line.");
  const file=resolve(config.state);mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const db=new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),tenant TEXT NOT NULL,asset TEXT NOT NULL,encrypted_key TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,result_json TEXT);");
  db.exec("CREATE TABLE IF NOT EXISTS result_outbox(id TEXT PRIMARY KEY,result_json TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);");
  let identity=db.prepare("SELECT * FROM identity WHERE id=1").get();
  if(!identity) {
    const pair=generateKeyPairSync("ed25519");
    const encrypted=pair.privateKey.export({format:"pem",type:"pkcs8",cipher:"aes-256-cbc",passphrase:config.password});
    db.prepare("INSERT INTO identity(id,tenant,asset,encrypted_key) VALUES(1,?,?,?)").run(config.tenant,config.asset,encrypted);
    identity=db.prepare("SELECT * FROM identity WHERE id=1").get();
  }
  if(identity.tenant!==config.tenant||identity.asset!==config.asset)throw new Error("State belongs to a different tenant or device");
  const key=createPrivateKey({key:identity.encrypted_key,format:"pem",passphrase:config.password});
  const publicKey=createPublicKey(key).export({format:"jwk"}).x;
  const signature=text=>sign(null,Buffer.from(text),key).toString("base64url");
  const post=async(path,body,token)=>{
    const response=await fetch(ORIGIN+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(20000),headers:{"content-type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
    if(!response.ok)throw new Error("control_plane_http_"+response.status);
    return response.json();
  };
  if(process.argv.includes("--enroll")) {
    if(!process.env.MAG_TENANT_ACCESS_TOKEN)throw new Error("Enrollment requires the tenant access token in the process environment");
    const signed_at=Date.now();
    await post("/api/managed-ops/tenants/"+config.tenant+"/devices",{asset_id:config.asset,public_key:publicKey,signed_at,signature:signature(`mag.device.enroll.v1:${config.tenant}:${config.asset}:${publicKey}:${signed_at}`)},process.env.MAG_TENANT_ACCESS_TOKEN);
    console.log("Device enrolled for signed monitoring. No persistence, remote shell or service restart consent was installed.");
  }
  const envelope=async(action,payload={})=>{
    const value={tenant_id:config.tenant,asset_id:config.asset,nonce:randomUUID(),signed_at:Date.now(),payload};
    value.signature=signature(`mag.rmm.${action}.v1:${value.tenant_id}:${value.asset_id}:${value.nonce}:${value.signed_at}:${sha(JSON.stringify(payload))}`);
    return value;
  };
  const cycle=async()=>{
    await flushJobResults(db,async payload=>post("/api/rmm/results",await envelope("result",payload)));
    const row=db.prepare("UPDATE identity SET sequence=sequence+1 WHERE id=1 RETURNING sequence").get();
    const observed_at=Date.now(),events=telemetryEvents(observed_at);
    await post("/api/managed-ops/telemetry",{tenant_id:config.tenant,asset_id:config.asset,sequence:row.sequence,observed_at,events,signature:signature(`mag.telemetry.v1:${config.tenant}:${config.asset}:${row.sequence}:${observed_at}:${sha(JSON.stringify(events))}`)});
    const {job}=await post("/api/rmm/poll",await envelope("poll"));
    if(!job)return;
    await persistJobExecution(db,job,j=>executeRunbook(j,{allowedServices:String(process.env.MAG_ALLOWED_SERVICES||"").split(",").filter(Boolean),allowRestart:process.env.MAG_ALLOW_SERVICE_RESTART==="yes"}));
    await flushJobResults(db,async payload=>post("/api/rmm/results",await envelope("result",payload)));
  };
  console.log("MAG endpoint is visible and running. Stop with Ctrl+C. Telemetry omits usernames, IP addresses, files, credentials and screen content.");
  do {
    try {await cycle();console.log("Signed monitoring cycle completed.");}catch(error){console.error("Cycle deferred:",String(error.message).replace(/[^a-zA-Z0-9_.:-]/g,"_").slice(0,100));}
    if(process.argv.includes("--once")||process.argv.includes("--enroll"))break;
    await new Promise(r=>setTimeout(r,60000));
  }while(true);
  db.close();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("Endpoint initialization failed; verify secure local configuration.");process.exitCode=1;});
export { telemetryEvents, assertService, executeRunbook, flushJobResults, persistJobExecution };
