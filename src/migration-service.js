const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LICENSE_ATOMIC = 18_000_000n;
const LICENSE_BYTES = 500n * 1024n * 1024n * 1024n;
const PROVIDERS = Object.freeze({
  m365: { name: "Microsoft 365", workloads: ["mail", "calendar", "contacts", "onedrive", "sharepoint"] },
  google_workspace: { name: "Google Workspace", workloads: ["mail", "calendar", "contacts", "google_drive", "shared_drives"] },
  imap: { name: "Generic IMAP", workloads: ["mail"] },
  dropbox: { name: "Dropbox", workloads: ["dropbox"] },
  sharepoint: { name: "SharePoint Online", workloads: ["sharepoint"] },
  google_drive: { name: "Google Drive", workloads: ["google_drive", "shared_drives"] },
});
const MAIL = new Set(["m365", "google_workspace", "imap"]);
const FILES = new Set(["m365", "google_workspace", "dropbox", "sharepoint", "google_drive"]);
const WORKLOADS = new Set(["mail", "calendar", "contacts", "onedrive", "sharepoint", "google_drive", "shared_drives", "dropbox"]);

function clean(value, maximum) { return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum); }
function provider(id) { return PROVIDERS[clean(id, 40)] || null; }

function migrationCompatibility(sourceId, targetId, workloads) {
  const source = provider(sourceId), target = provider(targetId);
  if (!source || !target || sourceId === targetId) return { compatible: false, reason: "distinct supported providers are required" };
  const requested = [...new Set((workloads || []).map((item) => clean(item, 40).toLowerCase()).filter((item) => WORKLOADS.has(item)))];
  if (!requested.length) return { compatible: false, reason: "at least one supported workload is required" };
  const mailRequested = requested.some((item) => ["mail", "calendar", "contacts"].includes(item));
  const filesRequested = requested.some((item) => !["mail", "calendar", "contacts"].includes(item));
  if (mailRequested && (!MAIL.has(sourceId) || !MAIL.has(targetId))) return { compatible: false, reason: "mail workloads require mail-capable source and target providers" };
  if (filesRequested && (!FILES.has(sourceId) || !FILES.has(targetId))) return { compatible: false, reason: "file workloads require file-capable source and target providers" };
  if (sourceId === "imap" && requested.some((item) => item !== "mail")) return { compatible: false, reason: "generic IMAP supports mail only" };
  return { compatible: true, workloads: requested };
}

function quoteLicenses(estimatedBytes, licenseCount) {
  const bytes = BigInt(String(estimatedBytes || "0"));
  const requested = BigInt(String(licenseCount || "0"));
  if (bytes < 0n || requested < 1n || requested > 100000n) throw new Error("valid estimated_bytes and license_count are required");
  const required = bytes === 0n ? 1n : (bytes + LICENSE_BYTES - 1n) / LICENSE_BYTES;
  if (requested < required) throw new Error(`license_count must be at least ${required}`);
  return { license_count: requested.toString(), pooled_capacity_bytes: (requested * LICENSE_BYTES).toString(), estimated_bytes: bytes.toString(), unit_price_atomic: LICENSE_ATOMIC.toString(), total_price_atomic: (requested * LICENSE_ATOMIC).toString(), asset: "USDC", network: "Base" };
}

function validateMigration(input) {
  const organization = clean(input.organization, 140);
  const contactEmail = clean(input.contact_email, 254).toLowerCase();
  const sourceId = clean(input.source_provider, 40);
  const targetId = clean(input.target_provider, 40);
  const compatibility = migrationCompatibility(sourceId, targetId, Array.isArray(input.workloads) ? input.workloads : []);
  if (organization.length < 2 || !EMAIL.test(contactEmail) || !compatibility.compatible) throw new Error(compatibility.reason || "valid organization and contact email are required");
  const sourceConnection = clean(input.source_connection_id, 160);
  const targetConnection = clean(input.target_connection_id, 160);
  if (!/^[a-zA-Z0-9._:-]{8,160}$/.test(sourceConnection) || !/^[a-zA-Z0-9._:-]{8,160}$/.test(targetConnection)) throw new Error("vault-backed source and target connection references are required");
  const quote = quoteLicenses(input.estimated_bytes, input.license_count);
  const cutoverStart = Number(input.cutover_start);
  const cutoverEnd = Number(input.cutover_end);
  if (!Number.isInteger(cutoverStart) || !Number.isInteger(cutoverEnd) || cutoverEnd <= cutoverStart || cutoverStart < Date.now() + 3600000) throw new Error("a future bounded cutover window is required");
  if (input.source_authorization_attested !== true || input.target_authorization_attested !== true || input.data_processing_consent !== true || input.cutover_preauthorized !== true) throw new Error("source, target, data-processing, and cutover authorization are required");
  return { organization, contactEmail, sourceId, targetId, workloads: compatibility.workloads, sourceConnection, targetConnection, quote, cutoverStart, cutoverEnd };
}

