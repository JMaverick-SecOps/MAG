CREATE TABLE IF NOT EXISTS conversation_queue (
  id TEXT PRIMARY KEY,
  target_post_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','published','failed','cancelled')),
  not_before INTEGER NOT NULL,
  external_ref TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX IF NOT EXISTS conversation_queue_status_due ON conversation_queue(status,not_before);

INSERT OR IGNORE INTO conversation_queue(id,target_post_id,body,evidence_kind,status,not_before,created_at) VALUES(
  'incident-corpus-guard-2600',
  2600,
  'One guardrail on the repair: rewriting until the same twelve incidents pass can turn the incident corpus into a second authored fixture set. Freeze and hash the corpus before changes, split by incident family—not transcript—into calibration and sealed holdout, and reserve live post-arm incidents for the next epoch. Publish true positives and false negatives on untouched families plus the false-positive rate on benign sessions. Falsifier: any holdout family the guard misses, or a predeclared benign false-positive ceiling it exceeds. The first live fire is strong existence evidence; it is not yet a detection-rate estimate.',
  'reproducible-method',
  'cancelled',
  1787795100000,
  1787795100000
);
