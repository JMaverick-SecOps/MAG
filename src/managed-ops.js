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
const CLOSED_TICKET_STATES = new Set(["cancelled", "closed", "complete", "completed", "resolved"]);
const HEALTHY_BACKUP_STATES = new Set(["healthy", "ok", "protected", "success", "successful"]);
const HEX_COLOR = /^#[a-f0-9]{6}$/i;
const BRANDING_DEFAULTS = Object.freeze({ primary_color: "#061a33", accent_color: "#11d8ed" });

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
  const subscription = await db.prepare("SELECT status,paid_through FROM managed_subscriptions WHERE tenant_id=?").bind(id).first();
  if (subscription && !(subscription.status === "active" && Number(subscription.paid_through) > Date.now())) tenant.status = subscription.status === "pending_payment" ? "pending_review" : "suspended";
  tenant.authorized_domains = JSON.parse(tenant.authorized_domains_json || "[]");
  delete tenant.authorized_domains_json;
  return tenant;
}

function hostnameWithinDomains(hostname, authorizedDomains) {
  const candidate = clean(hostname, 253).toLowerCase().replace(/\.$/, "");
  return authorizedDomains.some((domain) => candidate === domain || candidate.endsWith(`.${domain}`));
}

function validateTenantBranding(input, authorizedDomains = []) {
  const domains = [...new Set(authorizedDomains.map((value) => clean(value, 253).toLowerCase().replace(/\.$/, "")).filter(Boolean))];
  const displayName = clean(input?.display_name, 100);
  const primaryColor = clean(input?.primary_color || BRANDING_DEFAULTS.primary_color, 7).toLowerCase();
  const accentColor = clean(input?.accent_color || BRANDING_DEFAULTS.accent_color, 7).toLowerCase();
  const supportEmail = clean(input?.support_email, 254).toLowerCase();
  const customDomain = clean(input?.custom_domain, 253).toLowerCase().replace(/\.$/, "");
  const rawLogoUrl = clean(input?.logo_url, 500);
  if (displayName.length < 2) throw new Error("display_name must contain 2-100 characters");
  if (!HEX_COLOR.test(primaryColor) || !HEX_COLOR.test(accentColor) || primaryColor === accentColor) throw new Error("distinct six-digit primary_color and accent_color values are required");
  if (supportEmail && !EMAIL.test(supportEmail)) throw new Error("support_email must be a valid email address");
  if (customDomain && !hostnameWithinDomains(customDomain, domains)) throw new Error("custom_domain must equal or be a subdomain of an authorized tenant domain");
  let logoUrl = "";
  if (rawLogoUrl) {
    let parsed;
    try { parsed = new URL(rawLogoUrl); } catch { throw new Error("logo_url must be an HTTPS URL on an authorized tenant domain"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port && parsed.port !== "443" || parsed.search || parsed.hash || !hostnameWithinDomains(parsed.hostname, domains)) {
      throw new Error("logo_url must be an HTTPS URL on an authorized tenant domain without credentials, query, or fragment");
    }
    logoUrl = parsed.toString();
  }
  return { displayName, logoUrl, primaryColor, accentColor, supportEmail, customDomain };
}

function brandingFromRow(tenant, row) {
  return {
    tenant_id: tenant.id,
    display_name: row?.display_name || tenant.name,
    logo_url: row?.logo_url || "",
    primary_color: row?.primary_color || BRANDING_DEFAULTS.primary_color,
    accent_color: row?.accent_color || BRANDING_DEFAULTS.accent_color,
    support_email: row?.support_email || tenant.contact_email,
    custom_domain: row?.custom_domain || "",
    domain_status: row?.domain_status || "unconfigured",
    updated_at: row?.updated_at || null,
  };
}

async function brandingTenant(db, tenantId, accessToken, writable = false) {
  const tenant = await authorizedTenant(db, clean(tenantId, 80), accessToken);
  if (!tenant) throw new Error("tenant authorization required");
  if (writable && !new Set(["pending_review", "active"]).has(tenant.status)) throw new Error("tenant branding cannot be changed in the current tenant state");
  return tenant;
}

async function loadBranding(db, tenant) {
  const row = await db.prepare("SELECT tenant_id,display_name,logo_url,primary_color,accent_color,support_email,custom_domain,domain_status,updated_at FROM managed_branding WHERE tenant_id=?").bind(tenant.id).first();
  return brandingFromRow(tenant, row);
}

async function createTenantBranding(db, tenantId, accessToken, input, now = Date.now()) {
  const tenant = await brandingTenant(db, tenantId, accessToken, true);
  const branding = validateTenantBranding(input, tenant.authorized_domains);
  const domainStatus = branding.customDomain ? "pending_verification" : "unconfigured";
  const inserted = await db.prepare("INSERT INTO managed_branding(tenant_id,display_name,logo_url,primary_color,accent_color,support_email,custom_domain,domain_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO NOTHING RETURNING tenant_id")
    .bind(tenant.id, branding.displayName, branding.logoUrl || null, branding.primaryColor, branding.accentColor, branding.supportEmail || null, branding.customDomain || null, domainStatus, now).first();
  if (!inserted) throw new Error("tenant branding already exists");
  await db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'branding_created',?,?)")
    .bind(tenant.id, JSON.stringify({ custom_domain: branding.customDomain || null, domain_status: domainStatus }), now).run();
  return brandingFromRow(tenant, { display_name: branding.displayName, logo_url: branding.logoUrl, primary_color: branding.primaryColor, accent_color: branding.accentColor, support_email: branding.supportEmail, custom_domain: branding.customDomain, domain_status: domainStatus, updated_at: now });
}

