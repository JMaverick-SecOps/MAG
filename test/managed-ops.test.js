import test from "node:test";
import assert from "node:assert/strict";
import { aggregateTenantDashboard, createTenantBranding, deviceEnrollmentPreimage, managedOpsManifest, managedOpsPage, normalizeEventData, readTenantBranding, scrubTelemetry, telemetryPreimage, updateTenantBranding, validateTelemetryBatch, validateTenant, validateTenantBranding } from "../src/managed-ops.js";

test("managed operations requires explicit authorization and consent",()=>{
  const base={name:"Example MSP",contact_email:"ops@example.com",plan_id:"managed-visibility",max_assets:10,authorized_domains:["example.com"],authorization_attested:true,data_processing_consent:true};
  assert.equal(validateTenant(base).plan.id,"managed-visibility");
  assert.throws(()=>validateTenant({...base,authorization_attested:false}),/authorization/);
});

test("telemetry intake redacts credential-shaped fields",()=>{
  assert.deepEqual(scrubTelemetry({os:"Windows",api_token:"do-not-store",nested:{password:"nope",state:"healthy"}}),{os:"Windows",api_token:"[redacted]",nested:{password:"[redacted]",state:"healthy"}});
});

test("telemetry batches are bounded and timestamp checked",()=>{
  const now=Date.now();
  const rows=validateTelemetryBatch({events:[{kind:"heartbeat",observed_at:now,data:{state:"healthy",ignored_secret:"no"}}]},now);
  assert.equal(rows.length,1);
  assert.throws(()=>validateTelemetryBatch({events:[]},now),/1-50/);
  assert.throws(()=>validateTelemetryBatch({events:[{kind:"remote_shell",observed_at:now,data:{}}]},now),/allowed kind/);
  assert.throws(()=>validateTelemetryBatch({events:[{kind:"heartbeat",observed_at:now,data:{}},{kind:"heartbeat",observed_at:now,data:{}}]},now),/only once/);
});

test("strict event schemas discard fields outside the selected telemetry contract",()=>{
  assert.deepEqual(normalizeEventData("heartbeat",{state:"healthy",agent_version:"1.2.3",uptime_seconds:30,raw_file:"forbidden"}),{state:"healthy",agent_version:"1.2.3",uptime_seconds:30});
});

test("device and telemetry signatures are domain separated",async()=>{
  assert.equal(deviceEnrollmentPreimage({tenantId:"t1",assetId:"d1",publicKey:"pk",signedAt:7}),"mag.device.enroll.v1:t1:d1:pk:7");
  const preimage=await telemetryPreimage({tenant_id:"t1",asset_id:"d1",sequence:2,observed_at:9,events:[]});
  assert.match(preimage,/^mag\.telemetry\.v1:t1:d1:2:9:[a-f0-9]{64}$/);
});

test("subscription manifest still forbids remote shell and autonomous remediation",()=>{
  const manifest=managedOpsManifest();
  assert.equal(manifest.maturity,"subscription_workspace_and_signed_monitoring");
  assert.match(manifest.authority,/PSA-only subscriptions do not grant monitoring/);
  assert.ok(manifest.deliberately_absent.includes("remote shell"));
  assert.ok(manifest.deliberately_absent.includes("automatic remediation"));
  assert.match(manifest.device_trust,/replay-protection/);
  assert.ok(manifest.capabilities.includes("customer white-label profile"));
});

test("tenant branding is constrained to authorized domains and accessible colors", () => {
  const branding = validateTenantBranding({
    display_name: "Example Operations",
    logo_url: "https://assets.example.com/logo.svg",
    primary_color: "#102A43",
    accent_color: "#11D8ED",
    support_email: "SUPPORT@example.com",
    custom_domain: "ops.example.com",
  }, ["example.com"]);
  assert.deepEqual(branding, {
    displayName: "Example Operations",
    logoUrl: "https://assets.example.com/logo.svg",
    primaryColor: "#102a43",
    accentColor: "#11d8ed",
    supportEmail: "support@example.com",
    customDomain: "ops.example.com",
  });
  assert.throws(() => validateTenantBranding({ display_name: "Example", logo_url: "https://tracker.invalid/logo.svg" }, ["example.com"]), /authorized tenant domain/);
  assert.throws(() => validateTenantBranding({ display_name: "Example", logo_url: "https://assets.example.com/logo.svg?secret=1" }, ["example.com"]), /without credentials/);
  assert.throws(() => validateTenantBranding({ display_name: "Example", custom_domain: "ops.invalid" }, ["example.com"]), /custom_domain/);
  assert.throws(() => validateTenantBranding({ display_name: "Example", primary_color: "#112233", accent_color: "#112233" }, ["example.com"]), /distinct/);
});

