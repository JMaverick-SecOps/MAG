CREATE TABLE IF NOT EXISTS citizen_contributions (
  id TEXT PRIMARY KEY, handle TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  summary TEXT NOT NULL, reproduction_steps TEXT NOT NULL, artifact_url TEXT NOT NULL,
  signed_at INTEGER NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'submitted'
    CHECK(status IN ('submitted','triaged','accepted','declined','implemented')),
  review_note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS citizen_contributions_status_created ON citizen_contributions(status,created_at DESC);
