import { claimPaymentReceipt, verifyBaseUsdcTransfer } from "./commerce.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TX_HASH = /^0x[a-f0-9]{64}$/;
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
function isVaultReference(value) { return /^(?:vault|secret-store|connector):[a-zA-Z0-9][a-zA-Z0-9._:-]{6,145}$/.test(String(value || "")); }

function migrationCompatibility(sourceId, targetId, workloads) {
  const source = provider(sourceId), target = provider(targetId);
  if (!source || !target || sourceId === targetId) return { compatible: false, reason: "distinct supported providers are required" };
  const requested = [...new Set((workloads || []).map((item) => clean(item, 40).toLowerCase()).filter((item) => WORKLOADS.has(item)))];
  if (!requested.length) return { compatible: false, reason: "at least one supported workload is required" };
  const mailRequested = requested.some((item) => ["mail", "calendar", "contacts"].includes(item));
  const filesRequested = requested.some((item) => !["mail", "calendar", "contacts"].includes(item));
  if (mailRequested && (!MAIL.has(sourceId) || !MAIL.has(targetId))) return { compatible: false, reason: "mail workloads require mail-capable source and target providers" };
  if (filesRequested && (!FILES.has(sourceId) || !FILES.has(targetId))) return { compatible: false, reason: "file workloads require file-capable source and target providers" };
  if ((sourceId === "imap" || targetId === "imap") && requested.some((item) => item !== "mail")) return { compatible: false, reason: "generic IMAP supports mail only" };
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
  if (!isVaultReference(sourceConnection) || !isVaultReference(targetConnection)) throw new Error("vault-backed source and target connection references with a vault:, secret-store:, or connector: prefix are required");
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
  await db.prepare("INSERT INTO migration_projects(id,access_token_hash,organization,contact_email,source_provider,target_provider,workloads_json,source_connection_ref,target_connection_ref,estimated_bytes,license_count,pooled_capacity_bytes,unit_price_atomic,total_price_atomic,cutover_start,cutover_end,authorization_attested,data_processing_consent,cutover_preauthorized,payment_status,status,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,1,'not_requested','awaiting_preflight','intake',?,?)")
    .bind(id, await sha256(accessToken), migration.organization, migration.contactEmail, migration.sourceId, migration.targetId, JSON.stringify(migration.workloads), migration.sourceConnection, migration.targetConnection, migration.quote.estimated_bytes, migration.quote.license_count, migration.quote.pooled_capacity_bytes, migration.quote.unit_price_atomic, migration.quote.total_price_atomic, migration.cutoverStart, migration.cutoverEnd, now, now).run();
  await db.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) VALUES(?,'project_created',?,?)").bind(id, JSON.stringify({ source: migration.sourceId, target: migration.targetId, workloads: migration.workloads, quote: migration.quote, source_deletion: false }), now).run();
  return { id, access_token: accessToken, status: "awaiting_preflight", payment_status: "not_requested", phase: "intake", quote: migration.quote, next_steps: ["register both vault-backed connections", "submit source-to-target mappings", "wait for private connector and capacity preflight", "pay only after status becomes awaiting_payment"], autonomous_phases: ["preflight", "discovery", "mapping_validation", "initial_sync", "delta_sync", "preauthorized_cutover", "verification", "report"], warning: "Save access_token. Do not send payment yet. Connection references must resolve through the operator's secret vault. Never submit provider passwords, refresh tokens, cookies, or private keys to this API." };
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

async function submitMigrationPaymentReceipt(db, id, token, input) {
  const project = await authorizedMigration(db, id, token);
  if (!project) throw new Error("project not found or unauthorized");
  const txHash = clean(input.tx_hash, 66).toLowerCase();
  if (!TX_HASH.test(txHash)) throw new Error("valid Base transaction hash required");
  if (project.status !== "awaiting_payment") throw new Error("payment is not authorized until private connector and delivery-capacity preflight succeeds");
  if (project.payment_status !== "unsubmitted") throw new Error("payment receipt already submitted");
  const now = Date.now();
  await claimPaymentReceipt(db, txHash, "migration", id, [
    db.prepare("UPDATE migration_projects SET payment_tx_hash=?,payment_status='pending_verification',status='payment_review',updated_at=? WHERE id=? AND payment_status='unsubmitted'").bind(txHash, now, id),
    db.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) SELECT ?,'payment_receipt_submitted',?,? WHERE EXISTS (SELECT 1 FROM migration_projects WHERE id=? AND payment_tx_hash=? AND payment_status='pending_verification')").bind(id, JSON.stringify({ tx_hash: txHash }), now, id, txHash),
  ], db.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) SELECT ?,'migration',?,? WHERE EXISTS (SELECT 1 FROM migration_projects WHERE id=? AND status='awaiting_payment' AND payment_status='unsubmitted')").bind(txHash, id, now, id));
  return { id, status: "payment_review", payment_status: "pending_verification" };
}

