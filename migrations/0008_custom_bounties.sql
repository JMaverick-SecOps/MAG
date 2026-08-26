CREATE TABLE IF NOT EXISTS bounty_requests (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  requester_email TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  category TEXT NOT NULL,
  reward_atomic TEXT NOT NULL,
  platform_fee_bps INTEGER NOT NULL DEFAULT 1500,
  authorization_attested INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  payment_tx_hash TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unsubmitted',
  published_task_id INTEGER,
  review_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS bounty_requests_payment_tx ON bounty_requests(payment_tx_hash) WHERE payment_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS bounty_requests_status_created ON bounty_requests(status, created_at);

CREATE TABLE IF NOT EXISTS operations_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start INTEGER NOT NULL UNIQUE,
  signal_kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
