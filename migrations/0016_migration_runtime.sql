ALTER TABLE migration_projects ADD COLUMN workflow_instance_id TEXT;
ALTER TABLE migration_projects ADD COLUMN workflow_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE migration_projects ADD COLUMN continuation_cursor TEXT;

CREATE TABLE IF NOT EXISTS migration_connections (
  project_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('source','target')),
  provider TEXT NOT NULL,
  vault_reference TEXT NOT NULL,
  tenant_hint TEXT NOT NULL DEFAULT '',
  imap_host TEXT NOT NULL DEFAULT '',
  imap_port INTEGER,
  required_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_validation' CHECK (status IN ('pending_validation','ready','rejected','revoked')),
  validation_code TEXT,
  validated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id,side),
  FOREIGN KEY (project_id) REFERENCES migration_projects(id)
);

CREATE TABLE IF NOT EXISTS migration_mappings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workload TEXT NOT NULL,
  source_principal TEXT NOT NULL,
  target_principal TEXT NOT NULL,
  source_container TEXT NOT NULL DEFAULT '',
  target_container TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','rejected','complete')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id,workload,source_principal,source_container),
  FOREIGN KEY (project_id) REFERENCES migration_projects(id)
);

CREATE TABLE IF NOT EXISTS migration_batch_receipts (
  project_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor TEXT,
  attempted INTEGER NOT NULL,
  succeeded INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  bytes TEXT NOT NULL,
  reason_code TEXT NOT NULL DEFAULT '',
  result_digest TEXT NOT NULL,
  generation INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id,batch_id),
  FOREIGN KEY (project_id) REFERENCES migration_projects(id)
);

CREATE TABLE IF NOT EXISTS payment_receipt_claims (
  tx_hash TEXT PRIMARY KEY,
  purpose_type TEXT NOT NULL,
  purpose_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(purpose_type,purpose_id)
);

INSERT OR IGNORE INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at)
  SELECT payment_tx_hash,'service_order',id,updated_at FROM service_orders WHERE payment_tx_hash IS NOT NULL;
INSERT OR IGNORE INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at)
  SELECT payment_tx_hash,'bounty',id,updated_at FROM bounty_requests WHERE payment_tx_hash IS NOT NULL;
INSERT OR IGNORE INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at)
  SELECT payment_tx_hash,'migration',id,updated_at FROM migration_projects WHERE payment_tx_hash IS NOT NULL;
INSERT OR IGNORE INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at)
  SELECT payment_tx_hash,'security_review',id,updated_at FROM security_reviews WHERE payment_tx_hash IS NOT NULL;
INSERT OR IGNORE INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at)
  SELECT tx_hash,'citizen_support',id,created_at FROM citizen_support_pledges;

UPDATE migration_projects
  SET status='awaiting_preflight',payment_status='not_requested'
  WHERE status='awaiting_payment' AND payment_status='unsubmitted';

CREATE INDEX IF NOT EXISTS migration_connections_status ON migration_connections(status,updated_at);
CREATE INDEX IF NOT EXISTS migration_mappings_project_status ON migration_mappings(project_id,status,workload);
CREATE INDEX IF NOT EXISTS migration_batch_receipts_project_time ON migration_batch_receipts(project_id,created_at DESC);
