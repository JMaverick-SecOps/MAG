import { authorizedMigration, isVaultReference } from "./migration-service.js";

const SIDES = new Set(["source", "target"]);
const CONNECTION_STATUS = new Set(["pending_validation", "ready", "rejected", "revoked"]);
const RESULT_STATUS = new Set(["continue", "complete", "blocked"]);
const RESULT_PHASES = new Set(["preflight", "discovery", "mapping_validation", "initial_sync", "delta_sync", "preauthorized_cutover", "verification", "report"]);
const MAIL_WORKLOADS = new Set(["mail", "calendar", "contacts"]);
const ITEM_WORKLOADS = new Set(["mail", "calendar", "contacts", "onedrive", "sharepoint", "google_drive", "shared_drives", "dropbox"]);
const PHASES = ["preflight", "discovery", "mapping_validation", "initial_sync", "delta_sync", "preauthorized_cutover", "verification", "report"];
const PROVIDER_REQUIREMENTS = Object.freeze({
  m365: { authorization: "oauth2_admin_consent", scopes: ["offline_access", "User.Read.All", "Mail.ReadWrite", "Calendars.ReadWrite", "Contacts.ReadWrite", "Files.ReadWrite.All", "Sites.ReadWrite.All"], connector: "microsoft_graph" },
  google_workspace: { authorization: "oauth2_domain_wide_delegation", scopes: ["gmail.modify", "calendar", "contacts", "drive"], connector: "google_apis" },
  imap: { authorization: "vaulted_oauth_or_app_password", scopes: ["mail_read", "mail_write"], connector: "imap_tls_993" },
  dropbox: { authorization: "oauth2_scoped_app", scopes: ["files.metadata.read", "files.content.read", "files.content.write"], connector: "dropbox_api" },
  sharepoint: { authorization: "oauth2_admin_consent", scopes: ["Sites.ReadWrite.All", "Files.ReadWrite.All"], connector: "microsoft_graph" },
  google_drive: { authorization: "oauth2_domain_wide_delegation", scopes: ["drive"], connector: "google_drive_api" },
});

function clean(value, maximum) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function connectorRequirements(provider) {
  return PROVIDER_REQUIREMENTS[clean(provider, 40)] || null;
}

function validateConnectionInput(project, input) {
  const side = clean(input.side, 10).toLowerCase();
  if (!SIDES.has(side)) throw new Error("side must be source or target");
  const expectedProvider = side === "source" ? project.source_provider : project.target_provider;
  const provider = clean(input.provider, 40);
  if (provider !== expectedProvider || !connectorRequirements(provider)) throw new Error("connection provider does not match the migration project");
  const vaultReference = clean(input.vault_reference, 160);
  if (!isVaultReference(vaultReference)) throw new Error("an explicit vault:, secret-store:, or connector: reference is required; raw credentials are forbidden");
  const tenantHint = clean(input.tenant_hint, 254);
  const imapHost = clean(input.imap_host, 253).toLowerCase();
  if (provider === "imap" && (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(imapHost) || Number(input.imap_port || 993) !== 993)) throw new Error("IMAP requires a DNS hostname and implicit TLS port 993");
  return { side, provider, vaultReference, tenantHint, imapHost: provider === "imap" ? imapHost : "", imapPort: provider === "imap" ? 993 : null, requirements: connectorRequirements(provider) };
}

function validateMappings(project, input) {
  const mappings = Array.isArray(input.mappings) ? input.mappings : [];
  if (!mappings.length || mappings.length > 1000) throw new Error("mappings must contain 1-1000 rows");
  const allowed = new Set(Array.isArray(project.workloads) ? project.workloads : JSON.parse(project.workloads_json || "[]"));
  const seen = new Set();
  return mappings.map((mapping, index) => {
    const workload = clean(mapping.workload, 40).toLowerCase();
    const sourcePrincipal = clean(mapping.source_principal, 320);
    const targetPrincipal = clean(mapping.target_principal, 320);
    const sourceContainer = clean(mapping.source_container, 500);
    const targetContainer = clean(mapping.target_container, 500);
    if (!allowed.has(workload)) throw new Error(`mapping ${index + 1} has a workload outside project scope`);
    if (sourcePrincipal.length < 2 || targetPrincipal.length < 2) throw new Error(`mapping ${index + 1} requires source and target principals`);
    if (MAIL_WORKLOADS.has(workload) && (!sourcePrincipal.includes("@") || !targetPrincipal.includes("@"))) throw new Error(`mapping ${index + 1} requires mailbox-form principals`);
    const key = `${workload}\u0000${sourcePrincipal}\u0000${sourceContainer}`;
    if (seen.has(key)) throw new Error(`mapping ${index + 1} duplicates a source scope`);
    seen.add(key);
    return { id: crypto.randomUUID(), workload, sourcePrincipal, targetPrincipal, sourceContainer, targetContainer };
  });
}

