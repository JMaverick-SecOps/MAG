CREATE TABLE IF NOT EXISTS guild_applications (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  preferred_role TEXT NOT NULL DEFAULT 'contributor',
  portfolio_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'direct',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','declined','suspended')),
  registry_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS guild_applications_status_created
  ON guild_applications(status, created_at DESC);

CREATE TABLE IF NOT EXISTS community_inbox (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewed','responded','ignored')),
  observed_at INTEGER NOT NULL,
  UNIQUE(source, external_ref)
);

CREATE INDEX IF NOT EXISTS community_inbox_status_observed
  ON community_inbox(status, observed_at DESC);