async function sha256(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

async function createMigrationProject(db, input) {
  const migration = validateMigration(input);
  const id = crypto.randomUUID();
  const accessToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = Date.now();
  await db.prepare("INSERT INTO migration_projects(id,access_token_hash,organization,contact_email,source_provider,target_provider,workloads_json,source_connection_ref,target_connection_ref,estimated_bytes,license_count,pooled_capacity_bytes,unit_price_atomic,total_price_atomic,cutover_start,cutover_end,authorization_attested,data_processing_consent,cutover_preauthorized,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,'awaiting_payment','intake',?,?)")
    .bind(id, await sha256(accessToken), migration.organization, migration.contactEmail, migration.sourceId, migration.targetId, JSON.stringify(migration.workloads), migration.sourceConnection, migration.targetConnection, migration.quote.estimated_bytes, migration.quote.license_count, migration.quote.pooled_capacity_bytes, migration.quote.unit_price_atomic, migration.quote.total_price_atomic, migration.cutoverStart, migration.cutoverEnd, now, now).run();
  await db.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) VALUES(?,'project_created',?,?)").bind(id, JSON.stringify({ source: migration.sourceId, target: migration.targetId, workloads: migration.workloads, quote: migration.quote, source_deletion: false }), now).run();
  return { id, access_token: accessToken, status: "awaiting_payment", phase: "intake", quote: migration.quote, autonomous_phases: ["preflight", "discovery", "mapping_validation", "initial_sync", "delta_sync", "preauthorized_cutover", "verification", "report"], warning: "Save access_token. Connection references must resolve through the operator's secret vault. Never submit provider passwords, refresh tokens, cookies, or private keys to this API." };
}

async function authorizedMigration(db, id, token) {
  if (!token) return null;
  const row = await db.prepare("SELECT * FROM migration_projects WHERE id=?").bind(id).first();
  if (!row || await sha256(token) !== row.access_token_hash) return null;
  delete row.access_token_hash;
  row.workloads = JSON.parse(row.workloads_json || "[]");
  delete row.workloads_json;
  row.source_connection_ref = "configured";
  row.target_connection_ref = "configured";
  return row;
}

function migrationManifest() {
  return {
    product: "MAG Migration Fabric",
    maturity: "control_plane_mvp",
    license: { price: "$18 USDC", price_atomic: LICENSE_ATOMIC.toString(), pooled_capacity: "500 GiB per license", pooled_capacity_bytes: LICENSE_BYTES.toString(), pooling: "Capacity pools across all users and workloads in one migration project." },
    providers: PROVIDERS,
    supported_paths: ["Microsoft 365 ↔ Google Workspace", "Microsoft 365 ↔ generic IMAP (mail only)", "Google Workspace ↔ generic IMAP (mail only)", "Dropbox ↔ SharePoint Online", "Google Drive ↔ Microsoft 365/SharePoint", "Dropbox ↔ Google Drive"],
    inputs: ["authorized source and target provider", "vault-backed connection references", "user/site/drive mapping", "workload scope", "estimated bytes", "license count", "preauthorized cutover window"],
    automation: ["preflight", "discovery", "mapping validation", "initial copy", "retry and checkpoint", "delta pass", "cutover", "item/count/size verification", "exception report"],
    safety: ["no raw credentials accepted", "no source deletion", "idempotent copy/checkpoint design", "least-privilege provider consent", "tenant-scoped audit trail", "cutover bounded by preauthorization"],
    honesty: "The current release is the authorization, licensing, job, checkpoint, and reporting control plane. Provider data movers require configured OAuth connectors and queue workers before a project can enter running state.",
    api: { create: "POST /api/migrations", project: "GET /api/migrations/:id", catalog: "GET /api/migrations" },
  };
}

function migrationPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG Migration Fabric</title><style>body{margin:0;background:#061a33;color:#eaf7ff;font:16px system-ui}.wrap{max-width:1120px;margin:auto;padding:34px}.hero,.card{background:#092440;border:1px solid #1c5874;border-radius:18px;padding:24px}.hero{display:grid;grid-template-columns:1.4fr .6fr;gap:20px}.price{font-size:42px;color:#ffd15c;font-weight:800}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:18px}.card h2{color:#11d8ed}.flow{display:flex;gap:8px;flex-wrap:wrap}.step{padding:9px 12px;border-radius:999px;background:#0c3454;border:1px solid #1b6b86}.note{color:#acd3df}a{color:#11d8ed}@media(max-width:760px){.hero,.grid{grid-template-columns:1fr}}</style></head><body><main class="wrap"><p><a href="/">← MAG</a></p><section class="hero"><div><h1>Migration Fabric</h1><p>Authorized, checkpointed mailbox and file migration across Microsoft 365, Google Workspace, IMAP, Dropbox, SharePoint, and Google Drive.</p><p class="note">No raw provider passwords. No source deletion. OAuth connection references stay in a secret vault.</p></div><div><div class="price">$18</div><b>USDC per license</b><p>500 GiB pooled capacity per license.</p></div></section><div class="grid"><article class="card"><h2>Email</h2><p>M365, Google Workspace, and generic IMAP. Calendar and contacts when both providers support them.</p></article><article class="card"><h2>Files</h2><p>Dropbox, Google Drive, OneDrive, Shared Drives, and SharePoint Online.</p></article><article class="card"><h2>Evidence</h2><p>Item counts, bytes, checkpoints, retries, exceptions, deltas, and a final reconciliation report.</p></article></div><section class="card" style="margin-top:18px"><h2>Autonomous job flow</h2><div class="flow">${["Preflight","Discover","Map","Initial sync","Retry","Delta","Cutover","Verify","Report"].map((step)=>`<span class="step">${step}</span>`).join("")}</div><p class="note">Control-plane MVP: provider connector workers must be configured before a paid project can run.</p></section></main></body></html>`;
}

export { LICENSE_ATOMIC, LICENSE_BYTES, PROVIDERS, authorizedMigration, createMigrationProject, migrationCompatibility, migrationManifest, migrationPage, quoteLicenses, validateMigration };
