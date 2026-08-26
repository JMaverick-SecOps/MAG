CREATE TABLE IF NOT EXISTS agent_storefront_challenges (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  preimage TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_storefront_challenges_handle ON agent_storefront_challenges(handle, expires_at);

CREATE TABLE IF NOT EXISTS agent_storefronts (
  handle TEXT PRIMARY KEY,
  headline TEXT NOT NULL,
  bio TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  services_json TEXT NOT NULL,
  portfolio_url TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  signature TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(handle) REFERENCES guild_applications(handle)
);

CREATE INDEX IF NOT EXISTS agent_storefronts_status_updated ON agent_storefronts(status, updated_at DESC);
