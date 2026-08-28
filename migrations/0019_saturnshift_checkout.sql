ALTER TABLE service_orders ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'base_usdc_direct'
  CHECK (payment_provider IN ('base_usdc_direct', 'saturnshift'));
ALTER TABLE service_orders ADD COLUMN provider_payment_id TEXT;
ALTER TABLE service_orders ADD COLUMN provider_payment_status TEXT;
ALTER TABLE service_orders ADD COLUMN provider_external_reference TEXT;
ALTER TABLE service_orders ADD COLUMN provider_idempotency_key TEXT;
ALTER TABLE service_orders ADD COLUMN provider_verified_at INTEGER;
ALTER TABLE service_orders ADD COLUMN provider_verification_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS service_orders_provider_payment
  ON service_orders(payment_provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_orders_provider_external_reference
  ON service_orders(payment_provider, provider_external_reference)
  WHERE provider_external_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_orders_provider_idempotency_key
  ON service_orders(payment_provider, provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_provider_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('saturnshift')),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  order_id TEXT,
  payment_id TEXT,
  signature_scheme TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  processing_status TEXT NOT NULL
    CHECK (processing_status IN ('verified_pending_apply', 'applied', 'accepted_pending_reserve', 'ignored_non_success')),
  details TEXT NOT NULL DEFAULT '{}',
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  UNIQUE(provider, event_id),
  FOREIGN KEY(order_id) REFERENCES service_orders(id)
);

CREATE INDEX IF NOT EXISTS payment_provider_events_order_received
  ON payment_provider_events(order_id, received_at DESC);

CREATE TABLE IF NOT EXISTS payment_provider_receipt_claims (
  provider TEXT NOT NULL CHECK (provider IN ('saturnshift')),
  payment_id TEXT NOT NULL,
  purpose_type TEXT NOT NULL CHECK (purpose_type IN ('service_order')),
  purpose_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(provider, payment_id),
  UNIQUE(provider, event_id),
  FOREIGN KEY(purpose_id) REFERENCES service_orders(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS service_order_saturnshift_lifecycle_events
  ON order_events(order_id, kind)
  WHERE kind IN ('saturnshift_payment_verified_and_task_published', 'saturnshift_fiat_paid_pending_usdc_reserve');
