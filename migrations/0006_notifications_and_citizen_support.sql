CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  sms_status TEXT NOT NULL DEFAULT 'pending',
  email_status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);

CREATE INDEX IF NOT EXISTS notification_events_pending
  ON notification_events(sms_status, email_status, created_at);

CREATE TABLE IF NOT EXISTS citizen_support_pledges (
  id TEXT PRIMARY KEY,
  citizen_handle TEXT NOT NULL,
  sponsor_name TEXT NOT NULL DEFAULT '',
  sponsor_email TEXT NOT NULL DEFAULT '',
  tx_hash TEXT NOT NULL UNIQUE,
  amount_atomic TEXT NOT NULL DEFAULT '1000000',
  chain_id INTEGER NOT NULL DEFAULT 8453,
  token_contract TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','verified','allocated','rejected')),
  consent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  allocated_at INTEGER
);

CREATE INDEX IF NOT EXISTS citizen_support_status_created
  ON citizen_support_pledges(status, created_at DESC);