async function upsertMigrationConnection(db, projectId, accessToken, input) {
  const project = await authorizedMigration(db, projectId, accessToken);
  if (!project) throw new Error("project not found or unauthorized");
  if (project.status !== "awaiting_preflight") throw new Error("connections can change only before delivery and payment preflight completes");
  const connection = validateConnectionInput(project, input);
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO migration_connections(project_id,side,provider,vault_reference,tenant_hint,imap_host,imap_port,required_scopes_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'pending_validation',?,?) ON CONFLICT(project_id,side) DO UPDATE SET provider=excluded.provider,vault_reference=excluded.vault_reference,tenant_hint=excluded.tenant_hint,imap_host=excluded.imap_host,imap_port=excluded.imap_port,required_scopes_json=excluded.required_scopes_json,status='pending_validation',validation_code=NULL,validated_at=NULL,updated_at=excluded.updated_at")
      .bind(projectId, connection.side, connection.provider, connection.vaultReference, connection.tenantHint, connection.imapHost, connection.imapPort, JSON.stringify(connection.requirements.scopes), now, now),
    db.prepare("UPDATE migration_mappings SET status='pending',updated_at=? WHERE project_id=?").bind(now, projectId),
    db.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) VALUES(?,'connection_registered',?,?)")
      .bind(projectId, JSON.stringify({ side: connection.side, provider: connection.provider, vault_reference_present: true, credentials_received: false }), now),
  ]);
  return { side: connection.side, provider: connection.provider, status: "pending_validation", authorization: connection.requirements.authorization, required_scopes: connection.requirements.scopes, warning: "The vault reference is an identifier only. Provider secrets must never be sent to MAG's public API." };
}

async function replaceMigrationMappings(db, projectId, accessToken, input) {
  const project = await authorizedMigration(db, projectId, accessToken);
  if (!project) throw new Error("project not found or unauthorized");
  if (project.status !== "awaiting_preflight") throw new Error("mappings can change only before delivery and payment preflight completes");
  const mappings = validateMappings(project, input);
  const now = Date.now();
  const statements = [db.prepare("DELETE FROM migration_mappings WHERE project_id=?").bind(projectId)];
  for (const mapping of mappings) statements.push(db.prepare("INSERT INTO migration_mappings(id,project_id,workload,source_principal,target_principal,source_container,target_container,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)").bind(mapping.id, projectId, mapping.workload, mapping.sourcePrincipal, mapping.targetPrincipal, mapping.sourceContainer, mapping.targetContainer, now, now));
  statements.push(db.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) VALUES(?,'mappings_replaced',?,?)").bind(projectId, JSON.stringify({ count: mappings.length, customer_supplied: true, validation: "structural_only_connector_preflight_still_required" }), now));
  await db.batch(statements);
  return { count: mappings.length, status: "pending_connector_preflight", structural_validation: "passed", connector_preflight_required: true };
}

