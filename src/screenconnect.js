import { authorizedTenant, normalizeEventData } from "./managed-ops.js";

const REST_EXTENSION_PATH = "/App_Extensions/2d558935-686a-4bd0-9991-07539f5fe749/Service.ashx";
const READ_ENDPOINT = "GetSessionsByFilter";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS_PER_POLL = 500;
const MAX_DUE_INTEGRATIONS = 10;
const RECORDS_PER_BATCH = 20;
const TRANSPORTS = new Set(["service_binding", "env_secret"]);
const INLINE_SECRET_KEY = /(?:^|_)(?:api_?key|authorization|cookie|password|secret|token)(?:$|_)/i;
const SERVICE_CREDENTIAL_REF = /^[a-z][a-z0-9-]{2,39}$/;
const ENV_CREDENTIAL_REF = /^SCREENCONNECT_READONLY_[A-Z0-9_]{3,48}$/;
const CANONICAL_TENANT_FILTER = /^SessionType\s*=\s*'Access'\s+AND\s+CustomProperty([1-8])\s*=\s*'([A-Za-z0-9][A-Za-z0-9 ._&()\/-]{0,99})'$/i;

class ScreenConnectError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ScreenConnectError";
    this.code = code;
  }
}

function clean(value, maximum) {
  return String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pick(source, names) {
  const object = objectValue(source);
  for (const name of names) {
    if (Object.hasOwn(object, name) && object[name] !== undefined && object[name] !== null) return object[name];
  }
  return undefined;
}

function normalizedHttpsOrigin(value, fieldName) {
  let parsed;
  try { parsed = new URL(clean(value, 500)); }
  catch { throw new ScreenConnectError("invalid_origin", `${fieldName} must be an HTTPS origin`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ScreenConnectError("invalid_origin", `${fieldName} must be an HTTPS origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

function allowedOrigins(env) {
  const entries = String(env?.SCREENCONNECT_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  const origins = new Set();
  for (const entry of entries) {
    try { origins.add(normalizedHttpsOrigin(entry, "SCREENCONNECT_ALLOWED_ORIGINS entry")); }
    catch { /* Invalid allowlist entries never widen access. */ }
  }
  return origins;
}

function validateSessionFilter(value) {
  const filter = clean(value, 500);
  const match = CANONICAL_TENANT_FILTER.exec(filter);
  if (!match) throw new ScreenConnectError("invalid_session_filter", "session_filter must exactly match SessionType = 'Access' AND CustomProperty1-8 = 'tenant literal'");
  return `SessionType = 'Access' AND CustomProperty${match[1]} = '${match[2]}'`;
}

// Only the operator can pin the tenant's origin, filter, and credential alias.
function assertTenantScope(tenantId, config, env) {
  let scopes;
  try { scopes = JSON.parse(String(env?.SCREENCONNECT_TENANT_SCOPES || "{}")); }
  catch { throw new ScreenConnectError("tenant_scope_unavailable", "operator-approved tenant scope required"); }
  const scope = Object.hasOwn(scopes || {}, tenantId) ? scopes[tenantId] : null;
  if (!scope || scope.instance_origin !== config.instanceOrigin
    || scope.transport !== config.transport || scope.credential_ref !== config.credentialRef
    || validateSessionFilter(scope.session_filter) !== config.sessionFilter) {
    throw new ScreenConnectError("tenant_scope_mismatch", "configuration does not match the operator-approved tenant scope");
  }
}

function assertNoInlineSecrets(input) {
  for (const key of Object.keys(objectValue(input))) {
    if (key !== "credential_ref" && INLINE_SECRET_KEY.test(key)) throw new ScreenConnectError("inline_secret_rejected", "credential values are not accepted; provide only credential_ref");
  }
}

function validateRuntimeBindings(config, env) {
  const requestOrigin = normalizedHttpsOrigin(env?.SCREENCONNECT_REQUEST_ORIGIN, "SCREENCONNECT_REQUEST_ORIGIN");
  if (config.transport === "service_binding") {
    if (!env?.SCREENCONNECT_READER || typeof env.SCREENCONNECT_READER.fetch !== "function") {
      throw new ScreenConnectError("service_binding_unavailable", "SCREENCONNECT_READER service binding is required");
    }
  } else {
    const secret = env?.[config.credentialRef];
    if (typeof secret !== "string" || secret.length < 24) throw new ScreenConnectError("secret_binding_unavailable", "referenced read-only secret is unavailable");
  }
  return requestOrigin;
}

function validateScreenConnectConfig(input, env) {
  const source = objectValue(input);
  assertNoInlineSecrets(source);
  const instanceOrigin = normalizedHttpsOrigin(source.instance_origin, "instance_origin");
  if (!allowedOrigins(env).has(instanceOrigin)) throw new ScreenConnectError("origin_not_allowlisted", "instance_origin is not in SCREENCONNECT_ALLOWED_ORIGINS");
  const transport = clean(source.transport || "service_binding", 32).toLowerCase();
  if (!TRANSPORTS.has(transport)) throw new ScreenConnectError("invalid_transport", "transport must be service_binding or env_secret");
  const credentialRef = clean(source.credential_ref, 64);
  if (transport === "service_binding" && !SERVICE_CREDENTIAL_REF.test(credentialRef)) {
    throw new ScreenConnectError("invalid_credential_ref", "service binding credential_ref must be a short opaque alias");
  }
  if (transport === "env_secret" && !ENV_CREDENTIAL_REF.test(credentialRef)) {
    throw new ScreenConnectError("invalid_credential_ref", "env secret credential_ref must name a SCREENCONNECT_READONLY_* binding");
  }
  const pollIntervalMinutes = Number(source.poll_interval_minutes ?? 15);
  if (!Number.isInteger(pollIntervalMinutes) || pollIntervalMinutes < 15 || pollIntervalMinutes > 1440) {
    throw new ScreenConnectError("invalid_poll_interval", "poll_interval_minutes must be between 15 and 1440");
  }
  const config = {
    instanceOrigin,
    sessionFilter: validateSessionFilter(source.session_filter),
    transport,
    credentialRef,
    pollIntervalMinutes,
    status: source.enabled === false || source.status === "paused" ? "paused" : "enabled",
  };
  config.requestOrigin = validateRuntimeBindings(config, env);
  return config;
}

function publicIntegration(row) {
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    status: row.status,
    transport: row.transport,
    instance_origin: row.instance_origin,
    session_filter: row.session_filter,
    credential_ref_configured: Boolean(row.credential_ref),
    poll_interval_minutes: Number(row.poll_interval_minutes),
    last_polled_at: row.last_polled_at ?? null,
    last_success_at: row.last_success_at ?? null,
    last_error_code: row.last_error_code ?? null,
    last_record_count: Number(row.last_record_count || 0),
    authority: { inventory_read: true, session_health_read: true, remote_control: false, commands: false, file_transfer: false },
  };
}

async function configureScreenConnectIntegration(db, tenantId, accessToken, input, env, now = Date.now()) {
  const tenant = await authorizedTenant(db, clean(tenantId, 80), accessToken);
  if (!tenant || tenant.status !== "active") throw new ScreenConnectError("tenant_authorization_required", "active tenant authorization required");
  const config = validateScreenConnectConfig(input, env);
  assertTenantScope(tenant.id, config, env);
  await db.prepare("INSERT INTO screenconnect_integrations(tenant_id,status,transport,instance_origin,session_filter,credential_ref,poll_interval_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET status=excluded.status,transport=excluded.transport,instance_origin=excluded.instance_origin,session_filter=excluded.session_filter,credential_ref=excluded.credential_ref,poll_interval_minutes=excluded.poll_interval_minutes,last_error_code=NULL,updated_at=excluded.updated_at")
    .bind(tenant.id, config.status, config.transport, config.instanceOrigin, config.sessionFilter, config.credentialRef, config.pollIntervalMinutes, now, now).run();
  await db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'screenconnect_configured',?,?)")
    .bind(tenant.id, JSON.stringify({ status: config.status, transport: config.transport, instance_origin: config.instanceOrigin, poll_interval_minutes: config.pollIntervalMinutes, authority: "read_only" }), now).run();
  return publicIntegration({ tenant_id: tenant.id, status: config.status, transport: config.transport, instance_origin: config.instanceOrigin, session_filter: config.sessionFilter, credential_ref: config.credentialRef, poll_interval_minutes: config.pollIntervalMinutes, last_record_count: 0 });
}

async function readScreenConnectIntegration(db, tenantId, accessToken) {
  const tenant = await authorizedTenant(db, clean(tenantId, 80), accessToken);
  if (!tenant) throw new ScreenConnectError("tenant_authorization_required", "tenant authorization required");
  const row = await db.prepare("SELECT tenant_id,status,transport,instance_origin,session_filter,credential_ref,poll_interval_minutes,last_polled_at,last_success_at,last_error_code,last_record_count,created_at,updated_at FROM screenconnect_integrations WHERE tenant_id=?").bind(tenant.id).first();
  return publicIntegration(row);
}

function rowAsInput(row) {
  return {
    instance_origin: row.instance_origin,
    session_filter: row.session_filter,
    transport: row.transport,
    credential_ref: row.credential_ref,
    poll_interval_minutes: Number(row.poll_interval_minutes),
    status: row.status,
    enabled: row.status === "enabled",
  };
}

function buildScreenConnectReadRequest(row, env) {
  const config = validateScreenConnectConfig(rowAsInput(row), env);
  if (config.status !== "enabled") throw new ScreenConnectError("integration_paused", "ScreenConnect integration is paused");
  const endpoint = `${config.instanceOrigin}${REST_EXTENSION_PATH}/${READ_ENDPOINT}`;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    origin: config.requestOrigin,
  });
  if (config.transport === "service_binding") headers.set("X-MAG-ScreenConnect-Credential-Ref", config.credentialRef);
  else headers.set("CTRLAuthHeader", env[config.credentialRef]);
  return {
    config,
    request: new Request(endpoint, { method: "POST", headers, body: JSON.stringify([config.sessionFilter]), redirect: "manual" }),
  };
}

async function readBoundedJson(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new ScreenConnectError("response_too_large", "ScreenConnect response exceeded the configured limit");
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) throw new ScreenConnectError("invalid_content_type", "ScreenConnect did not return JSON");
  if (!response.body) throw new ScreenConnectError("empty_response", "ScreenConnect returned an empty response");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel("response limit exceeded");
        throw new ScreenConnectError("response_too_large", "ScreenConnect response exceeded the configured limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ScreenConnectError("invalid_json", "ScreenConnect returned invalid JSON"); }
}

function sessionArray(payload) {
  let sessions = payload;
  if (!Array.isArray(sessions)) {
    const object = objectValue(payload);
    sessions = pick(object, ["Sessions", "sessions", "Results", "results"]);
  }
  if (!Array.isArray(sessions)) throw new ScreenConnectError("invalid_response_shape", "ScreenConnect response did not contain a session list");
  if (sessions.length > MAX_SESSIONS_PER_POLL) throw new ScreenConnectError("session_limit_exceeded", "ScreenConnect response exceeded 500 sessions; narrow the tenant filter");
  return sessions;
}

async function fetchScreenConnectSessions(row, env, fetcher = fetch) {
  const { config, request } = buildScreenConnectReadRequest(row, env);
  const response = config.transport === "service_binding"
    ? await env.SCREENCONNECT_READER.fetch(request)
    : await fetcher(request);
  if (!(response instanceof Response)) throw new ScreenConnectError("invalid_transport_response", "ScreenConnect transport returned no HTTP response");
  if (response.redirected || (response.status >= 300 && response.status < 400)) throw new ScreenConnectError("redirect_rejected", "ScreenConnect redirects are not followed");
  if (!response.ok) throw new ScreenConnectError(`upstream_http_${response.status}`, "ScreenConnect request failed");
  return sessionArray(await readBoundedJson(response));
}

async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function vendorTime(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  const text = clean(value, 80);
  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(text);
  if (dotNet) return Number(dotNet[1]);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function osFamily(osName) {
  if (/windows/i.test(osName)) return "windows";
  if (/mac|darwin|os x/i.test(osName)) return "macos";
  if (/linux|ubuntu|debian|fedora|centos|red hat/i.test(osName)) return "linux";
  return osName ? "other" : "unknown";
}

function connectionState(session) {
  const explicit = pick(session, ["IsGuestConnected", "GuestConnected", "isGuestConnected", "guestConnected"]);
  if (typeof explicit === "boolean") return explicit ? "online" : "offline";
  const count = Number(pick(session, ["GuestConnectedCount", "GuestConnectionCount", "guestConnectedCount", "guestConnectionCount"]));
  if (Number.isFinite(count)) return count > 0 ? "online" : "offline";
  const connections = pick(session, ["ActiveConnections", "Connections", "activeConnections", "connections"]);
  if (Array.isArray(connections)) return connections.some((entry) => /guest/i.test(clean(pick(entry, ["ProcessType", "ParticipantType", "processType", "participantType"]), 24))) ? "online" : "offline";
  return "unknown";
}

async function normalizeScreenConnectSession(raw, context, now = Date.now()) {
  const session = objectValue(raw);
  const rawSessionId = clean(pick(session, ["SessionID", "SessionId", "sessionID", "sessionId", "Id", "id"]), 200);
  if (rawSessionId.length < 4) throw new ScreenConnectError("invalid_session_record", "session record is missing its identifier");
  const rawType = clean(pick(session, ["SessionType", "sessionType"]), 24) || "Access";
  if (rawType.toLowerCase() !== "access") throw new ScreenConnectError("invalid_session_record", "non-Access session rejected");
  const guest = objectValue(pick(session, ["GuestInfo", "SessionGuestInfo", "guestInfo", "sessionGuestInfo"]));
  const machineName = clean(pick(guest, ["MachineName", "machineName"]) || pick(session, ["Name", "SessionName", "name", "sessionName"]) || "Managed endpoint", 120);
  const osName = clean(pick(guest, ["OperatingSystemName", "OSName", "operatingSystemName", "osName"]), 80);
  const osVersion = clean(pick(guest, ["OperatingSystemVersion", "OSVersion", "operatingSystemVersion", "osVersion"]), 80);
  const clientVersion = clean(pick(guest, ["ClientVersion", "ScreenConnectVersion", "clientVersion", "screenConnectVersion"]), 40);
  const processor = clean(pick(guest, ["ProcessorName", "ProcessorArchitecture", "processorName", "processorArchitecture"]), 120);
  const state = connectionState(session);
  const lastConnectedAt = vendorTime(pick(session, ["GuestLastConnectedTime", "LastGuestConnectedTime", "LastConnectedTime", "guestLastConnectedTime", "lastGuestConnectedTime", "lastConnectedTime"]));
  const externalIdHash = await sha256(`${context.tenant_id}\n${context.instance_origin}\n${rawSessionId}`);
  const assetId = `sc-${externalIdHash.slice(0, 40)}`;
  const evidence = {
    asset_id: assetId,
    external_id_hash: externalIdHash,
    machine_name: machineName,
    session_type: "Access",
    os_family: osFamily(osName),
    os_version: osVersion || osName,
    client_version: clientVersion,
    cpu_arch: /arm64|aarch64/i.test(processor) ? "arm64" : /x64|amd64|64-bit/i.test(processor) ? "x64" : /x86|32-bit/i.test(processor) ? "x86" : "",
    connection_state: state,
    last_connected_at: lastConnectedAt,
    observed_at: now,
  };
  evidence.evidence_digest = `sha256:${await sha256(JSON.stringify(evidence))}`;
  return evidence;
}

async function normalizeScreenConnectSessions(sessions, context, now = Date.now()) {
  const records = [];
  let skipped = 0;
  for (const session of sessions) {
    try { records.push(await normalizeScreenConnectSession(session, context, now)); }
    catch (error) {
      if (error instanceof ScreenConnectError && error.code === "invalid_session_record") skipped += 1;
      else throw error;
    }
  }
  const unique = new Map();
  for (const record of records) {
    if (unique.has(record.external_id_hash)) skipped += 1;
    unique.set(record.external_id_hash, record);
  }
  if (sessions.length && unique.size === 0) throw new ScreenConnectError("no_valid_session_records", "ScreenConnect returned no valid Access session records");
  return { records: [...unique.values()], skipped };
}

async function batchInChunks(db, statements) {
  const statementsPerChunk = RECORDS_PER_BATCH * 4;
  for (let index = 0; index < statements.length; index += statementsPerChunk) await db.batch(statements.slice(index, index + statementsPerChunk));
}

async function importScreenConnectTelemetry(db, row, normalized, now = Date.now()) {
  const tenantId = clean(row.tenant_id, 80);
  const capacity = await db.prepare("SELECT t.max_assets,COUNT(a.asset_id) asset_count FROM managed_tenants t LEFT JOIN managed_assets a ON a.tenant_id=t.id WHERE t.id=? AND t.status='active' GROUP BY t.id,t.max_assets").bind(tenantId).first();
  if (!capacity) throw new ScreenConnectError("tenant_inactive", "active managed tenant required");
  const existingResult = await db.prepare("SELECT external_id_hash FROM screenconnect_asset_evidence WHERE tenant_id=?").bind(tenantId).all();
  const existing = new Set((existingResult.results || []).map((entry) => entry.external_id_hash));
  let available = Math.max(0, Number(capacity.max_assets) - Number(capacity.asset_count || 0));
  const selected = [];
  let capacitySkipped = 0;
  for (const record of normalized.records) {
    if (existing.has(record.external_id_hash)) selected.push(record);
    else if (available > 0) { selected.push(record); available -= 1; }
    else capacitySkipped += 1;
  }
  const sequenceRow = await db.prepare("UPDATE screenconnect_integrations SET poll_sequence=poll_sequence+1,updated_at=? WHERE tenant_id=? AND status='enabled' RETURNING poll_sequence").bind(now, tenantId).first();
  if (!sequenceRow) throw new ScreenConnectError("integration_state_changed", "ScreenConnect integration is no longer enabled");
  const sequence = Number(sequenceRow.poll_sequence);
  const statements = [];
  for (const record of selected) {
    const inventory = normalizeEventData("inventory", { os_family: record.os_family, os_version: record.os_version, device_type: "screenconnect_access", cpu_arch: record.cpu_arch });
    const health = normalizeEventData("service_health", { service: "ConnectWise ScreenConnect", state: record.connection_state, message: record.client_version ? `Read-only session metadata; client ${record.client_version}` : "Read-only session metadata" });
    const lastSeenAt = record.connection_state === "online" ? now : Math.min(now, Math.max(0, Number(record.last_connected_at) || 0));
    statements.push(db.prepare("INSERT INTO screenconnect_asset_evidence(tenant_id,external_id_hash,asset_id,machine_name,session_type,os_family,os_version,client_version,connection_state,last_connected_at,observed_at,evidence_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,external_id_hash) DO UPDATE SET asset_id=excluded.asset_id,machine_name=excluded.machine_name,os_family=excluded.os_family,os_version=excluded.os_version,client_version=excluded.client_version,connection_state=excluded.connection_state,last_connected_at=excluded.last_connected_at,observed_at=excluded.observed_at,evidence_digest=excluded.evidence_digest,updated_at=excluded.updated_at")
      .bind(tenantId, record.external_id_hash, record.asset_id, record.machine_name, record.session_type, record.os_family, record.os_version, record.client_version, record.connection_state, record.last_connected_at, record.observed_at, record.evidence_digest, now, now));
    statements.push(db.prepare("INSERT INTO managed_assets(tenant_id,asset_id,last_seen_at,status,updated_at) VALUES(?,?,?,'observed',?) ON CONFLICT(tenant_id,asset_id) DO UPDATE SET last_seen_at=MAX(managed_assets.last_seen_at,excluded.last_seen_at),updated_at=excluded.updated_at")
      .bind(tenantId, record.asset_id, lastSeenAt, now));
    statements.push(db.prepare("INSERT INTO managed_telemetry(id,tenant_id,asset_id,sequence,kind,observed_at,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), tenantId, record.asset_id, sequence, "inventory", now, JSON.stringify(inventory), now));
    statements.push(db.prepare("INSERT INTO managed_telemetry(id,tenant_id,asset_id,sequence,kind,observed_at,data_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .bind(crypto.randomUUID(), tenantId, record.asset_id, sequence, "service_health", now, JSON.stringify(health), now));
  }
  await batchInChunks(db, statements);
  await db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'screenconnect_evidence_imported',?,?)")
    .bind(tenantId, JSON.stringify({ imported: selected.length, skipped: normalized.skipped + capacitySkipped, sequence, source: "screenconnect", authority: "read_only" }), now).run();
  return { imported: selected.length, skipped: normalized.skipped + capacitySkipped, sequence };
}

function errorCode(error) {
  const candidate = error instanceof ScreenConnectError ? error.code : "connector_error";
  return /^[a-z0-9_]{1,60}$/.test(candidate) ? candidate : "connector_error";
}

async function pollScreenConnectIntegration(db, row, env, now = Date.now(), fetcher = fetch) {
  const runId = crypto.randomUUID();
  await db.prepare("INSERT INTO screenconnect_poll_runs(id,tenant_id,started_at,status) VALUES(?,?,?,'running')").bind(runId, row.tenant_id, now).run();
  try {
    if (row.status !== "enabled") throw new ScreenConnectError("integration_paused", "integration is paused");
    assertTenantScope(row.tenant_id, validateScreenConnectConfig(rowAsInput(row), env), env);
    const sessions = await fetchScreenConnectSessions(row, env, fetcher);
    const normalized = await normalizeScreenConnectSessions(sessions, { tenant_id: row.tenant_id, instance_origin: row.instance_origin }, now);
    const imported = await importScreenConnectTelemetry(db, row, normalized, now);
    await db.batch([
      db.prepare("UPDATE screenconnect_integrations SET last_polled_at=?,last_success_at=?,last_error_code=NULL,last_record_count=?,updated_at=? WHERE tenant_id=?").bind(now, now, imported.imported, now, row.tenant_id),
      db.prepare("UPDATE screenconnect_poll_runs SET completed_at=?,status='succeeded',record_count=?,skipped_count=?,error_code=NULL WHERE id=? AND status='running'").bind(now, imported.imported, imported.skipped, runId),
    ]);
    return { tenant_id: row.tenant_id, status: "succeeded", records: imported.imported, skipped: imported.skipped, remote_action: false };
  } catch (error) {
    const code = errorCode(error);
    await db.batch([
      db.prepare("UPDATE screenconnect_integrations SET last_polled_at=?,last_error_code=?,updated_at=? WHERE tenant_id=?").bind(now, code, now, row.tenant_id),
      db.prepare("UPDATE screenconnect_poll_runs SET completed_at=?,status='failed',error_code=? WHERE id=? AND status='running'").bind(now, code, runId),
      db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'screenconnect_poll_failed',?,?)").bind(row.tenant_id, JSON.stringify({ error_code: code, source: "screenconnect", remote_action: false }), now),
    ]);
    return { tenant_id: row.tenant_id, status: "failed", error_code: code, remote_action: false };
  }
}

async function pollAuthorizedScreenConnectIntegration(db, tenantId, accessToken, env, now = Date.now(), fetcher = fetch) {
  const tenant = await authorizedTenant(db, clean(tenantId, 80), accessToken);
  if (!tenant || tenant.status !== "active") throw new ScreenConnectError("tenant_authorization_required", "active tenant authorization required");
  const row = await db.prepare("SELECT tenant_id,status,transport,instance_origin,session_filter,credential_ref,poll_interval_minutes,last_polled_at,last_success_at,last_error_code,last_record_count FROM screenconnect_integrations WHERE tenant_id=?").bind(tenant.id).first();
  if (!row) throw new ScreenConnectError("integration_not_found", "ScreenConnect integration not found");
  return pollScreenConnectIntegration(db, row, env, now, fetcher);
}

async function pollDueScreenConnectIntegrations(db, env, now = Date.now(), fetcher = fetch) {
  if (!db) return { action: "skipped", reason: "database_unavailable" };
  const due = await db.prepare("SELECT i.tenant_id,i.status,i.transport,i.instance_origin,i.session_filter,i.credential_ref,i.poll_interval_minutes,i.last_polled_at FROM screenconnect_integrations i JOIN managed_tenants t ON t.id=i.tenant_id WHERE i.status='enabled' AND t.status='active' AND (i.last_polled_at IS NULL OR i.last_polled_at + i.poll_interval_minutes * 60000 <= ?) ORDER BY COALESCE(i.last_polled_at,0),i.tenant_id LIMIT ?").bind(now, MAX_DUE_INTEGRATIONS).all();
  const results = [];
  for (const row of due.results || []) results.push(await pollScreenConnectIntegration(db, row, env, now, fetcher));
  return { action: results.length ? "polled" : "no_due_integrations", count: results.length, succeeded: results.filter((result) => result.status === "succeeded").length, failed: results.filter((result) => result.status === "failed").length, results };
}

function screenConnectManifest() {
  return {
    product: "MAG Managed Operations · ConnectWise ScreenConnect evidence connector",
    maturity: "read_only_integration_ready",
    vendor_api: "ConnectWise ScreenConnect RESTful API Manager 1.0.8+",
    endpoint_allowlist: [READ_ENDPOINT],
    capabilities: ["Access-session inventory metadata", "online/offline session health", "bounded scheduled polling", "pseudonymous asset linkage", "normalized managed-operations telemetry"],
    deliberately_absent: ["remote shell", "SendCommandToSession", "SendToolboxItemToSession", "unattended access launch", "file transfer", "screen capture", "chat", "credential persistence", "raw session payload persistence"],
    trust_boundary: "Prefer the private SCREENCONNECT_READER service binding. Direct mode accepts only a SCREENCONNECT_READONLY_* Worker secret reference; the credential value is never accepted by the API or stored in D1.",
    outbound_policy: "Each instance origin must exactly match SCREENCONNECT_ALLOWED_ORIGINS. Redirects are rejected and the vendor path/method are fixed in code.",
    tenant_scope: "Every filter must select SessionType = 'Access' and an exact CustomProperty tenant value.",
    polling: { minimum_minutes: 15, maximum_sessions: MAX_SESSIONS_PER_POLL, maximum_response_bytes: MAX_RESPONSE_BYTES, due_integrations_per_cron: MAX_DUE_INTEGRATIONS },
    api_ready: {
      configure: "PUT /api/managed-ops/tenants/:id/integrations/screenconnect",
      read: "GET /api/managed-ops/tenants/:id/integrations/screenconnect",
      poll_now: "POST /api/managed-ops/tenants/:id/integrations/screenconnect/poll",
    },
    scheduled_hook: "pollDueScreenConnectIntegrations(env.DB, env, Date.now())",
    documentation: [
      "https://docs.connectwise.com/ScreenConnect_Documentation/Developers/RESTful_API_Manager",
      "https://docs.connectwise.com/ScreenConnect_Documentation/Developers/ConnectWise_ScreenConnect_API_Security_Overview",
    ],
  };
}

function screenConnectPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ScreenConnect evidence connector · MAG</title>
<style>:root{--navy:#061a33;--panel:#0a2744;--line:#1e5774;--cyan:#11d8ed;--gold:#f6c653;--green:#7ce9ba;--ink:#eaf7ff;--muted:#9eb6c9}*{box-sizing:border-box}body{margin:0;background:var(--navy);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1050px;margin:auto;padding:42px 24px}a{color:var(--cyan)}.eyebrow{color:var(--cyan);font-weight:800;letter-spacing:.1em}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.pill{border:1px solid #876c2b;color:var(--gold);border-radius:999px;padding:7px 11px;white-space:nowrap}.boundary{margin:20px 0;padding:15px;border:1px solid #876c2b;border-left:4px solid var(--gold);border-radius:12px;background:#29271b}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:20px}.row{display:grid;grid-template-columns:180px 1fr;gap:12px;padding:11px 0;border-bottom:1px solid #19405d}.row:last-child{border:0}.label{color:var(--muted)}.ok{color:var(--green)}code{color:#ccefff}.flow{display:grid;gap:10px}.step{padding:12px;border:1px solid #1c4e6b;border-radius:10px}.absent{color:var(--muted)}@media(max-width:760px){.hero{display:block}.pill{display:inline-block;margin-top:12px}.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}}</style>
</head>
<body>
<main>
<a href="/ops">← Managed Operations</a>
<div class="hero">
<div>
<p class="eyebrow">CONNECTWISE SCREENCONNECT</p>
<h1>Read-only evidence connector</h1>
<p>Bring authorized Access-session inventory and connection health into a white-label MAG operations workspace.</p>
</div>
<span class="pill">Evidence plane · no control</span>
</div>
<div class="boundary">
<b>Hard boundary:</b> this connector cannot start a remote session, run a command, send a tool, move a file, capture a screen, or persist ScreenConnect credentials. It calls only <code>GetSessionsByFilter</code>.</div>
<div class="grid">
<section class="panel">
<h2>Integration status</h2>
<div class="row">
<span class="label">Transport</span>
<b>Private Worker service binding</b>
</div>
<div class="row">
<span class="label">Tenant scope</span>
<span>Access + exact custom property</span>
</div>
<div class="row">
<span class="label">Poll cadence</span>
<span>Every 15 minutes</span>
</div>
<div class="row">
<span class="label">Last result</span>
<span class="ok">Ready for authorized configuration</span>
</div>
<div class="row">
<span class="label">Stored evidence</span>
<span>Machine label, OS, client version, state, timestamps, digests</span>
</div>
</section>
<section class="panel">
<h2>Setup contract</h2>
<div class="flow">
<div class="step">
<b>1 · Allowlist</b>
<br>
<span class="absent">Pin the exact HTTPS ScreenConnect origin.</span>
</div>
<div class="step">
<b>2 · Private credential reference</b>
<br>
<span class="absent">The gateway owns the read-only token; D1 stores only its alias.</span>
</div>
<div class="step">
<b>3 · Tenant filter</b>
<br>
<span class="absent">Require SessionType = 'Access' plus an exact CustomProperty.</span>
</div>
<div class="step">
<b>4 · Verify evidence</b>
<br>
<span class="absent">Review inventory and freshness without granting remote authority.</span>
</div>
</div>
</section>
</div>
<p class="absent">Interface copy is illustrative until a tenant completes authorization and connector verification. ConnectWise and ScreenConnect are trademarks of their respective owner; no affiliation or endorsement is implied.</p>
</main>
</body>
</html>`;
}

export {
  MAX_RESPONSE_BYTES,
  MAX_SESSIONS_PER_POLL,
  READ_ENDPOINT,
  REST_EXTENSION_PATH,
  ScreenConnectError,
  buildScreenConnectReadRequest,
  configureScreenConnectIntegration,
  fetchScreenConnectSessions,
  importScreenConnectTelemetry,
  normalizeScreenConnectSession,
  normalizeScreenConnectSessions,
  pollAuthorizedScreenConnectIntegration,
  pollDueScreenConnectIntegrations,
  pollScreenConnectIntegration,
  readBoundedJson,
  readScreenConnectIntegration,
  screenConnectManifest,
  screenConnectPage,
  validateScreenConnectConfig,
  validateSessionFilter,
  assertTenantScope,
};
