const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLANS = Object.freeze([
  { id: "psa-workspace", name: "PSA Workspace", monthly_min_atomic: "79000000", endpoint_monthly_atomic: "0", includes: ["service requests", "ticket workflow", "SLA evidence", "asset links", "monthly metrics"] },
  { id: "managed-visibility", name: "Managed Visibility", monthly_min_atomic: "49000000", endpoint_monthly_atomic: "15000000", includes: ["signed heartbeat intake", "inventory snapshots", "patch and backup status", "security findings", "ticket creation"] },
  { id: "managed-security", name: "Managed Security Evidence", monthly_min_atomic: "199000000", endpoint_monthly_atomic: "35000000", includes: ["managed visibility", "finding triage", "evidence retention", "remediation proposals", "weekly security report"] },
]);
const EVENT_KINDS = new Set(["heartbeat", "inventory", "patch_status", "backup_status", "security_finding", "service_health", "metric"]);
const SENSITIVE_KEY = /(password|passwd|secret|token|credential|private.?key|seed|authorization|cookie|session)/i;
const DEVICE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,119}$/;
const SEVERITIES = new Set(["informational", "low", "medium", "high", "critical"]);

function clean(value, maximum) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function planById(id) {
  return PLANS.find((plan) => plan.id === clean(id, 40));
}

function scrubTelemetry(value, depth = 0) {
  if (depth > 5) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrubTelemetry(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" ? clean(value, 1000) : value;
  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    const safeKey = clean(key, 80);
    output[safeKey] = SENSITIVE_KEY.test(safeKey) ? "[redacted]" : scrubTelemetry(child, depth + 1);
  }
  return output;
}

function validateTenant(input) {
  const name = clean(input.name, 120);
  const contactEmail = clean(input.contact_email, 254).toLowerCase();
  const plan = planById(input.plan_id);
  const maxAssets = Number(input.max_assets);
  const domains = [...new Set((Array.isArray(input.authorized_domains) ? input.authorized_domains : [])
    .map((value) => clean(value, 253).toLowerCase())
    .filter((value) => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value)))].slice(0, 50);
  if (name.length < 2 || !EMAIL.test(contactEmail) || !plan) throw new Error("valid tenant, contact email, and plan are required");
  if (!Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > 10000) throw new Error("max_assets must be between 1 and 10000");
  if (!domains.length) throw new Error("at least one authorized domain is required");
  if (input.authorization_attested !== true || input.data_processing_consent !== true) throw new Error("scope authorization and data-processing consent are required");
  return { name, contactEmail, plan, maxAssets, domains };
}

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createManagedTenant(db, input) {
  const tenant = validateTenant(input);
  const id = crypto.randomUUID();
  const accessToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = Date.now();
  await db.prepare("INSERT INTO managed_tenants(id,name,contact_email,plan_id,max_assets,authorized_domains_json,authorization_attested,data_processing_consent,access_token_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1,?,'pending_review',?,?)")
    .bind(id, tenant.name, tenant.contactEmail, tenant.plan.id, tenant.maxAssets, JSON.stringify(tenant.domains), await sha256(accessToken), now, now).run();
  await db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'tenant_requested',?,?)")
    .bind(id, JSON.stringify({ plan_id: tenant.plan.id, max_assets: tenant.maxAssets, domains: tenant.domains, remote_execution: false }), now).run();
  return { id, status: "pending_review", plan: tenant.plan, access_token: accessToken, warning: "Save the access token now. MAG cannot retrieve it. Each device must enroll its own Ed25519 key before it can submit strictly shaped telemetry. Enrollment grants no remote execution authority." };
}

async function authorizedTenant(db, id, token) {
  if (!token) return null;
  const tenant = await db.prepare("SELECT id,name,contact_email,plan_id,max_assets,authorized_domains_json,status,access_token_hash,created_at,updated_at FROM managed_tenants WHERE id=?").bind(id).first();
  if (!tenant || await sha256(token) !== tenant.access_token_hash) return null;
  delete tenant.access_token_hash;
  tenant.authorized_domains = JSON.parse(tenant.authorized_domains_json || "[]");
  delete tenant.authorized_domains_json;
  return tenant;
}