async function migrationReadiness(db, projectId, options = {}) {
  const [project, connections, mappingCount] = await Promise.all([
    db.prepare("SELECT id,source_provider,target_provider,payment_status,status,phase,cutover_start,cutover_end,workflow_generation FROM migration_projects WHERE id=?").bind(projectId).first(),
    db.prepare("SELECT side,provider,status,validation_code,validated_at FROM migration_connections WHERE project_id=? ORDER BY side").bind(projectId).all(),
    db.prepare("SELECT COUNT(*) n FROM migration_mappings WHERE project_id=? AND status='validated'").bind(projectId).first(),
  ]);
  if (!project) return { ready: false, reasons: ["project_not_found"] };
  const rows = connections.results || [];
  const reasons = [];
  if (options.execution === true) {
    if (!["starting", "running"].includes(project.status)) reasons.push("project_status_not_executing");
    if (Number(project.workflow_generation) !== Number(options.expectedGeneration)) reasons.push("workflow_generation_mismatch");
  } else if (!["queued", "needs_attention"].includes(project.status)) reasons.push("project_status_not_startable");
  if (project.payment_status !== "verified") reasons.push("payment_not_verified");
  for (const side of SIDES) if (!rows.some((row) => row.side === side && row.status === "ready")) reasons.push(`${side}_connection_not_ready`);
  if (Number(mappingCount?.n || 0) < 1) reasons.push("mappings_missing");
  const cutoverStart = Number(project.cutover_start), cutoverEnd = Number(project.cutover_end);
  if (!Number.isInteger(cutoverStart) || !Number.isInteger(cutoverEnd) || cutoverEnd <= cutoverStart || Date.now() >= cutoverEnd) reasons.push("cutover_window_invalid_or_expired");
  return { ready: reasons.length === 0, reasons, project, connections: rows, mapping_count: Number(mappingCount?.n || 0), connector_worker_required: true };
}

async function migrationPaymentReadiness(env, projectId) {
  if (!env.DB) return { ready: false, reasons: ["database_not_configured"] };
  const [project, connections, mappingCounts] = await Promise.all([
    env.DB.prepare("SELECT id,status,payment_status,cutover_start,cutover_end FROM migration_projects WHERE id=?").bind(projectId).first(),
    env.DB.prepare("SELECT side,status FROM migration_connections WHERE project_id=? ORDER BY side").bind(projectId).all(),
    env.DB.prepare("SELECT status,COUNT(*) n FROM migration_mappings WHERE project_id=? GROUP BY status").bind(projectId).all(),
  ]);
  if (!project) return { ready: false, reasons: ["project_not_found"] };
  const reasons = [];
  if (!env.MIGRATION_CONNECTOR) reasons.push("private_connector_not_configured");
  if (!env.MIGRATION_WORKFLOW) reasons.push("workflow_not_configured");
  if (!/^0x[a-fA-F0-9]{40}$/.test(env.TREASURY_WALLET_ADDRESS || "")) reasons.push("treasury_not_configured");
  if (project.status !== "awaiting_preflight" || project.payment_status !== "not_requested") reasons.push("project_not_awaiting_preflight");
  const connectionRows = connections.results || [];
  for (const side of SIDES) if (!connectionRows.some((row) => row.side === side && row.status === "ready")) reasons.push(`${side}_connection_not_ready`);
  const counts = new Map((mappingCounts.results || []).map((row) => [row.status, Number(row.n || 0)]));
  if (!counts.get("validated")) reasons.push("validated_mappings_missing");
  if ((counts.get("pending") || 0) > 0 || (counts.get("rejected") || 0) > 0) reasons.push("mapping_preflight_incomplete");
  const now = Date.now();
  if (!Number.isInteger(Number(project.cutover_start)) || !Number.isInteger(Number(project.cutover_end)) || Number(project.cutover_end) <= Number(project.cutover_start) || now >= Number(project.cutover_end)) reasons.push("cutover_window_invalid_or_expired");
  return { ready: reasons.length === 0, reasons, project, delivery_capacity_confirmed: Boolean(env.MIGRATION_CONNECTOR && env.MIGRATION_WORKFLOW) };
}

function canonicalMappings(rows) {
  return [...rows].map((row) => ({ id: String(row.id), workload: String(row.workload), source_principal: String(row.source_principal), target_principal: String(row.target_principal), source_container: String(row.source_container || ""), target_container: String(row.target_container || "") })).sort((a, b) => a.id.localeCompare(b.id));
}

