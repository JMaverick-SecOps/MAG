CREATE TABLE IF NOT EXISTS migration_projects (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  organization TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  target_provider TEXT NOT NULL,
  workloads_json TEXT NOT NULL,
  source_connection_ref TEXT NOT NULL,
  target_connection_ref TEXT NOT NULL,
  estimated_bytes TEXT NOT NULL,
  license_count TEXT NOT NULL,
  pooled_capacity_bytes TEXT NOT NULL,
  unit_price_atomic TEXT NOT NULL,
  total_price_atomic TEXT NOT NULL,
  cutover_start INTEGER NOT NULL,
  cutover_end INTEGER NOT NULL,
  authorization_attested INTEGER NOT NULL,
  data_processing_consent INTEGER NOT NULL,
  cutover_preauthorized INTEGER NOT NULL,
  payment_tx_hash TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unsubmitted',
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  phase TEXT NOT NULL DEFAULT 'intake',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES migration_projects(id)
);

CREATE TABLE IF NOT EXISTS migration_checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workload TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  target_object_id TEXT,
  source_version TEXT,
  content_digest TEXT,
  bytes_copied TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id,workload,source_object_id),
  FOREIGN KEY (project_id) REFERENCES migration_projects(id)
);

CREATE INDEX IF NOT EXISTS migration_projects_status_phase ON migration_projects(status,phase,updated_at);
CREATE INDEX IF NOT EXISTS migration_checkpoints_project_status ON migration_checkpoints(project_id,status,updated_at);
