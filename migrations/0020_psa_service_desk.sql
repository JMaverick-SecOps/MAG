ALTER TABLE managed_tickets ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE managed_tickets ADD COLUMN request_key TEXT;
ALTER TABLE managed_tickets ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE managed_tickets ADD COLUMN resolution TEXT NOT NULL DEFAULT '';
ALTER TABLE managed_tickets ADD COLUMN due_at INTEGER;
ALTER TABLE managed_tickets ADD COLUMN resolved_at INTEGER;
CREATE UNIQUE INDEX managed_ticket_request ON managed_tickets(tenant_id,request_key) WHERE request_key IS NOT NULL;
CREATE TABLE managed_ticket_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(ticket_id,version),
  FOREIGN KEY(tenant_id) REFERENCES managed_tenants(id),
  FOREIGN KEY(ticket_id) REFERENCES managed_tickets(id)
);
CREATE TRIGGER managed_ticket_events_no_update BEFORE UPDATE ON managed_ticket_events BEGIN SELECT RAISE(ABORT,'ticket events are append-only'); END;
CREATE TRIGGER managed_ticket_events_no_delete BEFORE DELETE ON managed_ticket_events BEGIN SELECT RAISE(ABORT,'ticket events are append-only'); END;