async function validatePendingMigrationMappings(env) {
  if (!env.DB || !env.MIGRATION_CONNECTOR) return { configured: false, checked: 0, validated: 0, rejected: 0 };
  const projects = await env.DB.prepare("SELECT p.id,p.source_provider,p.target_provider FROM migration_projects p WHERE p.status='awaiting_preflight' AND EXISTS (SELECT 1 FROM migration_connections c WHERE c.project_id=p.id AND c.side='source' AND c.status='ready') AND EXISTS (SELECT 1 FROM migration_connections c WHERE c.project_id=p.id AND c.side='target' AND c.status='ready') AND EXISTS (SELECT 1 FROM migration_mappings m WHERE m.project_id=p.id AND m.status='pending') ORDER BY p.updated_at LIMIT 10").all();
  let validated = 0, rejected = 0;
  for (const project of projects.results || []) {
    try {
      const pending = await env.DB.prepare("SELECT id,workload,source_principal,target_principal,source_container,target_container FROM migration_mappings WHERE project_id=? AND status='pending' ORDER BY id LIMIT 1000").bind(project.id).all();
      const mappings = canonicalMappings(pending.results || []);
      if (!mappings.length) continue;
      const connections = await env.DB.prepare("SELECT side,updated_at FROM migration_connections WHERE project_id=? AND status='ready' ORDER BY side").bind(project.id).all();
      const versions = new Map((connections.results || []).map(c => [c.side,c.updated_at]));
      if (!versions.has("source") || !versions.has("target")) continue;
      const mappingDigest = `sha256:${await sha256Hex(JSON.stringify(mappings))}`;
      const response = await env.MIGRATION_CONNECTOR.fetch("https://migration-connector.internal/v1/mappings/validate", { method: "POST", headers: { "content-type": "application/json", "x-mag-contract": "mag.migration.connector.v1" }, body: JSON.stringify({ project_id: project.id, source_provider: project.source_provider, target_provider: project.target_provider, mapping_digest: mappingDigest, mappings }) });
      if (!response.ok) throw new Error(`connector mapping validation returned ${response.status}`);
      const result = await readSmallConnectorJson(response);
      const status = clean(result?.status, 20).toLowerCase();
      const validationCode = clean(result?.validation_code, 100);
      if (!["ready", "rejected"].includes(status) || result?.mapping_digest !== mappingDigest || !validationCode) throw new Error("connector mapping validation result is invalid or not bound to the submitted mapping set");
      const nextStatus = status === "ready" ? "validated" : "rejected";
      const now = Date.now();
      const results = await env.DB.batch([
        env.DB.prepare("UPDATE migration_mappings SET status=?,updated_at=? WHERE project_id=? AND status='pending' AND id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM migration_connections WHERE project_id=? AND side='source' AND status='ready' AND updated_at=?) AND EXISTS (SELECT 1 FROM migration_connections WHERE project_id=? AND side='target' AND status='ready' AND updated_at=?) AND EXISTS (SELECT 1 FROM migration_projects WHERE id=? AND status='awaiting_preflight')").bind(nextStatus, now, project.id, JSON.stringify(mappings.map(m=>m.id)), project.id, versions.get("source"), project.id, versions.get("target"), project.id),
        env.DB.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) SELECT ?,'mapping_preflight_completed',?,? WHERE changes()>0").bind(project.id, JSON.stringify({ status: nextStatus, validation_code: validationCode, mapping_digest: mappingDigest, count: mappings.length }), now),
      ]);
      const changed = Number(results?.[0]?.meta?.changes ?? mappings.length);
      if (nextStatus === "validated") validated += changed; else rejected += changed;
    } catch (error) {
      console.warn(JSON.stringify({ event: "migration_mapping_validation_deferred", project_id: project.id, message: String(error.message || error) }));
    }
  }
  return { configured: true, checked: (projects.results || []).length, validated, rejected };
}

async function authorizeReadyMigrationPayments(env) {
  if (!env.DB || !env.MIGRATION_CONNECTOR || !env.MIGRATION_WORKFLOW || !/^0x[a-fA-F0-9]{40}$/.test(env.TREASURY_WALLET_ADDRESS || "")) return { configured: false, examined: 0, authorized: 0 };
  const candidates = await env.DB.prepare("SELECT id FROM migration_projects WHERE status='awaiting_preflight' AND payment_status='not_requested' ORDER BY updated_at LIMIT 25").all();
  let authorized = 0;
  for (const row of candidates.results || []) {
    const readiness = await migrationPaymentReadiness(env, row.id);
    if (!readiness.ready) continue;
    const now = Date.now();
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE migration_projects SET status='awaiting_payment',payment_status='unsubmitted',updated_at=? WHERE id=? AND status='awaiting_preflight' AND payment_status='not_requested'").bind(now, row.id),
      env.DB.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) SELECT ?,'payment_authorized_after_preflight',?,? WHERE EXISTS (SELECT 1 FROM migration_projects WHERE id=? AND status='awaiting_payment' AND payment_status='unsubmitted')").bind(row.id, JSON.stringify({ connector_binding: true, workflow_binding: true, connections_validated: true, mappings_validated: true, delivery_capacity_confirmed: true }), now, row.id),
    ]);
    if (Number(results?.[0]?.meta?.changes ?? 1) === 1) authorized += 1;
  }
  return { configured: true, examined: (candidates.results || []).length, authorized };
}

