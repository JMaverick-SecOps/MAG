import test from "node:test";
import assert from "node:assert/strict";
import { connectorRequirements, validateConnectionInput, validateConnectorResult, validateMappings, validatePhaseTransition } from "../src/migration-engine.js";

const project = { source_provider: "m365", target_provider: "google_workspace", workloads: ["mail", "calendar", "onedrive"] };

test("provider contracts expose only scoped authorization requirements", () => {
  assert.equal(connectorRequirements("m365").authorization, "oauth2_admin_consent");
  assert.equal(connectorRequirements("imap").connector, "imap_tls_993");
  assert.equal(connectorRequirements("unknown"), null);
});

test("connection intake stores vault references and enforces IMAP TLS", () => {
  const source = validateConnectionInput(project, { side: "source", provider: "m365", vault_reference: "vault:tenant:source", tenant_hint: "example.onmicrosoft.com" });
  assert.equal(source.provider, "m365");
  const imapProject = { source_provider: "imap", target_provider: "m365" };
  assert.throws(() => validateConnectionInput(imapProject, { side: "source", provider: "imap", vault_reference: "vault:imap:source", imap_host: "mail.example.com", imap_port: 143 }), /TLS port 993/);
});

test("mapping validation rejects duplicate and out-of-scope sources", () => {
  const rows = validateMappings(project, { mappings: [{ workload: "mail", source_principal: "a@example.com", target_principal: "a@example.net" }] });
  assert.equal(rows.length, 1);
  assert.throws(() => validateMappings(project, { mappings: [{ workload: "dropbox", source_principal: "a", target_principal: "b" }] }), /outside project scope/);
  assert.throws(() => validateMappings(project, { mappings: [{ workload: "mail", source_principal: "a@example.com", target_principal: "a@example.net" }, { workload: "mail", source_principal: "a@example.com", target_principal: "b@example.net" }] }), /duplicates/);
});

test("connector receipts are bounded, consistent, and digest checked", () => {
  const value = validateConnectorResult({ status: "continue", phase: "initial_sync", batch_id: "batch:0001", cursor: "next", attempted: 2, succeeded: 1, failed: 1, bytes: 20, receipts: [{ workload: "mail", source_object_id: "message-1", target_object_id: "target-1", source_version: "v1", content_digest: `sha256:${"a".repeat(64)}`, status: "copied", bytes_copied: "20" }] });
  assert.equal(value.receipts.length, 1);
  assert.throws(() => validateConnectorResult({ status: "continue", phase: "initial_sync", batch_id: "batch:0001", attempted: 1, succeeded: 2, failed: 0, bytes: 0 }), /inconsistent/);
});

test("phase transitions cannot skip gates or cut over outside the approved window", () => {
  const now = Date.now();
  assert.equal(validatePhaseTransition("discovery", "mapping_validation", now, now - 1000, now + 1000), true);
  assert.throws(() => validatePhaseTransition("discovery", "initial_sync", now, now - 1000, now + 1000), /invalid/);
  assert.throws(() => validatePhaseTransition("delta_sync", "preauthorized_cutover", now, now + 10000, now + 20000), /outside/);
});
