import { authorizedTenant } from "./managed-ops.js";
const STATES = new Set(["open", "triaging", "in_progress", "awaiting_customer", "resolved", "closed"]);
const SEVERITIES = new Set(["informational", "low", "medium", "high", "critical"]);
const SLA_HOURS = { critical: 4, high: 8, medium: 24, low: 72, informational: 120 };
function text(value, max) { return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max); }
async function tenantAccess(db, id, token) {
  const tenant = await authorizedTenant(db, id, token);
  if (!tenant || tenant.status !== "active") throw new Error("active tenant authorization required");
  return tenant;
}
function validateTicket(input) {
  const title = text(input.title, 200), description = text(input.description, 4000);
  const severity = text(input.severity || "medium", 20);
  const requestKey = text(input.request_key, 80), assetId = text(input.asset_id, 120) || null;
  if (title.length < 8 || description.length < 20 || !SEVERITIES.has(severity)) throw new Error("clear title, description, and valid severity are required");
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(requestKey)) throw new Error("request_key must be a stable 16-80 character idempotency key");
  return { title, description, severity, requestKey, assetId };
}
async function listTickets(db, tenantId, token, now = Date.now()) {
  await tenantAccess(db, tenantId, token);
  const rows = await db.prepare("SELECT id,asset_id,severity,title,description,status,version,due_at,resolution,resolved_at,created_at,updated_at FROM managed_tickets WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200").bind(tenantId).all();
  return (rows.results || []).map(row => ({ ...row, sla_overdue: !["resolved","closed"].includes(row.status) && row.due_at !== null && row.due_at < now }));
}
async function createTicket(db, tenantId, token, input, now = Date.now()) {
  await tenantAccess(db, tenantId, token);
  const value = validateTicket(input);
  if (value.assetId && !await db.prepare("SELECT asset_id FROM managed_assets WHERE tenant_id=? AND asset_id=?").bind(tenantId,value.assetId).first()) throw new Error("asset is not in this tenant");
  const existing = await db.prepare("SELECT id,title,description,severity,asset_id FROM managed_tickets WHERE tenant_id=? AND request_key=?").bind(tenantId,value.requestKey).first();
  if (existing) {
    if (existing.title !== value.title || existing.description !== value.description || existing.severity !== value.severity || existing.asset_id !== value.assetId) throw new Error("request_key already used for a different ticket");
    return { id: existing.id, duplicate: true };
  }
  const id = crypto.randomUUID();
  const results = await db.batch([
    db.prepare("INSERT INTO managed_tickets(id,tenant_id,asset_id,severity,title,description,evidence_json,status,request_key,due_at,created_at,updated_at) SELECT ?,?,?,?,?,?,'{}','open',?,?,?,? FROM managed_tenants WHERE id=? AND status='active'")
      .bind(id,tenantId,value.assetId,value.severity,value.title,value.description,value.requestKey,now+SLA_HOURS[value.severity]*3600000,now,now,tenantId),
    db.prepare("INSERT INTO managed_ticket_events(id,tenant_id,ticket_id,version,kind,note,created_at) SELECT ?,tenant_id,id,version,'created','Customer service request',? FROM managed_tickets WHERE id=?")
      .bind(crypto.randomUUID(),now,id),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) throw new Error("tenant state changed; reload");
  return { id, status: "open", version: 1, duplicate: false };
}
async function updateTicket(db, tenantId, token, id, input, now = Date.now()) {
  await tenantAccess(db,tenantId,token);
  const status = text(input.status,30), note = text(input.note,2000), version = Number(input.expected_version);
  if (!STATES.has(status) || note.length < 10 || !Number.isSafeInteger(version) || version < 1) throw new Error("status, explanatory note, and expected_version are required");
  const previous = await db.prepare("SELECT id,status FROM managed_tickets WHERE tenant_id=? AND id=?").bind(tenantId,id).first();
  if (!previous) throw new Error("ticket not found");
  if (status === "closed" && previous.status !== "resolved") throw new Error("resolve the ticket with evidence before closing");
  const terminal = ["resolved","closed"].includes(status);
  const results = await db.batch([
    db.prepare("UPDATE managed_tickets SET status=?,resolution=CASE WHEN ? THEN ? ELSE '' END,resolved_at=CASE WHEN ? THEN COALESCE(resolved_at,?) ELSE NULL END,version=version+1,updated_at=? WHERE tenant_id=? AND id=? AND version=? AND status=? AND EXISTS (SELECT 1 FROM managed_tenants WHERE id=? AND status='active')")
      .bind(status,terminal?1:0,note,terminal?1:0,now,now,tenantId,id,version,previous.status,tenantId),
    db.prepare("INSERT INTO managed_ticket_events(id,tenant_id,ticket_id,version,kind,note,created_at) SELECT ?,tenant_id,id,version,'status_changed',?,? FROM managed_tickets WHERE changes()=1 AND tenant_id=? AND id=? AND version=?")
      .bind(crypto.randomUUID(),note,now,tenantId,id,version+1),
  ]);
  if (Number(results[0]?.meta?.changes) !== 1) throw new Error("ticket changed; reload before updating");
  return { id, status, version: version+1, remote_action: false };
}
export { createTicket, listTickets, updateTicket, validateTicket };
