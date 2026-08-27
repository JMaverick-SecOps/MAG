const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPOSITORY_URL = /^https:\/\/[a-z0-9.-]+\/[a-z0-9_.~-]+\/[a-z0-9_.~-]+(?:\.git)?$/i;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const TIERS = Object.freeze([
  { id: "static-scan-review", name: "Static Scan Review", price_atomic: "49000000", price: "$49 USDC", limits: "Up to 2,000 lines", deliverables: ["pinned-commit scan", "triaged findings", "false-positive notes", "machine-readable report"] },
  { id: "focused-code-review", name: "Focused Secure Code Review", price_atomic: "149000000", price: "$149 USDC", limits: "Up to 10,000 lines", deliverables: ["static analysis", "manual attack-surface review", "CWE-mapped evidence", "remediation guidance", "verification checklist"] },
  { id: "application-review", name: "Application Security Review", price_atomic: "499000000", price: "$499 USDC", limits: "Up to 50,000 lines, one application", deliverables: ["threat model", "dependency and secret review", "auth and authorization review", "prioritized report", "remediation retest"] },
  { id: "architecture-threat-model", name: "Architecture Threat Model", price_atomic: "750000000", price: "$750 USDC", limits: "One bounded system", deliverables: ["data-flow model", "trust boundaries", "abuse cases", "control gaps", "mitigation plan"] },
]);

function clean(value, maximum) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

function tierById(id) {
  return TIERS.find((tier) => tier.id === clean(id, 60));
}

function validateSecurityReview(input) {
  const tier = tierById(input.tier_id);
  const organization = clean(input.organization, 140);
  const contactEmail = clean(input.contact_email, 254).toLowerCase();
  const repositoryUrl = clean(input.repository_url, 500);
  const commitSha = clean(input.commit_sha, 64).toLowerCase();
  const branchContext = clean(input.branch_context, 160);
  const scopePaths = [...new Set((Array.isArray(input.scope_paths) ? input.scope_paths : [])
    .map((path) => clean(path, 300).replace(/\\/g, "/"))
    .filter((path) => path && !path.startsWith("/") && !path.includes("../")))].slice(0, 100);
  if (!tier || organization.length < 2 || !EMAIL.test(contactEmail)) throw new Error("valid tier, organization, and contact email are required");
  if (!REPOSITORY_URL.test(repositoryUrl) || !COMMIT.test(commitSha)) throw new Error("an HTTPS repository URL and exact 40- or 64-character commit digest are required");
  if (!scopePaths.length) throw new Error("at least one repository-relative scope path is required");
  if (input.authorization_attested !== true || input.repository_license_attested !== true || input.safe_testing_consent !== true) throw new Error("scope authorization, repository rights, and safe-testing consent are required");
  return { tier, organization, contactEmail, repositoryUrl, commitSha, branchContext, scopePaths };
}

async function sha256(value) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createSecurityReview(db, input) {
  const review = validateSecurityReview(input);
  const id = crypto.randomUUID();
  const accessToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const now = Date.now();
  await db.prepare("INSERT INTO security_reviews(id,access_token_hash,tier_id,organization,contact_email,repository_url,commit_sha,branch_context,scope_paths_json,authorization_attested,repository_license_attested,safe_testing_consent,quoted_atomic,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,1,?,'awaiting_payment',?,?)")
    .bind(id, await sha256(accessToken), review.tier.id, review.organization, review.contactEmail, review.repositoryUrl, review.commitSha, review.branchContext, JSON.stringify(review.scopePaths), review.tier.price_atomic, now, now).run();
  await db.prepare("INSERT INTO security_review_events(review_id,kind,details,created_at) VALUES(?,'review_created',?,?)")
    .bind(id, JSON.stringify({ tier_id: review.tier.id, repository_url: review.repositoryUrl, commit_sha: review.commitSha, scope_paths: review.scopePaths, static_only: true }), now).run();
  return { id, access_token: accessToken, status: "awaiting_payment", quote: { amount_atomic: review.tier.price_atomic, asset: "USDC", network: "Base" }, pinned_commit: review.commitSha, warning: "Save access_token. Never send repository passwords, access tokens, SSH keys, cookies, signing keys, production data, or other secrets to this API." };
}

async function authorizedSecurityReview(db, id, token) {
  if (!token) return null;
  const row = await db.prepare("SELECT * FROM security_reviews WHERE id=?").bind(id).first();
  if (!row || await sha256(token) !== row.access_token_hash) return null;
  delete row.access_token_hash;
  row.scope_paths = JSON.parse(row.scope_paths_json || "[]");
  delete row.scope_paths_json;
  return row;
}

function securityReviewManifest() {
  return {
    product: "MAG Security Evidence Lab",
    maturity: "intake_and_review_pipeline",
    pricing_basis: "Entry pricing is positioned against public marketplace code-review and security-professional ranges observed 2026-08-26; scope and limits are disclosed per tier.",
    tiers: TIERS,
    report_schema: ["finding id", "severity", "confidence", "CWE", "pinned commit", "repository-relative location", "evidence", "impact", "remediation", "verification method"],
    safety: ["exact commit pinning", "authorized scope only", "static analysis by default", "untrusted code is never executed on the Worker", "isolated disposable analysis workspace", "no credential intake", "no destructive testing", "human-readable evidence and falsifiers"],
    honesty: "The production Worker currently provides priced intake, immutable scope pinning, audit events, and report records. Analysis workers and supported scanner adapters must be configured before a review enters running state.",
    api: { catalog: "GET /api/security-reviews", create: "POST /api/security-reviews", review: "GET /api/security-reviews/:id" },
  };
}

function securityReviewPage() {
  const cards = TIERS.map((tier) => `<article><h2>${tier.name}</h2><b>${tier.price}</b><p>${tier.limits}</p><ul>${tier.deliverables.map((item) => `<li>${item}</li>`).join("")}</ul></article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG Security Evidence Lab</title><style>body{max-width:1180px;margin:5vh auto;padding:0 22px;background:#061a33;color:#eaf7ff;font:16px/1.55 system-ui}a{color:#11d8ed}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:15px}article{background:#071d35;border:1px solid #28516f;border-radius:16px;padding:20px}b{color:#f6c653;font-size:1.35rem}.note{color:#9eb6c9}@media(max-width:920px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.grid{grid-template-columns:1fr}}</style></head><body><a href="/">← MAG</a><h1>Security Evidence Lab</h1><p>Fairly priced, authorization-gated reviews pinned to an exact commit. Findings include reproducible evidence, confidence, CWE mapping, remediation, and a verification method.</p><section class="grid">${cards}</section><p class="note">Static and review-only by default. MAG never executes submitted code on the production Worker and does not accept repository credentials through this API.</p></body></html>`;
}

export { TIERS, authorizedSecurityReview, createSecurityReview, securityReviewManifest, securityReviewPage, tierById, validateSecurityReview };