async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function brandingDatabase(accessTokenHash) {
  const state = { branding: null, events: [] };
  const tenant = { id: "tenant-1", name: "Example LLC", contact_email: "owner@example.com", plan_id: "managed-visibility", max_assets: 25, authorized_domains_json: '["example.com"]', status: "active", access_token_hash: accessTokenHash, created_at: 1, updated_at: 1 };
  return {
    state,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (sql.includes("FROM managed_tenants WHERE id=?")) return { ...tenant };
          if (sql.startsWith("SELECT tenant_id,display_name")) return state.branding ? { ...state.branding } : null;
          if (sql.startsWith("INSERT INTO managed_branding")) {
            if (state.branding) return null;
            const [tenant_id, display_name, logo_url, primary_color, accent_color, support_email, custom_domain, domain_status, updated_at] = this.values;
            state.branding = { tenant_id, display_name, logo_url, primary_color, accent_color, support_email, custom_domain, domain_status, updated_at };
            return { tenant_id };
          }
          return null;
        },
        async run() {
          if (sql.startsWith("UPDATE managed_branding")) {
            const [display_name, logo_url, primary_color, accent_color, support_email, custom_domain, domain_status, updated_at, tenant_id] = this.values;
            state.branding = { tenant_id, display_name, logo_url, primary_color, accent_color, support_email, custom_domain, domain_status, updated_at };
          }
          if (sql.startsWith("INSERT INTO managed_ops_events")) state.events.push({ tenant_id: this.values[0], details: JSON.parse(this.values[1]), created_at: this.values[2] });
          return { success: true };
        },
      };
      return statement;
    },
  };
}

test("tenant branding create, update, and read are access-token scoped", async () => {
  const token = "owner-access-token";
  const db = brandingDatabase(await hash(token));
  const created = await createTenantBranding(db, "tenant-1", token, { display_name: "Example Ops", logo_url: "https://assets.example.com/logo.svg", custom_domain: "ops.example.com" }, 100);
  assert.equal(created.domain_status, "pending_verification");
  assert.equal((await readTenantBranding(db, "tenant-1", token)).display_name, "Example Ops");
  const updated = await updateTenantBranding(db, "tenant-1", token, { accent_color: "#f6c653", custom_domain: "" }, 200);
  assert.equal(updated.accent_color, "#f6c653");
  assert.equal(updated.domain_status, "unconfigured");
  assert.equal(db.state.events.length, 2);
  await assert.rejects(() => readTenantBranding(db, "tenant-1", "wrong-token"), /authorization/);
});

test("tenant dashboard aggregates current evidence without enabling control", () => {
  const now = 2_000_000_000_000;
  const dashboard = aggregateTenantDashboard({
    tenant: { id: "tenant-1", name: "Example LLC", plan_id: "managed-security", status: "active", max_assets: 5 },
    branding: { display_name: "Example Ops" },
    assets: [
      { asset_id: "a1", last_seen_at: now - 60_000 },
      { asset_id: "a2", last_seen_at: now - 600_000 },
      { asset_id: "a3", last_seen_at: now - 3_600_000 },
    ],
    tickets: [
      { id: "t1", severity: "high", status: "open" },
      { id: "t2", severity: "critical", status: "resolved" },
      { id: "t3", severity: "medium", status: "triage" },
    ],
    posture: [
      { asset_id: "a1", kind: "patch_status", observed_at: now - 60_000, data_json: '{"missing_critical":0,"missing_other":0}' },
      { asset_id: "a2", kind: "patch_status", observed_at: now - 60_000, data_json: '{"missing_critical":2,"missing_other":1}' },
      { asset_id: "a1", kind: "backup_status", observed_at: now - 60_000, data_json: '{"state":"healthy","protected_bytes":1000}' },
      { asset_id: "a2", kind: "backup_status", observed_at: now - 60_000, data_json: '{"state":"failed","protected_bytes":500}' },
    ],
    security: [
      { asset_id: "a1", observed_at: now - 60_000, data_json: '{"severity":"critical"}' },
      { asset_id: "a2", observed_at: now - 60_000, data_json: '{"severity":"high"}' },
      { asset_id: "a2", observed_at: now - 60_000, data_json: '{"severity":"unexpected"}' },
    ],
    pendingApprovals: 2,
  }, now);
  assert.deepEqual(dashboard.assets, { total: 3, reporting: 2, stale: 1, capacity_remaining: 2, reporting_percent: 66.7 });
  assert.equal(dashboard.tickets.open, 2);
  assert.equal(dashboard.tickets.by_severity.high, 1);
  assert.equal(dashboard.patch.compliance_percent, 50);
  assert.equal(dashboard.patch.missing_critical, 2);
  assert.equal(dashboard.backup.healthy_percent, 50);
  assert.equal(dashboard.security.recent_findings_30d, 3);
  assert.equal(dashboard.security.affected_assets, 2);
  assert.equal(dashboard.security.by_severity.informational, 1);
  assert.deepEqual(dashboard.authority, { remote_execution: false, arbitrary_commands: false, automatic_remediation: false, autonomous_spending: false });
});

test("white-label operations preview visibly covers RMM and PSA evidence", () => {
  const html = managedOpsPage();
  assert.match(html, /Northstar IT/);
  assert.match(html, /Powered by MAG Managed Operations/);
  assert.match(html, /WHITE-LABEL PREVIEW · SAMPLE EVIDENCE/);
  assert.match(html, /Fleet KPIs/);
  assert.match(html, /Tickets &amp; SLA/);
  assert.match(html, /Patch &amp; backup posture/);
  assert.match(html, /Approval queue/);
  assert.match(html, /Security findings/);
  assert.match(html, /No remote shell, arbitrary command execution, or automatic remediation/);
  assert.match(html, /Security evidence is not represented as EDR, MDR, incident response/);
  assert.match(html, /illustrative and do not represent a live customer environment/);
  assert.doesNotMatch(html, />\s*(?:Run|Execute) command\s*</i);
});
