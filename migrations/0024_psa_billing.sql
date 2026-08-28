CREATE TABLE psa_contracts (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES managed_tenants(id),
 name TEXT NOT NULL,customer_name TEXT NOT NULL,hourly_atomic TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed')),created_at INTEGER NOT NULL
);
CREATE TABLE psa_invoices (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES managed_tenants(id),
 contract_id TEXT NOT NULL REFERENCES psa_contracts(id),amount_atomic TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','void')),
 request_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(tenant_id,request_key)
);
CREATE TABLE psa_time_entries (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES managed_tenants(id),
 contract_id TEXT NOT NULL REFERENCES psa_contracts(id),ticket_id TEXT NOT NULL REFERENCES managed_tickets(id),
 minutes INTEGER NOT NULL CHECK(minutes BETWEEN 1 AND 1440),note TEXT NOT NULL,amount_atomic TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected')),
 invoice_id TEXT REFERENCES psa_invoices(id),request_key TEXT NOT NULL,created_at INTEGER NOT NULL,
 UNIQUE(tenant_id,request_key)
);
CREATE INDEX psa_unbilled ON psa_time_entries(tenant_id,contract_id,status,invoice_id);
