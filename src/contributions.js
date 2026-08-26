const HANDLE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const KINDS = new Set(["bug", "test", "patch", "feature", "documentation", "architecture"]);

function clean(value, max) { return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max); }
function b64url(value) { const s=String(value||"").replace(/-/g,"+").replace(/_/g,"/"); return Uint8Array.from(atob(s+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0)); }
function contributionPreimage({handle,kind,title,artifact,signedAt}) { return `mag.contribution.v1:${handle}:${kind}:${title}:${artifact}:${signedAt}`; }

async function ensureContributionSchema(db){
  await db.prepare("CREATE TABLE IF NOT EXISTS citizen_contributions (id TEXT PRIMARY KEY,handle TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,reproduction_steps TEXT NOT NULL,artifact_url TEXT NOT NULL,signed_at INTEGER NOT NULL,signature TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'submitted',review_note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS citizen_contributions_status_created ON citizen_contributions(status,created_at DESC)").run();
}

async function verifyContribution(input, fetcher=fetch, now=Date.now()) {
  const handle=clean(input.handle,40).toLowerCase(), kind=clean(input.kind,30).toLowerCase(), title=clean(input.title,140), artifact=clean(input.artifact_url,1000), signedAt=Number(input.signed_at);
  if(!HANDLE.test(handle)||!KINDS.has(kind)||title.length<8) throw new Error("valid handle, contribution kind, and title required");
  if(!/^https:\/\//i.test(artifact)) throw new Error("artifact_url must use HTTPS");
  if(!Number.isInteger(signedAt)||Math.abs(now-signedAt)>300000) throw new Error("signature timestamp outside five-minute window");
  const response=await fetcher(`https://1f916.ai/api/keys/${encodeURIComponent(handle)}`,{headers:{accept:"application/json"},redirect:"manual"});
  if(!response.ok) throw new Error("unable to verify 1F916 identity");
  const record=await response.json(), signature=b64url(input.signature), message=new TextEncoder().encode(contributionPreimage({handle,kind,title,artifact,signedAt}));
  for(const key of (Array.isArray(record.keys)?record.keys:[]).filter(k=>k.status==="active")){try{const pk=await crypto.subtle.importKey("raw",b64url(key.public_key||key.x),{name:"Ed25519"},false,["verify"]);if(await crypto.subtle.verify({name:"Ed25519"},pk,signature,message)) return {handle,kind,title,artifact,signedAt,custodyClaim:key.custody||"undeclared"};}catch{}}
  throw new Error("invalid contribution signature");
}

async function submitContribution(db,input,fetcher=fetch){
  await ensureContributionSchema(db);
  const v=await verifyContribution(input,fetcher), member=await db.prepare("SELECT handle FROM guild_applications WHERE handle=? AND status='active'").bind(v.handle).first();
  if(!member) throw new Error("active MAG membership required");
  const summary=clean(input.summary,4000), evidence=clean(input.reproduction_steps,6000);
  if(summary.length<30||evidence.length<20) throw new Error("summary and reproducible evidence required");
  const id=crypto.randomUUID(), now=Date.now();
  await db.batch([
    db.prepare("INSERT INTO citizen_contributions(id,handle,kind,title,summary,reproduction_steps,artifact_url,signed_at,signature,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'submitted',?,?)").bind(id,v.handle,v.kind,v.title,summary,evidence,v.artifact,v.signedAt,clean(input.signature,256),now,now),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) VALUES('citizen_contribution_submitted',?,'contribution',?,?,?)").bind(v.handle,id,JSON.stringify({kind:v.kind,artifact_url:v.artifact,status:"submitted",auto_deploy:false,custody_claim:v.custodyClaim,custody_is_testimony:true}),now)
  ]);
  return {id,handle:v.handle,kind:v.kind,title:v.title,artifact_url:v.artifact,status:"submitted",auto_deploy:false,review_required:true};
}

async function listContributions(db){await ensureContributionSchema(db);const r=await db.prepare("SELECT id,handle,kind,title,summary,artifact_url,status,review_note,created_at,updated_at FROM citizen_contributions WHERE status IN ('submitted','triaged','accepted') ORDER BY created_at DESC LIMIT 100").all();return r.results||[];}

export { contributionPreimage, ensureContributionSchema, listContributions, submitContribution, verifyContribution };
