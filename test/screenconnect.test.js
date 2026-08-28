import test from "node:test";
import assert from "node:assert/strict";
import {
  READ_ENDPOINT,
  REST_EXTENSION_PATH,
  buildScreenConnectReadRequest,
  configureScreenConnectIntegration,
  fetchScreenConnectSessions,
  importScreenConnectTelemetry,
  normalizeScreenConnectSession,
  normalizeScreenConnectSessions,
  pollScreenConnectIntegration,
  readBoundedJson,
  screenConnectManifest,
  screenConnectPage,
  validateScreenConnectConfig,
  validateSessionFilter,
  assertTenantScope,
} from "../src/screenconnect.js";

const ORIGIN = "https://control.example.com";
const REQUEST_ORIGIN = "https://mavverick-scout.magai.workers.dev";
const FILTER = "SessionType = 'Access' AND CustomProperty1 = 'Example LLC'";

function serviceEnv(fetch = async () => new Response("[]", { headers: { "content-type": "application/json" } })) {
  return {
    SCREENCONNECT_ALLOWED_ORIGINS: ORIGIN,
    SCREENCONNECT_REQUEST_ORIGIN: REQUEST_ORIGIN,
    SCREENCONNECT_READER: { fetch },
    SCREENCONNECT_TENANT_SCOPES: JSON.stringify({ "tenant-1": { instance_origin: ORIGIN, session_filter: FILTER, transport: "service_binding", credential_ref: "example-tenant" } }),
  };
}

function serviceInput(overrides = {}) {
  return {
    instance_origin: ORIGIN,
    session_filter: FILTER,
    transport: "service_binding",
    credential_ref: "example-tenant",
    poll_interval_minutes: 15,
    ...overrides,
  };
}

function integrationRow(overrides = {}) {
  return {
    tenant_id: "tenant-1",
    status: "enabled",
    instance_origin: ORIGIN,
    session_filter: FILTER,
    transport: "service_binding",
    credential_ref: "example-tenant",
    poll_interval_minutes: 15,
    ...overrides,
  };
}

test("ScreenConnect configuration requires an exact allowlisted origin and tenant-scoped Access filter", () => {
  const config = validateScreenConnectConfig(serviceInput(), serviceEnv());
  assert.equal(config.instanceOrigin, ORIGIN);
  assert.equal(config.sessionFilter, FILTER);
  assert.equal(config.transport, "service_binding");
  assert.throws(() => validateScreenConnectConfig(serviceInput({ instance_origin: "https://other.example.com" }), serviceEnv()), /SCREENCONNECT_ALLOWED_ORIGINS/);
  assert.throws(() => validateSessionFilter("SessionType = 'Access'"), /exactly match/);
  assert.throws(() => validateSessionFilter("SessionType = 'Support' AND CustomProperty1 = 'Example LLC'"), /exactly match/);
  assert.throws(() => validateSessionFilter("SessionType = 'Access'; SendCommandToSession"), /exactly match/);
  assert.throws(() => validateSessionFilter("SessionType = 'Access' OR 1=1 AND CustomProperty1 = 'Example LLC'"), /exactly match/);
  assert.throws(() => validateSessionFilter("SessionType = 'Access' AND CustomProperty1 = 'Example LLC' OR CustomProperty2 = 'Other'"), /exactly match/);
  assert.throws(() => validateSessionFilter("SessionType = 'Access' AND CustomProperty1 = 'Example LLC' -- comment"), /exactly match/);
  assert.throws(() => validateSessionFilter("SessionType = 'Access' AND CustomProperty9 = 'Example LLC'"), /exactly match/);
  assert.equal(validateSessionFilter("sessiontype='access' and customproperty2='Example-Client (West)'"), "SessionType = 'Access' AND CustomProperty2 = 'Example-Client (West)'");
});

test("configuration accepts credential references but rejects inline secrets", () => {
  assert.throws(() => validateScreenConnectConfig(serviceInput({ api_token: "do-not-store" }), serviceEnv()), /credential values are not accepted/);
  assert.throws(() => validateScreenConnectConfig(serviceInput({ credential_ref: "97a0fe77-dc4a-4f37-a4da-cc12666" }), serviceEnv()), /short opaque alias/);
  const env = {
    SCREENCONNECT_ALLOWED_ORIGINS: ORIGIN,
    SCREENCONNECT_REQUEST_ORIGIN: REQUEST_ORIGIN,
    SCREENCONNECT_READONLY_EXAMPLE: "a-long-random-read-only-auth-value",
  };
  const direct = validateScreenConnectConfig(serviceInput({ transport: "env_secret", credential_ref: "SCREENCONNECT_READONLY_EXAMPLE" }), env);
  assert.equal(direct.credentialRef, "SCREENCONNECT_READONLY_EXAMPLE");
  assert.throws(() => validateScreenConnectConfig(serviceInput({ transport: "env_secret", credential_ref: "GENERAL_API_TOKEN" }), env), /SCREENCONNECT_READONLY/);
});