async function readSmallConnectorJson(response, maximum = 16384) {
  if (!response.body) throw new Error("connector returned an empty validation response");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel("response too large"); throw new Error("connector validation response is too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function validatePendingMigrationConnections(env) {
  if (!env.DB || !env.MIGRATION_CONNECTOR) return { configured: false, checked: 0, ready: 0, rejected: 0 };
  const pending = await env.DB.prepare("SELECT project_id,side,provider,vault_reference,tenant_hint,imap_host,imap_port,required_scopes_json,updated_at FROM migration_connections WHERE status='pending_validation' ORDER BY updated_at LIMIT 20").all();
  let ready = 0, rejected = 0;
  for (const connection of pending.results || []) {
    try {
      const response = await env.MIGRATION_CONNECTOR.fetch("https://migration-connector.internal/v1/connections/validate", { method: "POST", headers: { "content-type": "application/json", "x-mag-contract": "mag.migration.connector.v1" }, body: JSON.stringify({ project_id: connection.project_id, side: connection.side, provider: connection.provider, vault_reference: connection.vault_reference, tenant_hint: connection.tenant_hint, imap_host: connection.imap_host, imap_port: connection.imap_port, required_scopes: JSON.parse(connection.required_scopes_json || "[]") }) });
      if (!response.ok) throw new Error(`connector validation returned ${response.status}`);
      const result = await readSmallConnectorJson(response);
      const status = clean(result?.status, 20).toLowerCase();
      const validationCode = clean(result?.validation_code, 100);
      if (!CONNECTION_STATUS.has(status) || !["ready", "rejected"].includes(status) || !validationCode) throw new Error("connector validation result is invalid");
      const now = Date.now();
      const updated = await env.DB.batch([
        env.DB.prepare("UPDATE migration_connections SET status=?,validation_code=?,validated_at=?,updated_at=? WHERE project_id=? AND side=? AND status='pending_validation' AND updated_at=? AND vault_reference=? AND tenant_hint=? AND imap_host=? AND imap_port IS ?").bind(status, validationCode, now, now, connection.project_id, connection.side, connection.updated_at, connection.vault_reference, connection.tenant_hint, connection.imap_host, connection.imap_port),
        env.DB.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) SELECT ?,'connection_validated',?,? WHERE changes()=1").bind(connection.project_id, JSON.stringify({ side: connection.side, provider: connection.provider, status, validation_code: validationCode, credentials_received: false }), now),
      ]);
      if (Number(updated[0]?.meta?.changes) === 1) { if (status === "ready") ready += 1; else rejected += 1; }
    } catch (error) {
      console.warn(JSON.stringify({ event: "migration_connection_validation_deferred", project_id: connection.project_id, side: connection.side, message: String(error.message || error) }));
    }
  }
  return { configured: true, checked: (pending.results || []).length, ready, rejected };
}

function validateConnectorResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("connector returned an invalid result");
  const status = clean(input.status, 20).toLowerCase();
  const phase = clean(input.phase, 40).toLowerCase();
  const batchId = clean(input.batch_id, 160);
  const cursor = input.cursor === null || input.cursor === undefined ? null : clean(input.cursor, 2000);
  if (!RESULT_STATUS.has(status) || !RESULT_PHASES.has(phase) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,159}$/.test(batchId)) throw new Error("connector result status, phase, or batch id is invalid");
  const integer = (name, maximum = Number.MAX_SAFE_INTEGER) => {
    const value = Number(input[name] || 0);
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`connector result ${name} is invalid`);
    return value;
  };
  const attempted = integer("attempted", 1000), succeeded = integer("succeeded", 1000), failed = integer("failed", 1000), bytes = integer("bytes", Number.MAX_SAFE_INTEGER);
  if (succeeded + failed > attempted) throw new Error("connector result counts are inconsistent");
  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  if (receipts.length > 100) throw new Error("connector result exceeds 100 item receipts");
  const normalizedReceipts = receipts.map((receipt) => {
    const workload = clean(receipt.workload, 40).toLowerCase();
    const sourceObjectId = clean(receipt.source_object_id, 500);
    const targetObjectId = clean(receipt.target_object_id, 500);
    const sourceVersion = clean(receipt.source_version, 300);
    const digest = clean(receipt.content_digest, 71).toLowerCase();
    const itemStatus = clean(receipt.status, 20).toLowerCase();
    const bytesCopied = String(receipt.bytes_copied || "0");
    const errorCode = clean(receipt.error_code, 100);
    if (!ITEM_WORKLOADS.has(workload) || !sourceObjectId || (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) || !["copied", "verified", "skipped", "failed"].includes(itemStatus) || !/^\d+$/.test(bytesCopied)) throw new Error("connector item receipt is invalid");
    if (["copied", "verified"].includes(itemStatus) && (!targetObjectId || !digest)) throw new Error("copied items require a target identifier and content digest");
    if (BigInt(bytesCopied) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("connector item byte count exceeds the bounded result size");
    return { workload, sourceObjectId, targetObjectId, sourceVersion, digest, itemStatus, bytesCopied, errorCode };
  });
  if (status === "complete" && phase !== "report") throw new Error("connector can complete a migration only in the report phase");
  return { status, phase, batchId, cursor, attempted, succeeded, failed, bytes, receipts: normalizedReceipts, reasonCode: clean(input.reason_code, 100) };
}

function canonicalConnectorResult(result) {
  return JSON.stringify({
    status: result.status,
    phase: result.phase,
    batch_id: result.batchId,
    cursor: result.cursor,
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.failed,
    bytes: result.bytes,
    reason_code: result.reasonCode,
    receipts: [...result.receipts].sort((a, b) => `${a.workload}\u0000${a.sourceObjectId}`.localeCompare(`${b.workload}\u0000${b.sourceObjectId}`)),
  });
}

function validatePhaseTransition(currentPhase, nextPhase, now, cutoverStart, cutoverEnd) {
  const current = PHASES.indexOf(clean(currentPhase, 40));
  const next = PHASES.indexOf(clean(nextPhase, 40));
  if (current < 0 || next < 0 || next < current || next > current + 1) throw new Error("connector attempted an invalid migration phase transition");
  if (nextPhase === "preauthorized_cutover" && (now < Number(cutoverStart) || now > Number(cutoverEnd))) throw new Error("connector attempted cutover outside the preauthorized window");
  return true;
}

