CREATE TABLE IF NOT EXISTS service_orders (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL,
  service_id TEXT NOT NULL,
  buyer_name TEXT NOT NULL,
  buyer_email TEXT NOT NULL,
  buyer_agent_handle TEXT NOT NULL DEFAULT '',
  objective TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  target_scope TEXT NOT NULL,
  authorization_attested INTEGER NOT NULL,
  execution_mode TEXT NOT NULL,
  quoted_atomic TEXT NOT NULL,
  max_budget_atomic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  assigned_agent TEXT,
  payment_tx_hash TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unsubmitted',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS service_orders_status_created ON service_orders(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS service_orders_payment_tx ON service_orders(payment_tx_hash) WHERE payment_tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(order_id) REFERENCES service_orders(id)
);

CREATE INDEX IF NOT EXISTS order_events_order_created ON order_events(order_id, created_at);

