import test from "node:test";
import assert from "node:assert/strict";
import { deviceEnrollmentPreimage, managedOpsManifest, normalizeEventData, scrubTelemetry, telemetryPreimage, validateTelemetryBatch, validateTenant } from "../src/managed-ops.js";

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
});

test("strict event schemas discard fields outside the selected telemetry contract",()=>{
  assert.deepEqual(normalizeEventData("heartbeat",{state:"healthy",agent_version:"1.2.3",uptime_seconds:30,raw_file:"forbidden"}),{state:"healthy",agent_version:"1.2.3",uptime_seconds:30});
});

test("device and telemetry signatures are domain separated",async()=>{
  assert.equal(deviceEnrollmentPreimage({tenantId:"t1",assetId:"d1",publicKey:"pk",signedAt:7}),"mag.device.enroll.v1:t1:d1:pk:7");
  const preimage=await telemetryPreimage({tenant_id:"t1",asset_id:"d1",sequence:2,observed_at:9,events:[]});
  assert.match(preimage,/^mag\.telemetry\.v1:t1:d1:2:9:[a-f0-9]{64}$/);
});

test("phase zero manifest forbids remote control and autonomous remediation",()=>{
  const manifest=managedOpsManifest();
  assert.equal(manifest.maturity,"phase_0_evidence_plane");
  assert.ok(manifest.deliberately_absent.includes("remote shell"));
  assert.ok(manifest.deliberately_absent.includes("automatic remediation"));
  assert.match(manifest.device_trust,/replay-protection/);
  assert.ok(manifest.capabilities.includes("customer white-label profile"));
});