async function updateTenantBranding(db, tenantId, accessToken, input, now = Date.now()) {
  const tenant = await brandingTenant(db, tenantId, accessToken, true);
  const current = await db.prepare("SELECT tenant_id,display_name,logo_url,primary_color,accent_color,support_email,custom_domain,domain_status,updated_at FROM managed_branding WHERE tenant_id=?").bind(tenant.id).first();
  if (!current) throw new Error("tenant branding has not been created");
  const merged = {
    display_name: Object.hasOwn(input || {}, "display_name") ? input.display_name : current.display_name,
    logo_url: Object.hasOwn(input || {}, "logo_url") ? input.logo_url : current.logo_url,
    primary_color: Object.hasOwn(input || {}, "primary_color") ? input.primary_color : current.primary_color,
    accent_color: Object.hasOwn(input || {}, "accent_color") ? input.accent_color : current.accent_color,
    support_email: Object.hasOwn(input || {}, "support_email") ? input.support_email : current.support_email,
    custom_domain: Object.hasOwn(input || {}, "custom_domain") ? input.custom_domain : current.custom_domain,
  };
  const branding = validateTenantBranding(merged, tenant.authorized_domains);
  const domainChanged = branding.customDomain !== (current.custom_domain || "");
  const domainStatus = domainChanged ? (branding.customDomain ? "pending_verification" : "unconfigured") : current.domain_status;
  await db.prepare("UPDATE managed_branding SET display_name=?,logo_url=?,primary_color=?,accent_color=?,support_email=?,custom_domain=?,domain_status=?,updated_at=? WHERE tenant_id=?")
    .bind(branding.displayName, branding.logoUrl || null, branding.primaryColor, branding.accentColor, branding.supportEmail || null, branding.customDomain || null, domainStatus, now, tenant.id).run();
  await db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'branding_updated',?,?)")
    .bind(tenant.id, JSON.stringify({ custom_domain_changed: domainChanged, domain_status: domainStatus }), now).run();
  return brandingFromRow(tenant, { display_name: branding.displayName, logo_url: branding.logoUrl, primary_color: branding.primaryColor, accent_color: branding.accentColor, support_email: branding.supportEmail, custom_domain: branding.customDomain, domain_status: domainStatus, updated_at: now });
}

async function readTenantBranding(db, tenantId, accessToken) {
  const tenant = await brandingTenant(db, tenantId, accessToken);
  return loadBranding(db, tenant);
}

