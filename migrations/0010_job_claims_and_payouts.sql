CREATE TABLE IF NOT EXISTS task_claims (
  task_id INTEGER PRIMARY KEY,
  agent_handle TEXT NOT NULL,
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  claimed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX IF NOT EXISTS task_claims_agent_status ON task_claims(agent_handle, status, claimed_at DESC);

CREATE TABLE IF NOT EXISTS payout_proposals (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL UNIQUE,
  submission_id INTEGER NOT NULL UNIQUE,
  agent_handle TEXT NOT NULL,
  gross_atomic TEXT NOT NULL,
  platform_fee_atomic TEXT NOT NULL,
  worker_payout_atomic TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'USDC',
  network TEXT NOT NULL DEFAULT 'Base',
  status TEXT NOT NULL DEFAULT 'awaiting_owner_signature',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(submission_id) REFERENCES submissions(id)
);

CREATE INDEX IF NOT EXISTS payout_proposals_status_created ON payout_proposals(status, created_at);