function normalizeEventData(kind, data) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const number = (key, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : null;
  };
  if (kind === "heartbeat") return { state: clean(source.state, 24), agent_version: clean(source.agent_version, 40), uptime_seconds: number("uptime_seconds") };
  if (kind === "inventory") return { os_family: clean(source.os_family, 40), os_version: clean(source.os_version, 80), device_type: clean(source.device_type, 40), cpu_arch: clean(source.cpu_arch, 24), memory_mb: number("memory_mb", 0, 10_000_000), disk_total_gb: number("disk_total_gb", 0, 10_000_000) };
  if (kind === "patch_status") return { missing_critical: number("missing_critical", 0, 100000), missing_other: number("missing_other", 0, 100000), last_scan_at: number("last_scan_at") };
  if (kind === "backup_status") return { state: clean(source.state, 24), last_success_at: number("last_success_at"), protected_bytes: number("protected_bytes") };
  if (kind === "security_finding") return { finding_id: clean(source.finding_id, 120), severity: SEVERITIES.has(clean(source.severity, 20).toLowerCase()) ? clean(source.severity, 20).toLowerCase() : "informational", title: clean(source.title, 200), cwe: clean(source.cwe, 24), evidence_digest: /^sha256:[a-f0-9]{64}$/.test(clean(source.evidence_digest, 71).toLowerCase()) ? clean(source.evidence_digest, 71).toLowerCase() : "" };
  if (kind === "service_health") return { service: clean(source.service, 100), state: clean(source.state, 24), message: clean(source.message, 500) };
  return { name: clean(source.name, 100), value: number("value", -1e15, 1e15), unit: clean(source.unit, 30) };
}

function validateTelemetryBatch(input, now = Date.now()) {
  const events = Array.isArray(input.events) ? input.events : [];
  if (!events.length || events.length > 50) throw new Error("events must contain 1-50 telemetry records");
  return events.map((event) => {
    const kind = clean(event.kind, 40).toLowerCase();
    const observedAt = Number(event.observed_at);
    if (!EVENT_KINDS.has(kind)) throw new Error("each event requires an allowed kind");
    if (!Number.isInteger(observedAt) || observedAt > now + 300000 || observedAt < now - 7 * 86400000) throw new Error("observed_at is outside the accepted window");
    const payload = normalizeEventData(kind, scrubTelemetry(event.data || {}));
    const serialized = JSON.stringify(payload);
    if (serialized.length > 8192) throw new Error("telemetry record exceeds 8192 bytes after redaction");
    return { kind, observedAt, payload, serialized };
  });
}

function b64url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), (character) => character.charCodeAt(0));
}

function deviceEnrollmentPreimage({ tenantId, assetId, publicKey, signedAt }) {
  return `mag.device.enroll.v1:${tenantId}:${assetId}:${publicKey}:${signedAt}`;
}

async function registerDevice(db, tenantId, accessToken, input, now = Date.now()) {
  const tenant = await authorizedTenant(db, tenantId, accessToken);
  if (!tenant || tenant.status !== "active") throw new Error("active tenant authorization required");
  const assetId = clean(input.asset_id, 120);
  const publicKey = clean(input.public_key, 100);
  const signedAt = Number(input.signed_at);
  if (!DEVICE_ID.test(assetId) || !Number.isInteger(signedAt) || Math.abs(now - signedAt) > 300000) throw new Error("valid asset_id and fresh signed_at are required");
  const count = Number((await db.prepare("SELECT COUNT(*) n FROM managed_devices WHERE tenant_id=? AND status='active'").bind(tenantId).first())?.n || 0);
  if (count >= Number(tenant.max_assets)) throw new Error("tenant asset limit exceeded");
  try {
    const key = await crypto.subtle.importKey("raw", b64url(publicKey), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(deviceEnrollmentPreimage({ tenantId, assetId, publicKey, signedAt }));
    if (!await crypto.subtle.verify({ name: "Ed25519" }, key, b64url(input.signature), message)) throw new Error("invalid device enrollment signature");
  } catch (error) { if (error.message === "invalid device enrollment signature") throw error; throw new Error("invalid device public key or signature"); }
  await db.prepare("INSERT INTO managed_devices(tenant_id,asset_id,public_key,status,last_sequence,created_at,updated_at) VALUES(?,?,?,'active',0,?,?) ON CONFLICT(tenant_id,asset_id) DO UPDATE SET public_key=excluded.public_key,status='active',last_sequence=0,updated_at=excluded.updated_at")
    .bind(tenantId, assetId, publicKey, now, now).run();
  await db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'device_enrolled',?,?)").bind(tenantId, JSON.stringify({ asset_id: assetId, remote_execution: false }), now).run();
  return { tenant_id: tenantId, asset_id: assetId, status: "active", remote_execution: false };
}