async function recordConnectorResult(db, projectId, resultInput, context = {}, now = Date.now()) {
  const result = validateConnectorResult(resultInput);
  const generation = Number(context.generation ?? 0);
  const idempotencyKey = clean(context.idempotencyKey || `${projectId}:${generation}:${result.batchId}`, 240);
  if (!Number.isInteger(generation) || generation < 0 || !idempotencyKey) throw new Error("connector result context is invalid");
  const resultDigest = `sha256:${await sha256Hex(canonicalConnectorResult(result))}`;
  const project = await db.prepare("SELECT phase,status,payment_status,cutover_start,cutover_end,workloads_json,workflow_generation FROM migration_projects WHERE id=?").bind(projectId).first();
  if (!project) throw new Error("migration project not found");
  if (Number(project.workflow_generation) !== generation) throw new Error("connector result generation does not match the active workflow");
  validatePhaseTransition(project.phase, result.phase, now, project.cutover_start, project.cutover_end);
  const allowedWorkloads = new Set(JSON.parse(project.workloads_json || "[]"));
  if (result.receipts.some((receipt) => !allowedWorkloads.has(receipt.workload))) throw new Error("connector receipt workload is outside project scope");
  const existing = await db.prepare("SELECT result_digest,generation,idempotency_key FROM migration_batch_receipts WHERE project_id=? AND batch_id=?").bind(projectId, result.batchId).first();
  if (existing) {
    if (existing.result_digest !== resultDigest || Number(existing.generation) !== generation || existing.idempotency_key !== idempotencyKey) throw new Error("duplicate connector batch id has changed content or execution context");
    return { ...result, duplicate: true, result_digest: resultDigest };
  }
  if (!["starting", "running"].includes(project.status) || project.payment_status !== "verified") throw new Error("migration is not authorized to record new results");
  const nextStatus = result.status === "complete" && result.phase === "report" ? "completed" : result.status === "blocked" ? "needs_attention" : "running";
  const statements = [
    db.prepare("UPDATE migration_projects SET status=?,phase=?,continuation_cursor=?,workflow_instance_id=CASE WHEN ? IN ('needs_attention','completed') THEN NULL ELSE workflow_instance_id END,updated_at=? WHERE id=? AND workflow_generation=? AND phase=? AND status IN ('starting','running') AND payment_status='verified'").bind(nextStatus, result.phase, result.cursor, nextStatus, now, projectId, generation, project.phase),
    db.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) VALUES(?,CASE WHEN changes()=1 THEN 'connector_batch_recorded' ELSE NULL END,?,?)").bind(projectId, JSON.stringify({ batch_id: result.batchId, phase: result.phase, status: result.status, attempted: result.attempted, succeeded: result.succeeded, failed: result.failed, bytes: result.bytes, reason_code: result.reasonCode }), now),
    db.prepare("INSERT INTO migration_batch_receipts(project_id,batch_id,phase,status,cursor,attempted,succeeded,failed,bytes,reason_code,result_digest,generation,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(projectId, result.batchId, result.phase, result.status, result.cursor, result.attempted, result.succeeded, result.failed, String(result.bytes), result.reasonCode, resultDigest, generation, idempotencyKey, now),
  ];
  for (const receipt of result.receipts) statements.push(db.prepare("INSERT INTO migration_checkpoints(id,project_id,workload,source_object_id,target_object_id,source_version,content_digest,bytes_copied,status,attempt_count,last_error_code,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT(project_id,workload,source_object_id) DO UPDATE SET target_object_id=excluded.target_object_id,source_version=excluded.source_version,content_digest=excluded.content_digest,bytes_copied=excluded.bytes_copied,status=excluded.status,attempt_count=migration_checkpoints.attempt_count+1,last_error_code=excluded.last_error_code,updated_at=excluded.updated_at").bind(crypto.randomUUID(), projectId, receipt.workload, receipt.sourceObjectId, receipt.targetObjectId, receipt.sourceVersion, receipt.digest, receipt.bytesCopied, receipt.itemStatus, receipt.errorCode, now));
  try { await db.batch(statements); }
  catch (error) {
    if (String(error.message || error).includes("UNIQUE constraint failed")) {
      const raced = await db.prepare("SELECT result_digest,generation,idempotency_key FROM migration_batch_receipts WHERE project_id=? AND batch_id=?").bind(projectId, result.batchId).first();
      if (raced && raced.result_digest === resultDigest && Number(raced.generation) === generation && raced.idempotency_key === idempotencyKey) return { ...result, duplicate: true, result_digest: resultDigest };
      if (raced) throw new Error("duplicate connector batch id has changed content or execution context");
    }
    throw error;
  }
  return { ...result, result_digest: resultDigest };
}

