CREATE TABLE managed_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES managed_tenants(id),
  asset_id TEXT NOT NULL,
  runbook TEXT NOT NULL CHECK(runbook IN ('collect_inventory','service_health','restart_service')),
  parameters_json TEXT NOT NULL,
  request_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK(status IN ('pending_approval','approved','leased','succeeded','failed','unknown','expired','denied')),
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  lease_token_hash TEXT,
  leased_at INTEGER,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant_id,request_key),
  FOREIGN KEY(tenant_id,asset_id) REFERENCES managed_devices(tenant_id,asset_id)
);
CREATE TABLE managed_device_requests (
  tenant_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,asset_id,nonce)
);
CREATE INDEX managed_jobs_dispatch ON managed_jobs(tenant_id,asset_id,status,created_at);