async function telemetryPreimage(input) {
  const digest = await sha256(JSON.stringify(input.events));
  return `mag.telemetry.v1:${input.tenant_id}:${input.asset_id}:${input.sequence}:${input.observed_at}:${digest}`;
}

async function ingestTelemetry(db, input, now = Date.now()) {
  const tenantId = clean(input.tenant_id, 80);
  const assetId = clean(input.asset_id, 120);
  const sequence = Number(input.sequence);
  const observedAt = Number(input.observed_at);
  if (!DEVICE_ID.test(assetId) || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isInteger(observedAt) || Math.abs(now - observedAt) > 300000) throw new Error("valid device envelope is required");
  const device = await db.prepare("SELECT d.public_key,d.status,d.last_sequence,t.status tenant_status FROM managed_devices d JOIN managed_tenants t ON t.id=d.tenant_id WHERE d.tenant_id=? AND d.asset_id=?").bind(tenantId, assetId).first();
  if (!device || device.status !== "active" || device.tenant_status !== "active") throw new Error("active enrolled device required");
  const events = validateTelemetryBatch({ events: input.events }, now);
  try {
    const key = await crypto.subtle.importKey("raw", b64url(device.public_key), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(await telemetryPreimage({ tenant_id: tenantId, asset_id: assetId, sequence, observed_at: observedAt, events: input.events }));
    if (!await crypto.subtle.verify({ name: "Ed25519" }, key, b64url(input.signature), message)) throw new Error("invalid telemetry signature");
  } catch (error) { if (error.message === "invalid telemetry signature") throw error; throw new Error("invalid telemetry signature encoding"); }
  const advanced = await db.prepare("UPDATE managed_devices SET last_sequence=?,last_seen_at=?,updated_at=? WHERE tenant_id=? AND asset_id=? AND last_sequence<? RETURNING asset_id").bind(sequence, observedAt, now, tenantId, assetId, sequence).first();
  if (!advanced) throw new Error("replayed or out-of-order telemetry sequence");
  const statements = [];
  for (const event of events) {
    statements.push(db.prepare("INSERT INTO managed_assets(tenant_id,asset_id,last_seen_at,status,updated_at) VALUES(?,?,?,'observed',?) ON CONFLICT(tenant_id,asset_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at").bind(tenantId, assetId, event.observedAt, now));
    statements.push(db.prepare("INSERT INTO managed_telemetry(id,tenant_id,asset_id,sequence,kind,observed_at,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), tenantId, assetId, sequence, event.kind, event.observedAt, event.serialized, now));
  }
  await db.batch(statements);
  return { accepted: events.length, tenant_id: tenantId, asset_id: assetId, sequence, remote_action: false };
}

function managedOpsManifest() {
  return {
    product: "MAG Managed Operations",
    maturity: "phase_0_evidence_plane",
    positioning: "Vendor-neutral RMM/PSA and observability foundation for authorized customer assets.",
    plans: PLANS,
    capabilities: ["tenant-scoped intake", "per-device signed telemetry", "inventory and heartbeat evidence", "patch and backup status", "security finding normalization", "ticket workflow", "customer white-label profile", "approval-ready remediation proposals"],
    deliberately_absent: ["remote shell", "arbitrary command execution", "credential collection", "silent software installation", "automatic remediation", "autonomous purchasing"],
    authority: "Enrollment covers telemetry only. Every future change action requires a separately recorded customer approval and a bounded runbook.",
    privacy: "Telemetry fields whose names imply passwords, secrets, tokens, credentials, keys, cookies, or sessions are redacted before storage.",
    device_trust: "Each endpoint has an Ed25519 key, signs a canonical batch digest, and advances a monotonic replay-protection sequence.",
    api: { create_tenant: "POST /api/managed-ops/tenants", enroll_device: "POST /api/managed-ops/tenants/:id/devices", ingest: "POST /api/managed-ops/telemetry", tenant: "GET /api/managed-ops/tenants/:id" },
  };
}

function managedOpsPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG Managed Operations</title><style>:root{--navy:#061a33;--panel:#0a2744;--line:#1e5774;--cyan:#11d8ed;--gold:#f6c653;--ink:#eaf7ff;--muted:#9eb6c9}*{box-sizing:border-box}body{margin:0;background:var(--navy);color:var(--ink);font:15px/1.45 system-ui}.shell{display:grid;grid-template-columns:230px 1fr;min-height:100vh}.side{padding:24px 18px;background:#041326;border-right:1px solid var(--line)}.brand{display:flex;align-items:center;gap:10px;font-weight:900}.brand img{width:46px;height:46px;object-fit:contain}.tenant{color:var(--muted);font-size:.85rem;margin:7px 0 28px}.nav{display:grid;gap:7px}.nav a{padding:10px 12px;border-radius:9px;color:var(--muted);text-decoration:none}.nav a.active,.nav a:hover{background:#0c3454;color:var(--ink)}main{padding:28px}.top{display:flex;justify-content:space-between;gap:18px;align-items:center}.badge{border:1px solid #31715f;color:#7ce9ba;border-radius:999px;padding:6px 10px}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:22px 0}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px}.metric{font-size:2rem;font-weight:900}.good{color:#7ce9ba}.warn{color:var(--gold)}.grid{display:grid;grid-template-columns:1.5fr 1fr;gap:14px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #19405d}th{color:var(--muted);font-size:.78rem;text-transform:uppercase}.sev{color:var(--gold)}.demo{color:var(--muted);font-size:.82rem}.powered{margin-top:30px;color:#65859c}@media(max-width:900px){.shell{grid-template-columns:1fr}.side{display:none}.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}@media(max-width:520px){.cards{grid-template-columns:1fr}}</style></head><body><div class="shell"><aside class="side"><div class="brand"><img src="/mag-logo.png" alt=""><span>Northstar IT</span></div><div class="tenant">White-label preview</div><nav class="nav"><a class="active" href="#">Overview</a><a href="#">Assets</a><a href="#">Tickets</a><a href="#">Security</a><a href="#">Backups</a><a href="#">Patches</a><a href="/migrations">Migrations</a><a href="#">Reports</a></nav><p class="powered">Powered by MAG Managed Operations</p></aside><main><div class="top"><div><p class="demo">INTERFACE PREVIEW · SAMPLE DATA</p><h1>Good evening, operations team.</h1></div><span class="badge">● Evidence intake healthy</span></div><section class="cards"><article class="card"><span>Managed assets</span><div class="metric">148</div><small class="good">146 reporting</small></article><article class="card"><span>Open tickets</span><div class="metric">12</div><small>3 awaiting approval</small></article><article class="card"><span>Patch posture</span><div class="metric">94%</div><small class="warn">8 need review</small></article><article class="card"><span>Backups</span><div class="metric">98%</div><small class="good">145 protected</small></article></section><section class="grid"><article class="panel"><h2>Asset evidence</h2><table><thead><tr><th>Asset</th><th>Platform</th><th>Last seen</th><th>State</th></tr></thead><tbody><tr><td>NS-DEN-LT-014</td><td>Windows 11</td><td>42 sec</td><td class="good">Healthy</td></tr><tr><td>NS-NYC-SRV-02</td><td>Windows Server</td><td>2 min</td><td class="warn">Patch review</td></tr><tr><td>NS-REMOTE-31</td><td>macOS</td><td>4 min</td><td class="good">Healthy</td></tr></tbody></table></article><article class="panel"><h2>Approval queue</h2><p><b class="sev">High ·</b> Review critical patch evidence</p><p><b>Medium ·</b> Approve backup policy proposal</p><p><b>Low ·</b> Resolve stale inventory record</p><p class="demo">No command can run from this preview. Change actions require a separate bounded approval and runbook.</p></article></section></main></div></body></html>`;
}

export { PLANS, authorizedTenant, createManagedTenant, deviceEnrollmentPreimage, ingestTelemetry, managedOpsManifest, managedOpsPage, normalizeEventData, planById, registerDevice, scrubTelemetry, telemetryPreimage, validateTelemetryBatch, validateTenant };
