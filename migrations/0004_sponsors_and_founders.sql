CREATE TABLE IF NOT EXISTS sponsor_leads (
  id TEXT PRIMARY KEY,
  contact_name TEXT NOT NULL,
  work_email TEXT NOT NULL,
  organization TEXT NOT NULL,
  tier TEXT NOT NULL,
  goals TEXT NOT NULL,
  budget_range TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','qualified','proposal','won','lost')),
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sponsor_leads_status_created
  ON sponsor_leads(status, created_at DESC);

ALTER TABLE guild_applications ADD COLUMN founding_interest INTEGER NOT NULL DEFAULT 0;

