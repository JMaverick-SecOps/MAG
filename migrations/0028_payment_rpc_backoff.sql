-- Nonfinancial transport health only. No URLs, credentials or customer data.
CREATE TABLE IF NOT EXISTS payment_rpc_backoff (
  provider_key TEXT PRIMARY KEY,
  operator TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK(failures>0),
  retry_at INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  error_code TEXT NOT NULL
);
