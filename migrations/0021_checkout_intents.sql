ALTER TABLE service_orders ADD COLUMN payment_binding_required INTEGER NOT NULL DEFAULT 0 CHECK(payment_binding_required IN (0,1));
CREATE TABLE checkout_payment_intents (
  purpose_type TEXT NOT NULL CHECK(purpose_type IN ('service_order','subscription_invoice')),
  purpose_id TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  treasury_address TEXT NOT NULL,
  calldata TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(purpose_type,purpose_id)
);
CREATE TRIGGER checkout_intents_no_update BEFORE UPDATE ON checkout_payment_intents BEGIN SELECT RAISE(ABORT,'immutable payment intent'); END;
CREATE TRIGGER checkout_intents_no_delete BEFORE DELETE ON checkout_payment_intents BEGIN SELECT RAISE(ABORT,'immutable payment intent'); END;
