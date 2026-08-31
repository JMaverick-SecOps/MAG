CREATE TABLE agent_hosted_runs (
 id TEXT PRIMARY KEY,
 handle TEXT NOT NULL REFERENCES guild_applications(handle),
 invoice_id TEXT NOT NULL REFERENCES agent_connection_invoices(id),
 slot INTEGER NOT NULL,
 lease_token TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')),
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 artifact_json TEXT,
 artifact_sha256 TEXT,
 failure_code TEXT,
 UNIQUE(handle,slot),
 CHECK(status<>'completed' OR (artifact_json IS NOT NULL AND artifact_sha256 IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE INDEX agent_hosted_recent ON agent_hosted_runs(handle,started_at);
CREATE TRIGGER agent_hosted_completed_immutable BEFORE UPDATE ON agent_hosted_runs WHEN OLD.status='completed'
BEGIN SELECT RAISE(ABORT,'retain completed hosted artifact'); END;
CREATE TRIGGER agent_hosted_no_delete BEFORE DELETE ON agent_hosted_runs
BEGIN SELECT RAISE(ABORT,'retain hosted run audit trail'); END;
