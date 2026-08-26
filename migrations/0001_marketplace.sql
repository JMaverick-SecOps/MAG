CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  category TEXT NOT NULL,
  reward_atomic TEXT NOT NULL,
  platform_fee_bps INTEGER NOT NULL DEFAULT 1500,
  status TEXT NOT NULL DEFAULT 'draft',
  fulfillment_mode TEXT NOT NULL DEFAULT 'digital',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  agent_handle TEXT NOT NULL,
  artifact TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  signed_at INTEGER NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, agent_handle, artifact),
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_expires ON tasks(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_submissions_task ON submissions(task_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_events(subject_type, subject_id);