function jsonObject(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function percentage(numerator, denominator) {
  return denominator ? Math.round(numerator * 1000 / denominator) / 10 : null;
}

function aggregateTenantDashboard({ tenant, branding, assets = [], tickets = [], posture = [], security = [], pendingApprovals = 0 }, now = Date.now()) {
  const reportingCutoffAt = now - 15 * 60 * 1000;
  const postureCutoffAt = now - 24 * 60 * 60 * 1000;
  const securitySinceAt = now - 30 * 86400000;
  const reportingAssets = assets.filter((row) => Number(row.last_seen_at) >= reportingCutoffAt).length;
  const openTickets = tickets.filter((row) => !CLOSED_TICKET_STATES.has(clean(row.status, 30).toLowerCase()));
  const ticketSeverities = Object.fromEntries([...SEVERITIES].map((severity) => [severity, 0]));
  for (const row of openTickets) {
    const severity = SEVERITIES.has(clean(row.severity, 20).toLowerCase()) ? clean(row.severity, 20).toLowerCase() : "informational";
    ticketSeverities[severity] += 1;
  }
  const patchRows = posture.filter((row) => row.kind === "patch_status" && Number(row.observed_at) >= postureCutoffAt);
  const patch = { assets_reporting: patchRows.length, stale_observations: posture.filter((row) => row.kind === "patch_status" && Number(row.observed_at) < postureCutoffAt).length, compliant_assets: 0, needs_review_assets: 0, missing_critical: 0, missing_other: 0 };
  for (const row of patchRows) {
    const data = jsonObject(row.data_json);
    const critical = Math.max(0, Number(data.missing_critical) || 0);
    const other = Math.max(0, Number(data.missing_other) || 0);
    patch.missing_critical += critical;
    patch.missing_other += other;
    if (critical === 0 && other === 0) patch.compliant_assets += 1;
    else patch.needs_review_assets += 1;
  }
  const backupRows = posture.filter((row) => row.kind === "backup_status" && Number(row.observed_at) >= postureCutoffAt);
  const backup = { assets_reporting: backupRows.length, stale_observations: posture.filter((row) => row.kind === "backup_status" && Number(row.observed_at) < postureCutoffAt).length, healthy_assets: 0, needs_review_assets: 0, protected_bytes: 0 };
  for (const row of backupRows) {
    const data = jsonObject(row.data_json);
    backup.protected_bytes += Math.max(0, Number(data.protected_bytes) || 0);
    if (HEALTHY_BACKUP_STATES.has(clean(data.state, 24).toLowerCase())) backup.healthy_assets += 1;
    else backup.needs_review_assets += 1;
  }
  const securitySeverities = Object.fromEntries([...SEVERITIES].map((severity) => [severity, 0]));
  const affectedAssets = new Set();
  const recentSecurity = security.filter((row) => Number(row.observed_at) >= securitySinceAt);
  for (const row of recentSecurity) {
    const data = jsonObject(row.data_json);
    const severity = SEVERITIES.has(clean(data.severity, 20).toLowerCase()) ? clean(data.severity, 20).toLowerCase() : "informational";
    securitySeverities[severity] += 1;
    if (row.asset_id) affectedAssets.add(row.asset_id);
  }
  return {
    generated_at: now,
    tenant: { id: tenant.id, name: tenant.name, plan_id: tenant.plan_id, status: tenant.status, max_assets: Number(tenant.max_assets) },
    branding,
    assets: { total: assets.length, reporting: reportingAssets, stale: assets.length - reportingAssets, capacity_remaining: Math.max(0, Number(tenant.max_assets) - assets.length), reporting_percent: percentage(reportingAssets, assets.length) },
    tickets: { open: openTickets.length, by_severity: ticketSeverities, pending_approvals: Math.max(0, Number(pendingApprovals) || 0) },
    patch: { ...patch, compliance_percent: percentage(patch.compliant_assets, patch.assets_reporting), coverage_percent: percentage(patch.assets_reporting, assets.length) },
    backup: { ...backup, healthy_percent: percentage(backup.healthy_assets, backup.assets_reporting), coverage_percent: percentage(backup.assets_reporting, assets.length) },
    security: { recent_findings_30d: recentSecurity.length, affected_assets: affectedAssets.size, by_severity: securitySeverities, result_limit: 2000, possibly_truncated: recentSecurity.length >= 2000 },
    freshness: { asset_reporting_cutoff_at: reportingCutoffAt, posture_cutoff_at: postureCutoffAt, security_since_at: securitySinceAt },
    authority: { remote_execution: false, arbitrary_commands: false, automatic_remediation: false, autonomous_spending: false },
  };
}

async function readTenantDashboard(db, tenantId, accessToken, now = Date.now()) {
  const tenant = await brandingTenant(db, tenantId, accessToken);
  const branding = await loadBranding(db, tenant);
  const securitySince = now - 30 * 86400000;
  const results = await db.batch([
    db.prepare("SELECT asset_id,last_seen_at,status,updated_at FROM managed_assets WHERE tenant_id=? ORDER BY asset_id").bind(tenant.id),
    db.prepare("SELECT id,asset_id,severity,title,status,created_at,updated_at FROM managed_tickets WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1000").bind(tenant.id),
    db.prepare("WITH ranked AS (SELECT asset_id,kind,observed_at,data_json,ROW_NUMBER() OVER (PARTITION BY asset_id,kind ORDER BY observed_at DESC,created_at DESC) position FROM managed_telemetry WHERE tenant_id=? AND kind IN ('patch_status','backup_status')) SELECT asset_id,kind,observed_at,data_json FROM ranked WHERE position=1").bind(tenant.id),
    db.prepare("WITH ranked AS (SELECT asset_id,observed_at,data_json,ROW_NUMBER() OVER (PARTITION BY asset_id,COALESCE(json_extract(data_json,'$.finding_id'),'') ORDER BY observed_at DESC,created_at DESC) position FROM managed_telemetry WHERE tenant_id=? AND kind='security_finding' AND observed_at>=?) SELECT asset_id,'security_finding' kind,observed_at,data_json FROM ranked WHERE position=1 ORDER BY observed_at DESC LIMIT 2000").bind(tenant.id, securitySince),
    db.prepare("SELECT COUNT(*) pending FROM managed_remediation_proposals WHERE tenant_id=? AND approval_status='pending'").bind(tenant.id),
  ]);
  return aggregateTenantDashboard({
    tenant,
    branding,
    assets: results[0]?.results || [],
    tickets: results[1]?.results || [],
    posture: results[2]?.results || [],
    security: results[3]?.results || [],
    pendingApprovals: results[4]?.results?.[0]?.pending || 0,
  }, now);
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
  const normalized = events.map((event) => {
    const kind = clean(event.kind, 40).toLowerCase();
    const observedAt = Number(event.observed_at);
    if (!EVENT_KINDS.has(kind)) throw new Error("each event requires an allowed kind");
    if (!Number.isInteger(observedAt) || observedAt > now + 300000 || observedAt < now - 7 * 86400000) throw new Error("observed_at is outside the accepted window");
    const payload = normalizeEventData(kind, scrubTelemetry(event.data || {}));
    const serialized = JSON.stringify(payload);
    if (serialized.length > 8192) throw new Error("telemetry record exceeds 8192 bytes after redaction");
    return { kind, observedAt, payload, serialized };
  });
  if (new Set(normalized.map((event) => event.kind)).size !== normalized.length) throw new Error("each telemetry kind may appear only once per signed sequence");
  return normalized;
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
  try {
    const key = await crypto.subtle.importKey("raw", b64url(publicKey), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(deviceEnrollmentPreimage({ tenantId, assetId, publicKey, signedAt }));
    if (!await crypto.subtle.verify({ name: "Ed25519" }, key, b64url(input.signature), message)) throw new Error("invalid device enrollment signature");
  } catch (error) { if (error.message === "invalid device enrollment signature") throw error; throw new Error("invalid device public key or signature"); }
  const inserted=await db.prepare("INSERT INTO managed_devices(tenant_id,asset_id,public_key,status,last_sequence,created_at,updated_at) SELECT ?,?,?,'active',0,?,? WHERE (SELECT COUNT(*) FROM managed_devices WHERE tenant_id=? AND status='active') < ? OR EXISTS(SELECT 1 FROM managed_devices WHERE tenant_id=? AND asset_id=? AND status='active') ON CONFLICT(tenant_id,asset_id) DO UPDATE SET public_key=excluded.public_key,status='active',last_sequence=CASE WHEN managed_devices.public_key=excluded.public_key THEN managed_devices.last_sequence ELSE 0 END,updated_at=excluded.updated_at")
    .bind(tenantId, assetId, publicKey, now, now, tenantId, tenant.max_assets, tenantId, assetId).run();
  if(inserted.meta?.changes!==1)throw new Error("tenant asset limit exceeded");
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
  const subscription = await db.prepare("SELECT status,paid_through FROM managed_subscriptions WHERE tenant_id=?").bind(tenantId).first();
  if (subscription && !(subscription.status === "active" && Number(subscription.paid_through) > now)) throw new Error("active subscription required");
  const events = validateTelemetryBatch({ events: input.events }, now);
  try {
    const key = await crypto.subtle.importKey("raw", b64url(device.public_key), { name: "Ed25519" }, false, ["verify"]);
    const message = new TextEncoder().encode(await telemetryPreimage({ tenant_id: tenantId, asset_id: assetId, sequence, observed_at: observedAt, events: input.events }));
    if (!await crypto.subtle.verify({ name: "Ed25519" }, key, b64url(input.signature), message)) throw new Error("invalid telemetry signature");
  } catch (error) { if (error.message === "invalid telemetry signature") throw error; throw new Error("invalid telemetry signature encoding"); }
  const statements = [db.prepare("UPDATE managed_devices SET last_sequence=?,last_seen_at=?,updated_at=? WHERE tenant_id=? AND asset_id=? AND last_sequence<? RETURNING asset_id").bind(sequence, observedAt, now, tenantId, assetId, sequence)];
  // Force the whole batch to roll back when another request already advanced
  // this sequence; checking equality alone would admit duplicate telemetry.
  statements.push(db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,CASE WHEN changes()=1 THEN 'telemetry_accepted' ELSE NULL END,?,?)").bind(tenantId,JSON.stringify({asset_id:assetId,sequence}),now));
  for (const event of events) {
    statements.push(db.prepare("INSERT INTO managed_assets(tenant_id,asset_id,last_seen_at,status,updated_at) SELECT ?,?,?,'observed',? WHERE EXISTS (SELECT 1 FROM managed_devices WHERE tenant_id=? AND asset_id=? AND last_sequence=?) ON CONFLICT(tenant_id,asset_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at").bind(tenantId, assetId, event.observedAt, now, tenantId, assetId, sequence));
    statements.push(db.prepare("INSERT INTO managed_telemetry(id,tenant_id,asset_id,sequence,kind,observed_at,data_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM managed_devices WHERE tenant_id=? AND asset_id=? AND last_sequence=?)").bind(crypto.randomUUID(), tenantId, assetId, sequence, event.kind, event.observedAt, event.serialized, now, tenantId, assetId, sequence));
  }
  const results = await db.batch(statements);
  if (!results[0]?.results?.[0]?.asset_id) throw new Error("replayed or out-of-order telemetry sequence");
  return { accepted: events.length, tenant_id: tenantId, asset_id: assetId, sequence, remote_action: false };
}

function managedOpsManifest() {
  return {
    product: "MAG Managed Operations",
    maturity: "phase_0_evidence_plane",
    positioning: "Vendor-neutral RMM/PSA and observability foundation for authorized customer assets.",
    plans: PLANS,
    capabilities: ["tenant-scoped intake", "per-device signed telemetry", "inventory and heartbeat evidence", "patch and backup status", "security finding normalization", "ticket workflow", "customer white-label profile", "validated branding fields", "tenant-scoped evidence dashboard", "approval-ready remediation proposals"],
    deliberately_absent: ["remote shell", "arbitrary command execution", "credential collection", "silent software installation", "automatic remediation", "autonomous purchasing"],
    authority: "Enrollment covers telemetry only. Every future change action requires a separately recorded customer approval and a bounded runbook.",
    privacy: "Telemetry fields whose names imply passwords, secrets, tokens, credentials, keys, cookies, or sessions are redacted before storage.",
    device_trust: "Each endpoint has an Ed25519 key, signs a canonical batch digest, and advances a monotonic replay-protection sequence.",
    api: { create_tenant: "POST /api/managed-ops/tenants", enroll_device: "POST /api/managed-ops/tenants/:id/devices", ingest: "POST /api/managed-ops/telemetry", tenant: "GET /api/managed-ops/tenants/:id", branding: "GET|PUT /api/managed-ops/tenants/:id/branding", dashboard: "GET /api/managed-ops/tenants/:id/dashboard", console: "/ops/console", screenconnect: "/ops/screenconnect" },
  };
}

function managedOpsPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Northstar IT Operations · Powered by MAG</title>
<style>:root{--navy:#061a33;--deep:#041326;--panel:#0a2744;--panel2:#0c304f;--line:#1e5774;--cyan:#11d8ed;--gold:#f6c653;--green:#7ce9ba;--red:#ff8d91;--ink:#eaf7ff;--muted:#9eb6c9}*{box-sizing:border-box}body{margin:0;background:var(--navy);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}.shell{display:grid;grid-template-columns:246px minmax(0,1fr);min-height:100vh}.side{display:flex;flex-direction:column;padding:24px 18px;background:var(--deep);border-right:1px solid var(--line)}.tenant-brand{display:flex;align-items:center;gap:12px;font-weight:900;font-size:1.05rem}.tenant-mark{display:grid;place-items:center;width:44px;height:44px;border-radius:13px;background:linear-gradient(145deg,var(--cyan),#0875ba);color:#031528;font-size:1.35rem;box-shadow:0 0 0 3px #0b3453}.tenant-sub{color:var(--muted);font-size:.8rem;margin:8px 0 26px 56px}.nav{display:grid;gap:5px}.nav a{padding:10px 12px;border-radius:9px;color:var(--muted);text-decoration:none}.nav a.active,.nav a:hover{background:#0c3454;color:var(--ink)}.powered{display:flex;gap:9px;align-items:center;margin-top:auto;padding-top:26px;color:#789bb1;font-size:.78rem}.powered img{width:30px;height:30px;object-fit:contain}main{padding:28px;min-width:0}.top{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.eyebrow{margin:0;color:var(--cyan);font-size:.76rem;font-weight:800;letter-spacing:.11em}.top h1{margin:.3rem 0;font-size:clamp(1.65rem,3vw,2.35rem)}.top-note{margin:0;color:var(--muted)}.badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.badge{border:1px solid #31715f;color:var(--green);border-radius:999px;padding:6px 10px;white-space:nowrap}.badge.readonly{border-color:#866d2d;color:var(--gold)}.boundary{margin:18px 0 0;padding:12px 15px;border:1px solid #7f672b;border-left:4px solid var(--gold);border-radius:10px;background:#2a281c;color:#f7e9bc}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:18px 0}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px}.card span,.label{color:var(--muted)}.metric{margin:.2rem 0;font-size:2rem;font-weight:900}.good{color:var(--green)}.warn{color:var(--gold)}.bad{color:var(--red)}.layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(290px,.75fr);gap:14px;margin-top:14px}.stack{display:grid;gap:14px}.panel h2{margin:.1rem 0 14px;font-size:1.05rem}.panel-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.minor{font-size:.78rem;color:var(--muted)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #19405d;vertical-align:top}th{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}tbody tr:last-child td{border-bottom:0}.state{display:inline-block;padding:3px 8px;border-radius:999px;background:#103b48;font-size:.76rem}.state.attn{background:#4a3b1d;color:#ffe39b}.state.risk{background:#4b2631;color:#ffc5c8}.posture-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.posture{padding:14px;border:1px solid #1a4e6a;border-radius:12px;background:var(--panel2)}.posture b{font-size:1.35rem}.bar{height:7px;margin:9px 0;border-radius:99px;background:#163a53;overflow:hidden}.fill{display:block;height:100%;background:linear-gradient(90deg,var(--cyan),var(--green))}.fill.patch{width:94%}.fill.backup{width:98%}.approval{padding:12px 0;border-bottom:1px solid #19405d}.approval:last-of-type{border-bottom:0}.approval p{margin:4px 0}.finding-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}.finding-summary div{padding:10px;border-radius:10px;background:var(--panel2);text-align:center}.finding-summary b{display:block;font-size:1.25rem}.disclaimer{margin:12px 0 0;color:var(--muted);font-size:.8rem}.footer-note{margin:18px 0 0;color:#789bb1;font-size:.78rem}@media(max-width:1050px){.cards{grid-template-columns:repeat(2,1fr)}.layout{grid-template-columns:1fr}}@media(max-width:760px){.shell{grid-template-columns:1fr}.side{display:none}main{padding:20px}.top{display:block}.badges{justify-content:flex-start;margin-top:12px}.posture-grid{grid-template-columns:1fr}}@media(max-width:520px){.cards{grid-template-columns:1fr}.finding-summary{grid-template-columns:repeat(2,1fr)}table{display:block;overflow-x:auto}}</style>
</head>
<body>
<div class="shell">
<aside class="side">
<div class="tenant-brand">
<span class="tenant-mark" aria-hidden="true">N</span>
<span>Northstar IT</span>
</div>
<div class="tenant-sub">Managed services workspace</div>
<nav class="nav" aria-label="Operations"><a href="/ops/console">Open your workspace →</a><a href="/ops/screenconnect">ScreenConnect integration</a>
<a class="active" href="#overview">Overview</a>
<a href="#fleet">Fleet</a>
<a href="#tickets">Tickets &amp; SLA</a>
<a href="#posture">Patches &amp; backups</a>
<a href="#security">Security evidence</a>
<a href="#approvals">Approvals</a>
<a href="#reports">Reports</a>
</nav>
<div class="powered">
<img src="/mag-app-icon.png" alt="MAG">
<span>Powered by MAG Managed Operations</span>
</div>
</aside>
<main id="overview">
<header class="top">
<div>
<p class="eyebrow">WHITE-LABEL PREVIEW · SAMPLE EVIDENCE</p>
<h1>Northstar operations center</h1>
<p class="top-note">Fleet health, service delivery, and security evidence in one tenant-scoped view.</p>
</div>
<div class="badges">
<span class="badge">● Intake healthy</span>
<span class="badge readonly">Phase zero · read-only</span>
</div>
</header>
<div class="boundary">
<b>Evidence plane only.</b> No remote shell, arbitrary command execution, or automatic remediation. Every future change action requires a separately authorized, digest-bound runbook and rollback plan.</div>
<section class="cards" aria-label="Fleet KPIs">
<article class="card">
<span>Managed assets</span>
<div class="metric">148</div>
<small class="good">146 reporting · 98.6%</small>
</article>
<article class="card">
<span>Open tickets</span>
<div class="metric">12</div>
<small class="warn">2 SLA risks · 3 approvals</small>
</article>
<article class="card">
<span>Patch posture</span>
<div class="metric">94%</div>
<small class="warn">8 assets need review</small>
</article>
<article class="card">
<span>Backup posture</span>
<div class="metric">98%</div>
<small class="good">145 recently protected</small>
</article>
</section>
<div class="layout">
<div class="stack">
<section class="panel" id="fleet">
<div class="panel-head">
<h2>Fleet evidence</h2>
<span class="minor">Reporting cutoff: 15 minutes</span>
</div>
<table>
<thead>
<tr>
<th>Asset</th>
<th>Platform</th>
<th>Last seen</th>
<th>Patch</th>
<th>Backup</th>
<th>State</th>
</tr>
</thead>
<tbody>
<tr>
<td>NS-DEN-LT-014</td>
<td>Windows 11</td>
<td>42 sec</td>
<td class="good">Current</td>
<td class="good">Healthy</td>
<td>
<span class="state">Reporting</span>
</td>
</tr>
<tr>
<td>NS-NYC-SRV-02</td>
<td>Windows Server</td>
<td>2 min</td>
<td class="warn">2 critical</td>
<td class="good">Healthy</td>
<td>
<span class="state attn">Review</span>
</td>
</tr>
<tr>
<td>NS-REMOTE-31</td>
<td>macOS</td>
<td>4 min</td>
<td class="good">Current</td>
<td class="bad">Missed</td>
<td>
<span class="state attn">Review</span>
</td>
</tr>
<tr>
<td>NS-LAB-LNX-07</td>
<td>Ubuntu</td>
<td>37 min</td>
<td>Unknown</td>
<td>Not scoped</td>
<td>
<span class="state risk">Stale</span>
</td>
</tr>
</tbody>
</table>
</section>
<section class="panel" id="tickets">
<div class="panel-head">
<h2>Tickets &amp; SLA</h2>
<span class="minor">12 open · sample queue</span>
</div>
<table>
<thead>
<tr>
<th>Ticket</th>
<th>Issue</th>
<th>Priority</th>
<th>SLA</th>
<th>Status</th>
</tr>
</thead>
<tbody>
<tr>
<td>TCK-1042</td>
<td>Endpoint protection evidence absent</td>
<td class="bad">Critical</td>
<td class="bad">37 min to breach</td>
<td>Triaging</td>
</tr>
<tr>
<td>TCK-1039</td>
<td>Scheduled backup missed</td>
<td class="warn">High</td>
<td>1 h 42 min</td>
<td>Awaiting approval</td>
</tr>
<tr>
<td>TCK-1028</td>
<td>Inventory record drift</td>
<td>Medium</td>
<td class="good">4 h 12 min</td>
<td>Evidence requested</td>
</tr>
</tbody>
</table>
</section>
<section class="panel" id="security">
<div class="panel-head">
<h2>Security findings</h2>
<span class="minor">Deduplicated · last 30 days</span>
</div>
<div class="finding-summary">
<div>
<b class="bad">1</b>Critical</div>
<div>
<b class="warn">4</b>High</div>
<div>
<b>8</b>Medium</div>
<div>
<b>17</b>Low / info</div>
</div>
<table>
<thead>
<tr>
<th>Finding</th>
<th>Asset</th>
<th>Evidence</th>
<th>Disposition</th>
</tr>
</thead>
<tbody>
<tr>
<td>Endpoint control disabled</td>
<td>NS-NYC-SRV-02</td>
<td>sha256:8b7c…19e2</td>
<td>
<span class="state risk">Needs triage</span>
</td>
</tr>
<tr>
<td>Critical updates missing</td>
<td>NS-NYC-SRV-02</td>
<td>2 observed</td>
<td>
<span class="state attn">Proposal ready</span>
</td>
</tr>
<tr>
<td>Backup recovery point missed</td>
<td>NS-REMOTE-31</td>
<td>26 h stale</td>
<td>
<span class="state attn">Review</span>
</td>
</tr>
</tbody>
</table>
<p class="disclaimer">Security evidence is not represented as EDR, MDR, incident response, or proof that a system is safe. Findings require reproducible verification and an explicit disposition.</p>
</section>
</div>
<div class="stack">
<section class="panel" id="posture">
<h2>Patch &amp; backup posture</h2>
<div class="posture-grid">
<div class="posture">
<span class="label">Fresh patch evidence</span>
<br>
<b>139 / 148</b>
<div class="bar">
<span class="fill patch">
</span>
</div>
<small>24-hour freshness window</small>
</div>
<div class="posture">
<span class="label">Healthy backups</span>
<br>
<b>145 / 148</b>
<div class="bar">
<span class="fill backup">
</span>
</div>
<small>3 need review</small>
</div>
</div>
<p class="disclaimer">Missing or stale observations remain unknown; they are never counted as healthy.</p>
</section>
<section class="panel" id="approvals">
<div class="panel-head">
<h2>Approval queue</h2>
<span class="state attn">3 pending</span>
</div>
<div class="approval">
<b class="bad">Critical patch proposal</b>
<p>NS-NYC-SRV-02 · exact KB scope</p>
<span class="minor">Runbook and rollback attached · owner review required</span>
</div>
<div class="approval">
<b class="warn">Backup policy proposal</b>
<p>NS-REMOTE-31 · schedule correction</p>
<span class="minor">Customer approval required</span>
</div>
<div class="approval">
<b>Inventory reconciliation</b>
<p>NS-LAB-LNX-07 · request fresh evidence</p>
<span class="minor">Read-only collection request</span>
</div>
<p class="disclaimer">Approval records do not execute commands. Phase zero produces evidence and bounded proposals only.</p>
</section>
<section class="panel" id="reports">
<h2>Evidence report</h2>
<p>
<b>Weekly tenant summary</b>
</p>
<p class="minor">Fleet coverage, SLA outcomes, patch and backup freshness, finding dispositions, proposal receipts, and append-only audit events.</p>
<span class="state">Next draft · Monday 08:00</span>
</section>
</div>
</div>
<p class="footer-note">Sample interface only. All values above are illustrative and do not represent a live customer environment.</p>
</main>
</div>
</body>
</html>`;
}

export { PLANS, aggregateTenantDashboard, authorizedTenant, createManagedTenant, createTenantBranding, deviceEnrollmentPreimage, ingestTelemetry, managedOpsManifest, managedOpsPage, normalizeEventData, planById, readTenantBranding, readTenantDashboard, registerDevice, scrubTelemetry, telemetryPreimage, updateTenantBranding, validateTelemetryBatch, validateTenant, validateTenantBranding };
