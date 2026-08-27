CREATE TABLE IF NOT EXISTS security_reviews (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  organization TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  repository_url TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  branch_context TEXT NOT NULL DEFAULT '',
  scope_paths_json TEXT NOT NULL,
  authorization_attested INTEGER NOT NULL,
  repository_license_attested INTEGER NOT NULL,
  safe_testing_consent INTEGER NOT NULL,
  quoted_atomic TEXT NOT NULL,
  payment_status TEXT NOT NULL DEFAULT 'unsubmitted',
  payment_tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN ('awaiting_payment','payment_review','queued','running','report_ready','completed','rejected','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS security_findings (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('informational','low','medium','high','critical')),
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  cwe TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL,
  location TEXT NOT NULL,
  evidence TEXT NOT NULL,
  impact TEXT NOT NULL,
  remediation TEXT NOT NULL,
  verification_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (review_id) REFERENCES security_reviews(id)
);

CREATE TABLE IF NOT EXISTS security_review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (review_id) REFERENCES security_reviews(id)
);

CREATE INDEX IF NOT EXISTS security_reviews_status_created ON security_reviews(status,created_at DESC);
CREATE INDEX IF NOT EXISTS security_findings_review_severity ON security_findings(review_id,severity,created_at DESC);