async function processPendingMigrationPayments(env, fetcher = fetch) {
  if (!env.DB || !/^0x[a-fA-F0-9]{40}$/.test(env.TREASURY_WALLET_ADDRESS || "")) return { configured: false, checked: 0, verified: 0 };
  const pending = await env.DB.prepare("SELECT id,total_price_atomic,payment_tx_hash FROM migration_projects WHERE payment_status='pending_verification' ORDER BY updated_at LIMIT 10").all();
  let verified = 0;
  for (const project of pending.results || []) {
    try {
      const result = await verifyBaseUsdcTransfer(project.payment_tx_hash, env.TREASURY_WALLET_ADDRESS, project.total_price_atomic, fetcher);
      if (!result.verified) continue;
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare("UPDATE migration_projects SET payment_status='verified',status='queued',updated_at=? WHERE id=? AND payment_status='pending_verification'").bind(now, project.id),
        env.DB.prepare("INSERT INTO migration_events(project_id,kind,details,created_at) VALUES(?,'payment_verified',?,?)").bind(project.id, JSON.stringify({ tx_hash: project.payment_tx_hash, confirmations: result.confirmations, independent_rpc_observations: result.independent_rpc_observations }), now),
      ]);
      verified += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "migration_payment_verification_deferred", project_id: project.id, message: String(error.message || error) }));
    }
  }
  return { configured: true, checked: (pending.results || []).length, verified };
}

function migrationManifest() {
  return {
    product: "MAG Migration Fabric",
    maturity: "preproduction_control_plane",
    license: { price: "$18 USDC", price_atomic: LICENSE_ATOMIC.toString(), pooled_capacity: "500 GiB per license", pooled_capacity_bytes: LICENSE_BYTES.toString(), pooling: "Capacity pools across all users and workloads in one migration project." },
    providers: PROVIDERS,
    supported_paths: ["Microsoft 365 ↔ Google Workspace", "Microsoft 365 ↔ generic IMAP (mail only)", "Google Workspace ↔ generic IMAP (mail only)", "Dropbox ↔ SharePoint Online", "Google Drive ↔ Microsoft 365/SharePoint", "Dropbox ↔ Google Drive"],
    inputs: ["authorized source and target provider", "vault-backed connection references", "user/site/drive mapping", "workload scope", "estimated bytes", "license count", "preauthorized cutover window"],
    automation: ["preflight", "discovery", "mapping validation", "initial copy", "retry and checkpoint", "delta pass", "cutover", "item/count/size verification", "exception report"],
    safety: ["no raw credentials accepted", "no source deletion", "idempotent copy/checkpoint design", "least-privilege provider consent", "tenant-scoped audit trail", "cutover bounded by preauthorization"],
    honesty: "This control plane includes authorization, exact-payment verification, licensing, mappings, durable workflow orchestration, idempotent checkpoints, and reporting contracts. It does not request payment until a private connector, both vaulted provider connections, mappings, and delivery capacity pass preflight. MAG does not claim that provider data movers are live until those bindings pass.",
    api: { create: "POST /api/migrations", project: "GET /api/migrations/:id", connection: "POST /api/migrations/:id/connections", mappings: "PUT /api/migrations/:id/mappings", payment_receipt: "POST /api/migrations/:id/payment-receipts", start: "POST /api/migrations/:id/start", catalog: "GET /api/migrations" },
  };
}

function migrationPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG Migration Fabric</title><style>body{margin:0;background:#061a33;color:#eaf7ff;font:16px system-ui}.wrap{max-width:1120px;margin:auto;padding:34px}.hero,.card{background:#092440;border:1px solid #1c5874;border-radius:18px;padding:24px}.hero{display:grid;grid-template-columns:1.4fr .6fr;gap:20px}.price{font-size:42px;color:#ffd15c;font-weight:800}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:18px}.card h2{color:#11d8ed}.flow{display:flex;gap:8px;flex-wrap:wrap}.step{padding:9px 12px;border-radius:999px;background:#0c3454;border:1px solid #1b6b86}.note{color:#acd3df}.gate{border-left:4px solid #f6c653;padding-left:14px}a{color:#11d8ed}@media(max-width:760px){.hero,.grid{grid-template-columns:1fr}}</style></head><body><main class="wrap"><p><a href="/">← MAG</a></p><section class="hero"><div><h1>Migration Fabric</h1><p>Authorized, checkpointed mailbox and file migration across Microsoft 365, Google Workspace, IMAP, Dropbox, SharePoint, and Google Drive.</p><p class="note">No raw provider passwords. No source deletion. OAuth connection references stay in a secret vault.</p></div><div><div class="price">$18</div><b>USDC per license</b><p>500 GiB pooled capacity per license.</p></div></section><div class="grid"><article class="card"><h2>Email</h2><p>M365, Google Workspace, and generic IMAP. Calendar and contacts when both providers support them.</p></article><article class="card"><h2>Files</h2><p>Dropbox, Google Drive, OneDrive, Shared Drives, and SharePoint Online.</p></article><article class="card"><h2>Evidence</h2><p>Item counts, bytes, checkpoints, retries, exceptions, deltas, and a final reconciliation report.</p></article></div><section class="card" style="margin-top:18px"><h2>Autonomous job flow</h2><div class="flow">${["Preflight","Discover","Map","Initial sync","Retry","Delta","Cutover","Verify","Report"].map((step)=>`<span class="step">${step}</span>`).join("")}</div><p class="note gate"><strong>Pre-production:</strong> the control plane is implemented. MAG will expose payment instructions only after the private provider connectors, vaulted source and target connections, mappings, and delivery capacity pass preflight.</p></section></main></body></html>`;
}

export { LICENSE_ATOMIC, LICENSE_BYTES, PROVIDERS, authorizedMigration, createMigrationProject, isVaultReference, migrationCompatibility, migrationManifest, migrationPage, processPendingMigrationPayments, quoteLicenses, submitMigrationPaymentReceipt, validateMigration };
