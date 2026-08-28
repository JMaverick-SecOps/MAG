-- Read-only ConnectWise ScreenConnect evidence connector.
-- Credential values, authorization cookies, raw session IDs, screenshots, and
-- arbitrary vendor payloads are deliberately absent from this schema.

CREATE TABLE IF NOT EXISTS screenconnect_integrations (
  tenant_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('enabled','paused')),
  transport TEXT NOT NULL CHECK (transport IN ('service_binding','env_secret')),
  instance_origin TEXT NOT NULL,
  session_filter TEXT NOT NULL,
  credential_ref TEXT NOT NULL,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 15 CHECK (poll_interval_minutes BETWEEN 15 AND 1440),
  poll_sequence INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER,
  last_success_at INTEGER,
  last_error_code TEXT,
  last_record_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS screenconnect_asset_evidence (
  tenant_id TEXT NOT NULL,
  external_id_hash TEXT NOT NULL CHECK (length(external_id_hash) = 64),
  asset_id TEXT NOT NULL,
  machine_name TEXT NOT NULL,
  session_type TEXT NOT NULL CHECK (session_type = 'Access'),
  os_family TEXT NOT NULL,
  os_version TEXT NOT NULL,
  client_version TEXT NOT NULL,
  connection_state TEXT NOT NULL CHECK (connection_state IN ('online','offline','unknown')),
  last_connected_at INTEGER,
  observed_at INTEGER NOT NULL,
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest) = 71),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, external_id_hash),
  UNIQUE (tenant_id, asset_id),
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE TABLE IF NOT EXISTS screenconnect_poll_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  record_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  FOREIGN KEY (tenant_id) REFERENCES managed_tenants(id)
);

CREATE INDEX IF NOT EXISTS screenconnect_integrations_due
  ON screenconnect_integrations(status,last_polled_at,poll_interval_minutes);
CREATE INDEX IF NOT EXISTS screenconnect_asset_evidence_tenant_state
  ON screenconnect_asset_evidence(tenant_id,connection_state,observed_at DESC);
CREATE INDEX IF NOT EXISTS screenconnect_poll_runs_tenant_time
  ON screenconnect_poll_runs(tenant_id,started_at DESC);
