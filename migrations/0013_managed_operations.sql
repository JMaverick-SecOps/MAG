CREATE TABLE IF NOT EXISTS managed_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  max_assets INTEGER NOT NULL,
  authorized_domains_json TEXT NOT NULL,
  authorization_attested INTEGER NOT NULL,
  data_processing_consent INTEGER NOT NULL,
  access_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','active','suspended','closed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_assets (
  tenant_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'observed',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, asset_id),
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS managed_devices (
  tenant_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','suspended')),
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, asset_id),
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS managed_telemetry (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS managed_tickets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  asset_id TEXT,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS managed_remediation_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  runbook TEXT NOT NULL,
  rollback TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','denied','expired')),
  execution_status TEXT NOT NULL DEFAULT 'not_implemented' CHECK (execution_status = 'not_implemented'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id),
  FOREIGN KEY (ticket_id) REFERENCES managed_tickets(id)
);

CREATE TABLE IF NOT EXISTS managed_ops_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS managed_branding (
  tenant_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  logo_url TEXT,
  primary_color TEXT NOT NULL DEFAULT '#061a33',
  accent_color TEXT NOT NULL DEFAULT '#11d8ed',
  support_email TEXT,
  custom_domain TEXT,
  domain_status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (domain_status IN ('unconfigured','pending_verification','active','disabled')),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE INDEX IF NOT EXISTS managed_telemetry_tenant_asset_time ON managed_telemetry(tenant_id,asset_id,observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS managed_telemetry_device_sequence_kind ON managed_telemetry(tenant_id,asset_id,sequence,kind);
CREATE INDEX IF NOT EXISTS managed_tickets_tenant_status ON managed_tickets(tenant_id,status,created_at DESC);
