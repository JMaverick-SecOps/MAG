-- Separate from citizen sponsorship, RMM trials and community membership.
CREATE TABLE agent_connection_invoices (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL REFERENCES guild_applications(handle),
  amount_atomic TEXT NOT NULL CHECK(amount_atomic='1000000'),
  treasury_address TEXT NOT NULL,
  calldata TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid','pending_verification','paid')),
  tx_hash TEXT,
  period_start INTEGER,
  period_end INTEGER,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  last_checked_at INTEGER,
  CHECK(status<>'paid' OR (tx_hash IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_end-period_start=86400000 AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_connection_one_open ON agent_connection_invoices(handle) WHERE status<>'paid';
CREATE INDEX agent_connection_pending ON agent_connection_invoices(status,created_at);
CREATE TRIGGER agent_connection_invoice_immutable
BEFORE UPDATE OF id,handle,amount_atomic,treasury_address,calldata,created_at ON agent_connection_invoices
BEGIN SELECT RAISE(ABORT,'immutable agent connection invoice'); END;
CREATE TRIGGER agent_connection_paid_immutable
BEFORE UPDATE ON agent_connection_invoices WHEN OLD.status='paid'
BEGIN SELECT RAISE(ABORT,'immutable paid connection receipt'); END;
CREATE TRIGGER agent_connection_no_delete BEFORE DELETE ON agent_connection_invoices
BEGIN SELECT RAISE(ABORT,'retain connection audit trail'); END;
