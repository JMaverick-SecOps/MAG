CREATE TABLE managed_subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE REFERENCES managed_tenants(id),
  plan_id TEXT NOT NULL,
  endpoint_limit INTEGER NOT NULL CHECK(endpoint_limit BETWEEN 1 AND 10000),
  monthly_atomic TEXT NOT NULL,
  billing_method TEXT NOT NULL DEFAULT 'prepaid_base_usdc',
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','active','past_due','cancelled')),
  paid_through INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK(cancel_at_period_end IN (0,1)),
  terms_version TEXT NOT NULL,
  request_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE subscription_invoices (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES managed_subscriptions(id),
  period_number INTEGER NOT NULL CHECK(period_number >= 1),
  amount_atomic TEXT NOT NULL,
  period_start INTEGER,
  period_end INTEGER,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','pending_verification','paid','void')),
  tx_hash TEXT UNIQUE,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(subscription_id,period_number)
);
CREATE TABLE subscription_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT NOT NULL REFERENCES managed_subscriptions(id),
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER subscription_events_no_update BEFORE UPDATE ON subscription_events BEGIN SELECT RAISE(ABORT,'append-only subscription history'); END;
CREATE TRIGGER subscription_events_no_delete BEFORE DELETE ON subscription_events BEGIN SELECT RAISE(ABORT,'append-only subscription history'); END;
CREATE INDEX subscriptions_due ON managed_subscriptions(status,paid_through);