async function startReadyMigrationProjects(env) {
  if (!env.DB || !env.MIGRATION_WORKFLOW || !env.MIGRATION_CONNECTOR) return { configured: false, reason: "workflow_or_private_connector_binding_missing", examined: 0, started: 0 };
  const candidates = await env.DB.prepare("SELECT id,workflow_generation FROM migration_projects WHERE payment_status='verified' AND status IN ('queued','needs_attention') AND (workflow_instance_id IS NULL OR workflow_instance_id='') ORDER BY updated_at LIMIT 25").all();
  const claimed = [];
  for (const row of candidates.results || []) {
    const state = await migrationReadiness(env.DB, row.id);
    if (!state.ready) continue;
    const generation = Number(row.workflow_generation || 0);
    const instanceId = `migration-${row.id}-g${generation}`;
    const result = await env.DB.prepare("UPDATE migration_projects SET workflow_instance_id=?,status='starting',phase=CASE WHEN phase='intake' THEN 'preflight' ELSE phase END,updated_at=? WHERE id=? AND workflow_generation=? AND payment_status='verified' AND status IN ('queued','needs_attention') AND (workflow_instance_id IS NULL OR workflow_instance_id='')").bind(instanceId, Date.now(), row.id, generation).run();
    if (Number(result?.meta?.changes ?? 0) === 1) claimed.push({ id: instanceId, params: { projectId: row.id, generation } });
  }
  if (!claimed.length) return { configured: true, examined: (candidates.results || []).length, started: 0 };
  try {
    await env.MIGRATION_WORKFLOW.createBatch(claimed);
    await env.DB.batch(claimed.map((entry) => env.DB.prepare("UPDATE migration_projects SET status='running',updated_at=? WHERE id=? AND workflow_generation=? AND workflow_instance_id=? AND status='starting'").bind(Date.now(), entry.params.projectId, entry.params.generation, entry.id)));
  } catch (error) {
    await env.DB.batch(claimed.map((entry) => env.DB.prepare("UPDATE migration_projects SET status='needs_attention',workflow_instance_id=NULL,workflow_generation=workflow_generation+1,updated_at=? WHERE id=? AND workflow_generation=? AND workflow_instance_id=? AND status='starting'").bind(Date.now(), entry.params.projectId, entry.params.generation, entry.id)));
    throw error;
  }
  return { configured: true, examined: (candidates.results || []).length, started: claimed.length };
}

async function startMigrationProject(env, projectId, accessToken) {
  if (!env.DB) throw new Error("marketplace database is not configured");
  const project = await authorizedMigration(env.DB, projectId, accessToken);
  if (!project) throw new Error("project not found or unauthorized");
  if (!env.MIGRATION_WORKFLOW || !env.MIGRATION_CONNECTOR) throw new Error("private workflow and connector bindings must pass operator preflight before a project can run");
  const readiness = await migrationReadiness(env.DB, projectId);
  if (!readiness.ready) throw new Error(`migration is not ready: ${readiness.reasons.join(",")}`);
  const generation = Number(project.workflow_generation || 0);
  const instanceId = `migration-${projectId}-g${generation}`;
  const claimed = await env.DB.prepare("UPDATE migration_projects SET workflow_instance_id=?,status='starting',phase=CASE WHEN phase='intake' THEN 'preflight' ELSE phase END,updated_at=? WHERE id=? AND workflow_generation=? AND payment_status='verified' AND status IN ('queued','needs_attention') AND (workflow_instance_id IS NULL OR workflow_instance_id='')").bind(instanceId, Date.now(), projectId, generation).run();
  if (Number(claimed?.meta?.changes ?? 0) !== 1) throw new Error("migration was already started or changed state");
  try {
    await env.MIGRATION_WORKFLOW.createBatch([{ id: instanceId, params: { projectId, generation } }]);
    const running = await env.DB.prepare("UPDATE migration_projects SET status='running',updated_at=? WHERE id=? AND workflow_generation=? AND workflow_instance_id=? AND status='starting'").bind(Date.now(), projectId, generation, instanceId).run();
    if (Number(running?.meta?.changes ?? 0) !== 1) throw new Error("migration workflow was created but its state transition could not be confirmed");
  } catch (error) {
    await env.DB.prepare("UPDATE migration_projects SET status='needs_attention',workflow_instance_id=NULL,workflow_generation=workflow_generation+1,updated_at=? WHERE id=? AND workflow_generation=? AND workflow_instance_id=?").bind(Date.now(), projectId, generation, instanceId).run();
    throw error;
  }
  return { project_id: projectId, workflow_instance_id: instanceId, status: "running", phase: "preflight" };
}

export { CONNECTION_STATUS, PHASES, PROVIDER_REQUIREMENTS, RESULT_PHASES, authorizeReadyMigrationPayments, canonicalConnectorResult, canonicalMappings, connectorRequirements, migrationPaymentReadiness, migrationReadiness, readSmallConnectorJson, recordConnectorResult, replaceMigrationMappings, startMigrationProject, startReadyMigrationProjects, upsertMigrationConnection, validateConnectionInput, validateConnectorResult, validateMappings, validatePendingMigrationConnections, validatePendingMigrationMappings, validatePhaseTransition };
