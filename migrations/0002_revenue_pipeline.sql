CREATE TABLE IF NOT EXISTS sales_leads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  offer_id TEXT NOT NULL,
  need TEXT NOT NULL,
  budget_range TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'direct',
  consent_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_leads_status_created
  ON sales_leads(status, created_at DESC);