test("tenant filters and credentials are pinned by the operator, not customers", () => {
  const env = serviceEnv();
  const config = validateScreenConnectConfig(serviceInput(), env);
  assert.doesNotThrow(() => assertTenantScope("tenant-1", config, env));
  assert.throws(() => assertTenantScope("tenant-2", config, env), /operator-approved/);
  assert.throws(() => assertTenantScope("tenant-1", { ...config, sessionFilter: "SessionType = 'Access' AND CustomProperty1 = 'Other LLC'" }, env), /operator-approved/);
  assert.throws(() => assertTenantScope("tenant-1", { ...config, credentialRef: "other-tenant" }, env), /operator-approved/);
});

test("request construction fixes the vendor path and exposes no control endpoint", async () => {
  const { request } = buildScreenConnectReadRequest(integrationRow(), serviceEnv());
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).origin, ORIGIN);
  assert.equal(new URL(request.url).pathname, `${REST_EXTENSION_PATH}/${READ_ENDPOINT}`);
  assert.deepEqual(await request.json(), [FILTER]);
  assert.equal(request.headers.get("origin"), REQUEST_ORIGIN);
  assert.equal(request.headers.get("x-mag-screenconnect-credential-ref"), "example-tenant");
  assert.equal(request.headers.get("ctrlauthheader"), null);
  assert.doesNotMatch(request.url, /SendCommand|SendToolbox|CreateSession|UpdateSession/i);
});

test("private service binding is used for reads and response parsing is bounded", async () => {
  let captured;
  let publicFetchCalled = false;
  const sessions = [{ SessionID: "11111111-1111-1111-1111-111111111111", SessionType: "Access" }];
  const env = serviceEnv(async (request) => {
    captured = request;
    return new Response(JSON.stringify(sessions), { headers: { "content-type": "application/json", "content-length": "78" } });
  });
  const result = await fetchScreenConnectSessions(integrationRow(), env, async () => { publicFetchCalled = true; throw new Error("must not use public fetch"); });
  assert.equal(result.length, 1);
  assert.equal(publicFetchCalled, false);
  assert.equal(captured.headers.get("ctrlauthheader"), null);
  await assert.rejects(() => readBoundedJson(new Response("{\"large\":true}", { headers: { "content-type": "application/json", "content-length": "999" } }), 32), /exceeded/);
  await assert.rejects(() => readBoundedJson(new Response("<html>login</html>", { headers: { "content-type": "text/html" } })), /did not return JSON/);
});

test("normalization pseudonymizes session IDs and drops usernames, IPs, screenshots, and raw payloads", async () => {
  const rawId = "25950dd7-0230-4a72-9409-0b8c489684a2";
  const record = await normalizeScreenConnectSession({
    SessionID: rawId,
    SessionType: "Access",
    Name: "Fallback Host",
    IsGuestConnected: true,
    GuestLastConnectedTime: "/Date(2000000000000)/",
    GuestInfo: {
      MachineName: "EXAMPLE-LT-01",
      OperatingSystemName: "Microsoft Windows 11 Pro",
      OperatingSystemVersion: "10.0.26100",
      ClientVersion: "25.4.1.0",
      ProcessorName: "AMD64 processor",
      LoggedOnUserName: "private-user",
      NetworkAddress: "10.10.10.10",
      Screenshot: "base64-private-screen",
    },
    AuthorizationCookie: "private-cookie",
  }, { tenant_id: "tenant-1", instance_origin: ORIGIN }, 2_000_000_000_100);
  assert.match(record.asset_id, /^sc-[a-f0-9]{40}$/);
  assert.match(record.external_id_hash, /^[a-f0-9]{64}$/);
  assert.equal(record.connection_state, "online");
  assert.equal(record.os_family, "windows");
  assert.equal(record.cpu_arch, "x64");
  assert.equal(record.last_connected_at, 2_000_000_000_000);
  assert.match(record.evidence_digest, /^sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, new RegExp(rawId));
  assert.doesNotMatch(serialized, /private-user|10\.10\.10\.10|base64-private-screen|private-cookie/);
});

test("normalization rejects non-Access records and deduplicates stable pseudonyms", async () => {
  const sessions = [
    { SessionID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", SessionType: "Access" },
    { SessionID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", SessionType: "Access" },
    { SessionID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", SessionType: "Support" },
  ];
  const normalized = await normalizeScreenConnectSessions(sessions, { tenant_id: "tenant-1", instance_origin: ORIGIN }, 1000);
  assert.equal(normalized.records.length, 1);
  assert.equal(normalized.skipped, 2);
});

async function hash(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function configurationDatabase(accessTokenHash) {
  const state = { statements: [] };
  const tenant = { id: "tenant-1", name: "Example", contact_email: "owner@example.com", plan_id: "managed-visibility", max_assets: 25, authorized_domains_json: '["example.com"]', status: "active", access_token_hash: accessTokenHash, created_at: 1, updated_at: 1 };
  return {
    state,
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return sql.includes("FROM managed_tenants WHERE id=?") ? { ...tenant } : null; },
        async run() { state.statements.push({ sql, values: this.values }); return { success: true }; },
      };
    },
  };
}

test("tenant configuration stores only a credential alias, never the bound secret value", async () => {
  const accessToken = "tenant-access-token";
  const db = configurationDatabase(await hash(accessToken));
  const env = serviceEnv();
  env.SCREENCONNECT_READER_PRIVATE_VALUE = "must-never-enter-d1";
  const integration = await configureScreenConnectIntegration(db, "tenant-1", accessToken, serviceInput(), env, 1234);
  assert.equal(integration.credential_ref_configured, true);
  assert.equal(Object.hasOwn(integration, "credential_ref"), false);
  const persisted = JSON.stringify(db.state.statements);
  assert.match(persisted, /example-tenant/);
  assert.doesNotMatch(persisted, /must-never-enter-d1/);
});

function importDatabase() {
  const state = { batches: [], runs: [] };
  return {
    state,
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.startsWith("SELECT t.max_assets")) return { max_assets: 10, asset_count: 0 };
          if (sql.startsWith("UPDATE screenconnect_integrations SET poll_sequence")) return { poll_sequence: 7 };
          return null;
        },
        async all() { return { results: [] }; },
        async run() { state.runs.push({ sql, values: this.values }); return { success: true }; },
      };
    },
    async batch(statements) { state.batches.push(...statements.map((statement) => ({ sql: statement.sql, values: statement.values }))); return statements.map(() => ({ success: true })); },
  };
}

test("telemetry import emits only normalized inventory and service health", async () => {
  const db = importDatabase();
  const record = await normalizeScreenConnectSession({
    SessionID: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    SessionType: "Access",
    IsGuestConnected: false,
    GuestInfo: { MachineName: "EXAMPLE-LT-02", OperatingSystemName: "Ubuntu Linux", ClientVersion: "25.4" },
  }, { tenant_id: "tenant-1", instance_origin: ORIGIN }, 5000);
  const result = await importScreenConnectTelemetry(db, integrationRow(), { records: [record], skipped: 0 }, 5000);
  assert.deepEqual(result, { imported: 1, skipped: 0, sequence: 7 });
  const telemetry = db.state.batches.filter((statement) => statement.sql.startsWith("INSERT INTO managed_telemetry"));
  assert.deepEqual(telemetry.map((statement) => statement.values[4]), ["inventory", "service_health"]);
  assert.deepEqual(JSON.parse(telemetry[0].values[6]), { os_family: "linux", os_version: "Ubuntu Linux", device_type: "screenconnect_access", cpu_arch: "", memory_mb: null, disk_total_gb: null });
  assert.deepEqual(JSON.parse(telemetry[1].values[6]), { service: "ConnectWise ScreenConnect", state: "offline", message: "Read-only session metadata; client 25.4" });
  assert.doesNotMatch(JSON.stringify(telemetry), /cccccccc-cccc-cccc-cccc-cccccccccccc/);
});

function failedPollDatabase() {
  const state = { batches: [], runs: [] };
  return {
    state,
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) { this.values = values; return this; },
        async run() { state.runs.push({ sql, values: this.values }); return { success: true }; },
      };
    },
    async batch(statements) { state.batches.push(...statements.map((statement) => ({ sql: statement.sql, values: statement.values }))); return statements.map(() => ({ success: true })); },
  };
}

test("poll failures persist only a categorical code and never an upstream body", async () => {
  const db = failedPollDatabase();
  const env = serviceEnv(async () => new Response("secret diagnostic payload", { status: 401, headers: { "content-type": "text/plain" } }));
  const result = await pollScreenConnectIntegration(db, integrationRow(), env, 9000);
  assert.deepEqual(result, { tenant_id: "tenant-1", status: "failed", error_code: "upstream_http_401", remote_action: false });
  const persisted = JSON.stringify(db.state);
  assert.match(persisted, /upstream_http_401/);
  assert.doesNotMatch(persisted, /secret diagnostic payload/);
});

test("manifest and integration page make the read-only authority boundary explicit", () => {
  const manifest = screenConnectManifest();
  assert.deepEqual(manifest.endpoint_allowlist, ["GetSessionsByFilter"]);
  assert.ok(manifest.deliberately_absent.includes("remote shell"));
  assert.ok(manifest.deliberately_absent.includes("SendCommandToSession"));
  assert.match(manifest.trust_boundary, /never accepted by the API or stored in D1/);
  const html = screenConnectPage();
  assert.match(html, /Read-only evidence connector/);
  assert.match(html, /cannot start a remote session, run a command/);
  assert.match(html, /GetSessionsByFilter/);
  assert.match(html, /no affiliation or endorsement is implied/);
  assert.doesNotMatch(html, />\s*(?:Connect|Control|Run command|Execute)\s*</i);
});
