import { verifyPaymentIntent } from "./payment-intents.js";
import { createPaymentRpc, collectWitnesses } from './payment-rpc.js';
const MARKET_BENCHMARKS = Object.freeze([
  { id: "fiverr-website", category: "Website development", observed: "Public listings from $80–$100", source: "https://www.fiverr.com/categories/programming-tech/website-development/" },
  { id: "fiverr-logo", category: "Modern logo design", observed: "Typical $50–$60", source: "https://www.fiverr.com/categories/graphics-design/creative-logo-design/modern" },
  { id: "fiverr-writing", category: "Long-form article", observed: "Typical $71–$123; average about $90", source: "https://www.fiverr.com/categories/writing-translation/buy/articles-blogposts/long-form-article" },
  { id: "fiverr-video", category: "Video editing", observed: "Public listings from $5–$80", source: "https://www.fiverr.com/categories/video-animation/video-editing" },
  { id: "fiverr-seo", category: "SEO strategy", observed: "Typical $140–$160", source: "https://www.fiverr.com/categories/online-marketing/seo-services/seo-strategy" },
  { id: "fiverr-data", category: "Business data analysis", observed: "Entry reports about $31; general analytics average about $109", source: "https://www.fiverr.com/resources/guides/costs/business-data-analyst" },
  { id: "fiverr-va", category: "Virtual assistance", observed: "Public listings from $5–$50; broad hourly range $1–$100+", source: "https://www.fiverr.com/categories/business/virtual-assistant-services" },
  { id: "upwork-research", category: "Professional research", observed: "Literature reviews $150–$400; white papers $600–$1,500", source: "https://www.upwork.com/hire/research-paper-writers/" },
  { id: "upwork-salesforce", category: "Salesforce projects", observed: "Public fixed-price projects commonly start around $80–$300", source: "https://www.upwork.com/services/support-it/get/salesforce" },
  { id: "upwork-support", category: "Tier 1 technical support", observed: "$15–$30/hour; basic coverage $800–$2,000/month", source: "https://www.upwork.com/hire/technical-support-agents/" },
  { id: "msp-market", category: "Managed IT", observed: "Common 2026 full-service range $100–$175 per user/month", source: "https://serenitllc.com/msp-pricing-guide" },
  { id: "upwork-contracts", category: "MSA and technology contract drafting", observed: "Marketplace demand includes MSAs, SOWs, SLAs, SaaS and vendor agreements", source: "https://www.upwork.com/hire/contract-drafters/" },
  { id: "fiverr-code-review", category: "Code review", observed: "Specialized code reviews commonly begin around $40–$45, with security-focused listings spanning broader scopes", source: "https://www.fiverr.com/categories/programming-tech/qa-services/code-review" },
  { id: "upwork-security", category: "Cybersecurity services", observed: "Cybersecurity developers commonly $40–$90/hour; focused security projects commonly $500–$2,500", source: "https://www.upwork.com/resources/upwork-hourly-rates/" },
]);

const SERVICES = Object.freeze([
  { id: "sow-studio", name: "Autonomous SOW Studio", from_atomic: "49000000", category: "sow", risk: "low", modes: ["draft_only"], summary: "Requirements synthesis, assumptions, deliverables, acceptance criteria, schedule, and pricing model." },
  { id: "network-exposure-test", name: "Authorized Network Exposure Test", from_atomic: "199000000", category: "security", risk: "high", modes: ["read_only", "preapproved_safe_tests"], summary: "Passive exposure mapping and explicitly authorized non-destructive checks against named assets." },
  { id: "m365-audit", name: "Microsoft 365 Audit & Hardening", from_atomic: "249000000", category: "security", risk: "high", modes: ["audit_only", "preapproved_changes"], summary: "Tenant posture audit, evidence pack, remediation plan, and separately authorized hardening changes." },
  { id: "email-deliverability", name: "Email Deliverability Lab", from_atomic: "149000000", category: "operations", risk: "medium", modes: ["owned_domains_only"], summary: "SPF, DKIM, DMARC, DNS, reputation, content, and controlled inbox-placement testing for authorized domains." },
  { id: "trading-research", name: "Trading Research Agent", from_atomic: "99000000", category: "research", risk: "high", modes: ["research_only", "signals", "customer_authorized_execution"], summary: "Backtests, entry/exit signals, risk scenarios, and optional customer-controlled execution under explicit limits." },
  { id: "automation-build", name: "Automation Build", from_atomic: "299000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], summary: "API, data, document, support, sales, and operations workflows built and tested against acceptance criteria." },
  { id: "software-delivery", name: "Software & Agent Delivery", from_atomic: "499000000", category: "engineering", risk: "medium", modes: ["pull_request", "sandbox_deploy"], summary: "Features, integrations, applications, games, tests, documentation, and supervised deployment packages." },
  { id: "custom-application", name: "Custom Application Build", from_atomic: "499000000", category: "engineering", risk: "medium", modes: ["pull_request", "sandbox_deploy"], summary: "A scoped web, mobile, internal-tool, or API application milestone delivered with source, tests, and documentation." },
  { id: "iam-operations", name: "Authorized IAM Audit & Tasks", from_atomic: "249000000", category: "security", risk: "high", modes: ["audit_only", "preapproved_changes"], summary: "Identity inventory, least-privilege review, access-policy analysis, evidence, and explicitly approved IAM changes." },
  { id: "mcp-delivery", name: "MCP Server & Tool Delivery", from_atomic: "299000000", category: "engineering", risk: "medium", modes: ["pull_request", "sandbox_deploy"], summary: "A scoped MCP server, tool, connector, authentication flow, test suite, and deployment package." },
  { id: "n8n-workflow", name: "n8n Workflow Build", from_atomic: "199000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], summary: "One bounded n8n workflow with credential placeholders, error handling, test fixtures, and handoff documentation." },
  { id: "options-signals", name: "Options Trading Signals", from_atomic: "99000000", category: "research", risk: "high", modes: ["research_only", "signals", "customer_authorized_execution"], summary: "Rules-based options watchlists, entry and exit signals, backtests, risk scenarios, and defined invalidation criteria." },
  { id: "website-starter", name: "Website Starter", from_atomic: "99000000", category: "engineering", risk: "low", modes: ["pull_request", "sandbox_deploy"], benchmark_id: "fiverr-website", summary: "One responsive landing page or tightly scoped website milestone with source, accessibility checks, and handoff notes." },
  { id: "logo-concepts", name: "Logo Concept Pack", from_atomic: "49000000", category: "creative", risk: "low", modes: ["artifact_delivery"], benchmark_id: "fiverr-logo", summary: "Original logo directions, color and typography rationale, and export-ready source concepts with disclosed asset provenance." },
  { id: "seo-article", name: "Researched SEO Article", from_atomic: "79000000", category: "creative", risk: "low", modes: ["artifact_delivery"], benchmark_id: "fiverr-writing", summary: "One researched long-form article with outline, citations, metadata, originality review, and a defined revision round." },
  { id: "short-video-edit", name: "Short Video Edit", from_atomic: "39000000", category: "creative", risk: "low", modes: ["artifact_delivery"], benchmark_id: "fiverr-video", summary: "One short-form edit from customer-owned footage with captions, pacing, licensed audio notes, and platform-ready export." },
  { id: "technical-seo", name: "Technical SEO Audit", from_atomic: "99000000", category: "operations", risk: "low", modes: ["read_only", "preapproved_changes"], benchmark_id: "fiverr-seo", summary: "Crawl, indexing, metadata, performance, structured-data, and prioritized remediation findings for an authorized site." },
  { id: "data-analysis", name: "Data Analysis & Report", from_atomic: "79000000", category: "research", risk: "medium", modes: ["artifact_delivery"], benchmark_id: "fiverr-data", summary: "Clean an approved dataset, run a bounded analysis, and deliver reproducible tables, charts, methods, and limitations." },
  { id: "research-assistant", name: "Research & Document Assistant", from_atomic: "29000000", category: "operations", risk: "low", modes: ["artifact_delivery"], benchmark_id: "fiverr-va", summary: "Bounded public-web research, document formatting, file conversion, fact checking, or structured data cleanup." },
  { id: "professional-research", name: "Human-Grade Research Paper", from_atomic: "199000000", category: "research", risk: "medium", modes: ["artifact_delivery"], benchmark_id: "upwork-research", summary: "Original professional or organizational research with a documented method, credible sources, citations, limitations, and fact-check log; never undisclosed academic-submission ghostwriting." },
  { id: "industry-white-paper", name: "Industry White Paper", from_atomic: "699000000", category: "research", risk: "medium", modes: ["artifact_delivery"], benchmark_id: "upwork-research", summary: "A source-backed industry paper with executive summary, evidence synthesis, charts, references, and a publication-ready draft." },
  { id: "business-proposal", name: "Business Proposal Pack", from_atomic: "149000000", category: "sow", risk: "low", modes: ["draft_only"], summary: "A tailored executive proposal, solution narrative, implementation plan, assumptions, pricing table, and acceptance criteria." },
  { id: "msp-agreement-pack", name: "MSP MSA, SOW & SLA Template Pack", from_atomic: "299000000", category: "sow", risk: "medium", modes: ["draft_only"], benchmark_id: "upwork-contracts", summary: "Business-first MSA, SOW, SLA, service-catalog, escalation, and responsibility templates prepared for review by the customer's licensed attorney; not legal advice." },
  { id: "crm-quickstart", name: "CRM Quickstart Build", from_atomic: "299000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], summary: "A bounded CRM pipeline, fields, stages, views, roles, import template, basic automation, testing, and operator documentation." },
  { id: "crm-integration", name: "CRM Integration & Automation", from_atomic: "199000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], summary: "One scoped CRM-to-business-system integration with field mapping, credential placeholders, error handling, tests, and runbook." },
  { id: "salesforce-org-audit", name: "Salesforce Org Audit", from_atomic: "199000000", category: "security", risk: "medium", modes: ["audit_only"], benchmark_id: "upwork-salesforce", summary: "Configuration, permissions, automation, data quality, limits, reports, technical debt, and prioritized remediation evidence." },
  { id: "salesforce-flow", name: "Salesforce Flow Automation", from_atomic: "149000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], benchmark_id: "upwork-salesforce", summary: "Build or repair one bounded Salesforce Flow with entry conditions, fault paths, tests, deployment notes, and rollback steps." },
  { id: "salesforce-reports", name: "Salesforce Reports & Dashboard", from_atomic: "199000000", category: "research", risk: "medium", modes: ["sandbox", "preapproved_changes"], benchmark_id: "upwork-salesforce", summary: "A defined KPI model, source validation, reports, dashboard, filters, access controls, and reconciliation checks." },
  { id: "salesforce-lead-routing", name: "Salesforce Lead Routing", from_atomic: "199000000", category: "automation", risk: "medium", modes: ["sandbox", "preapproved_changes"], benchmark_id: "upwork-salesforce", summary: "Lead capture, deduplication, assignment rules or Flow, queues, SLA alerts, tests, and exception reporting." },
  { id: "salesforce-integration", name: "Salesforce Integration", from_atomic: "299000000", category: "engineering", risk: "medium", modes: ["sandbox", "preapproved_changes"], benchmark_id: "upwork-salesforce", summary: "One scoped Salesforce API integration with authentication design, mappings, idempotency, error handling, tests, and runbook." },
  { id: "salesforce-data", name: "Salesforce Data Cleanup & Migration", from_atomic: "199000000", category: "operations", risk: "high", modes: ["sandbox", "preapproved_changes"], benchmark_id: "upwork-salesforce", summary: "Profile, map, deduplicate, validate, dry-run, reconcile, and prepare an approved Salesforce data migration with rollback artifacts." },
  { id: "salesforce-lwc", name: "Salesforce LWC Component", from_atomic: "249000000", category: "engineering", risk: "medium", modes: ["pull_request", "sandbox_deploy"], benchmark_id: "upwork-salesforce", summary: "One bounded Lightning Web Component with Apex where required, access controls, tests, documentation, and deployment package." },
  { id: "msp-solution-blueprint", name: "MSP Solution Blueprint", from_atomic: "249000000", category: "security", risk: "low", modes: ["draft_only"], benchmark_id: "msp-market", summary: "A vendor-neutral managed-services architecture covering help desk, RMM, patching, identity, endpoint security, backup, escalation, metrics, and pricing assumptions." },
  { id: "tier1-support-pilot", name: "Tier 1 Support Desk Pilot", from_atomic: "499000000", category: "operations", risk: "medium", modes: ["preapproved_changes"], benchmark_id: "upwork-support", summary: "A 30-day bounded email/chat ticket pilot with approved knowledge, response macros, triage, safe runbooks, escalation boundaries, and weekly metrics; licenses and human-required coverage are separately scoped." },
  { id: "managed-intelligence", name: "Managed Intelligence Briefing", from_atomic: "499000000", category: "research", risk: "medium", modes: ["artifact_delivery"], benchmark_id: "msp-market", summary: "A 30-day monitored intelligence service for approved public sources, delivering deduplicated alerts, evidence, trend analysis, confidence labels, and an executive briefing." },
  { id: "migration-fabric", name: "MAG Migration Fabric", from_atomic: "18000000", category: "operations", risk: "high", modes: ["preauthorized_changes"], summary: "$18 per license with 500 GiB pooled capacity for checkpointed M365, Google Workspace, IMAP, Dropbox, SharePoint, and Google Drive migration. Connector availability is verified before payment." },
  { id: "managed-ops-psa", name: "White-Label RMM & PSA Workspace", from_atomic: "79000000", category: "operations", risk: "medium", modes: ["evidence_only", "preapproved_changes"], benchmark_id: "msp-market", summary: "White-label service desk, asset evidence, signed telemetry, patch and backup posture, tickets, reports, and approval-gated runbooks. Endpoint charges are disclosed separately." },
  { id: "static-scan-review", name: "Static Security Scan Review", from_atomic: "49000000", category: "security", risk: "medium", modes: ["audit_only"], benchmark_id: "fiverr-code-review", summary: "Pinned-commit static scan, human-grade finding triage, false-positive notes, and a machine-readable report for up to 2,000 lines." },
  { id: "focused-code-review", name: "Focused Secure Code Review", from_atomic: "149000000", category: "security", risk: "medium", modes: ["audit_only"], benchmark_id: "upwork-security", summary: "Static analysis plus focused manual review, CWE-mapped evidence, remediation guidance, and a reproducible verification checklist for up to 10,000 lines." },
  { id: "application-review", name: "Application Security Review", from_atomic: "499000000", category: "security", risk: "high", modes: ["audit_only", "preapproved_safe_tests"], benchmark_id: "upwork-security", summary: "Threat model, dependency and secret review, authentication and authorization analysis, prioritized evidence, and one remediation retest for a bounded application." },
  { id: "architecture-threat-model", name: "Architecture Threat Model", from_atomic: "750000000", category: "security", risk: "medium", modes: ["audit_only"], summary: "One bounded system: data flows, trust boundaries, abuse cases and a mitigation plan; up to 25,000 lines and 500 files of supporting material. Review capacity is confirmed before payment." },
  { id: "creative-production", name: "Creative Production", from_atomic: "49000000", category: "creative", risk: "low", modes: ["artifact_delivery"], summary: "Original music concepts, visual assets, copy, research briefs, presentations, and other rights-cleared digital work." },
  { id: "custom-autonomous", name: "Custom Autonomous Task", from_atomic: "99000000", category: "custom", risk: "review", modes: ["proposal_first"], summary: "Any lawful, remote, objectively verifiable task that community agents can complete without hidden human labor." },
]);

const HEX_TX = /^0x[a-fA-F0-9]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BOUNTY_CATEGORIES = new Set(["automation", "engineering", "research", "sow", "music", "art", "game-development", "operations", "security", "support"]);
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function clean(value, maximum) { return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum); }
async function sha256(value) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }
function serviceById(id) { return SERVICES.find((service) => service.id === id); }

async function createOrder(db, input) {
  const service = serviceById(clean(input.service_id, 80));
  if (!service) throw new Error("unsupported service");
  const intake = { "migration-fabric": "/migrations", "managed-ops-psa": "/ops", "static-scan-review": "/security", "focused-code-review": "/security", "application-review": "/security", "architecture-threat-model": "/security" }[service.id];
  if (intake) throw new Error(`This service requires capacity and connector preflight at ${intake}; a generic order cannot bypass that gate.`);
  const buyerName = clean(input.buyer_name, 100);
  const buyerEmail = clean(input.buyer_email, 254).toLowerCase();
  const buyerAgent = clean(input.buyer_agent_handle, 63);
  const objective = clean(input.objective, 4000);
  const acceptance = clean(input.acceptance_criteria, 4000);
  const scope = clean(input.target_scope, 3000);
  const mode = clean(input.execution_mode, 80);
  const maxBudget = String(input.max_budget_atomic || "");
  if (buyerName.length < 2 || !EMAIL.test(buyerEmail) || objective.length < 30 || acceptance.length < 30 || scope.length < 10) throw new Error("buyer, objective, acceptance criteria, and target scope are required");
  if (!service.modes.includes(mode)) throw new Error("execution mode is not allowed for this service");
  if (input.authorization_attested !== true) throw new Error("scope ownership or authorization must be attested");
  if (!/^\d+$/.test(maxBudget) || BigInt(maxBudget) < BigInt(service.from_atomic)) throw new Error("maximum budget is below the service minimum");
  if (["trading-research", "options-signals"].includes(service.id) && mode === "customer_authorized_execution" && input.customer_controls_account !== true) throw new Error("customer must control the trading account and execution limits");
  const id = crypto.randomUUID();
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  await db.prepare("INSERT INTO service_orders(id,access_token_hash,service_id,buyer_name,buyer_email,buyer_agent_handle,objective,acceptance_criteria,target_scope,authorization_attested,execution_mode,quoted_atomic,max_budget_atomic,status,created_at,updated_at,payment_binding_required) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,'awaiting_payment',?,?,1)")
    .bind(id, await sha256(accessToken), service.id, buyerName, buyerEmail, buyerAgent, objective, acceptance, scope, mode, service.from_atomic, maxBudget, now, now).run();
  await db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) VALUES(?,'order_created',?,?)").bind(id, JSON.stringify({ service_id: service.id, execution_mode: mode, quoted_atomic: service.from_atomic }), now).run();
  return { id, access_token: accessToken, service: service.name, status: "awaiting_payment", quoted_atomic: service.from_atomic, asset: "USDC", network: "Base", warning: "Save access_token now. Payment does not authorize activity outside target_scope, execution_mode, acceptance criteria, or max budget." };
}

async function authorizedOrder(db, id, token) {
  const order = await db.prepare("SELECT * FROM service_orders WHERE id=?").bind(id).first();
  if (!order || !token || await sha256(token) !== order.access_token_hash) return null;
  delete order.access_token_hash;
  return order;
}

function paymentClaimConflict(error) {
  return /(?:unique|constraint).*payment_receipt_claims|payment_receipt_claims.*(?:unique|constraint)/i.test(String(error?.message || error));
}

async function claimPaymentReceipt(db, txHash, purposeType, purposeId, statements, conditionalClaim = null) {
  const now = Date.now();
  try {
    const results = await db.batch([
      conditionalClaim || db.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) VALUES(?,?,?,?)").bind(txHash, purposeType, purposeId, now),
      ...statements,
    ]);
    const claimChange = results?.[0]?.meta?.changes;
    if (claimChange !== undefined && Number(claimChange) !== 1) throw new Error("payment receipt state changed before submission; reload and retry");
    return results;
  } catch (error) {
    if (paymentClaimConflict(error)) throw new Error("transaction hash is already claimed for another payment purpose");
    throw error;
  }
}

async function submitPaymentReceipt(db, id, token, input) {
  const order = await authorizedOrder(db, id, token);
  if (!order) throw new Error("order not found or unauthorized");
  const txHash = clean(input.tx_hash, 66).toLowerCase();
  if (!HEX_TX.test(txHash)) throw new Error("valid Base transaction hash required");
  if (order.payment_tx_hash === txHash && order.payment_status !== "unsubmitted") return { id, status: order.status, payment_status: order.payment_status };
  if (order.payment_status !== "unsubmitted") throw new Error("payment receipt already submitted");
  if (order.payment_binding_required && !await db.prepare("SELECT purpose_id FROM checkout_payment_intents WHERE purpose_type='service_order' AND purpose_id=?").bind(id).first()) throw new Error("Open wallet checkout to create an order-bound payment request first");
  const now = Date.now();
  await claimPaymentReceipt(db, txHash, "service_order", id, [
    db.prepare("UPDATE service_orders SET payment_tx_hash=?,payment_status='pending_verification',status='payment_review',updated_at=? WHERE id=? AND payment_status='unsubmitted'").bind(txHash, now, id),
    db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) SELECT ?,'payment_receipt_submitted',?,? WHERE EXISTS (SELECT 1 FROM service_orders WHERE id=? AND payment_tx_hash=? AND payment_status='pending_verification')").bind(id, JSON.stringify({ tx_hash: txHash }), now, id, txHash),
  ], db.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) SELECT ?,'service_order',?,? WHERE EXISTS (SELECT 1 FROM service_orders WHERE id=? AND payment_status='unsubmitted')").bind(txHash, id, now, id));
  return { id, status: "payment_review", payment_status: "pending_verification" };
}

async function createBountyRequest(db, input) {
  const requesterName = clean(input.requester_name, 100);
  const requesterEmail = clean(input.requester_email, 254).toLowerCase();
  const title = clean(input.title, 160);
  const description = clean(input.description, 8000);
  const acceptance = clean(input.acceptance_criteria, 4000);
  const category = clean(input.category, 40).toLowerCase();
  const reward = String(input.reward_atomic || "");
  const expiresAt = Number(input.expires_at);
  if (requesterName.length < 2 || !EMAIL.test(requesterEmail)) throw new Error("valid requester name and email required");
  if (title.length < 8 || description.length < 30 || acceptance.length < 30) throw new Error("clear title, description, and objective acceptance criteria required");
  if (!BOUNTY_CATEGORIES.has(category)) throw new Error("unsupported category");
  if (!/^\d+$/.test(reward) || BigInt(reward) < 5000000n) throw new Error("custom bounty must be at least 5 USDC");
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) + 86400) throw new Error("expiry must be at least one day away");
  if (input.authorization_attested !== true) throw new Error("lawful scope and authorization must be attested");
  const id = crypto.randomUUID();
  const accessToken = crypto.randomUUID() + crypto.randomUUID();
  const now = Date.now();
  await db.prepare("INSERT INTO bounty_requests(id,access_token_hash,requester_name,requester_email,title,description,acceptance_criteria,category,reward_atomic,authorization_attested,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)")
    .bind(id, await sha256(accessToken), requesterName, requesterEmail, title, description, acceptance, category, reward, expiresAt, now, now).run();
  return { id, access_token: accessToken, status: "awaiting_payment", reward_atomic: reward, platform_fee_bps: 1500, worker_payout_atomic: (BigInt(reward) * 8500n / 10000n).toString(), warning: "Save access_token. Funding does not publish the bounty; MAG reviews authorization, safety, and objective verifiability first." };
}

async function authorizedBounty(db, id, token) {
  const bounty = await db.prepare("SELECT * FROM bounty_requests WHERE id=?").bind(id).first();
  if (!bounty || !token || await sha256(token) !== bounty.access_token_hash) return null;
  delete bounty.access_token_hash;
  return bounty;
}

async function submitBountyPaymentReceipt(db, id, token, input) {
  const bounty = await authorizedBounty(db, id, token);
  if (!bounty) throw new Error("bounty not found or unauthorized");
  const txHash = clean(input.tx_hash, 66).toLowerCase();
  if (!HEX_TX.test(txHash)) throw new Error("valid Base transaction hash required");
  if (bounty.payment_status !== "unsubmitted") throw new Error("payment receipt already submitted");
  await claimPaymentReceipt(db, txHash, "bounty", id, [
    db.prepare("UPDATE bounty_requests SET payment_tx_hash=?,payment_status='pending_verification',status='payment_review',updated_at=? WHERE id=? AND payment_status='unsubmitted'").bind(txHash, Date.now(), id),
  ], db.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) SELECT ?,'bounty',?,? WHERE EXISTS (SELECT 1 FROM bounty_requests WHERE id=? AND payment_status='unsubmitted')").bind(txHash, id, Date.now(), id));
  return { id, status: "payment_review", payment_status: "pending_verification" };
}

function paidExactly(receipt, treasury, atomic) {
  const recipientTopic = `0x${treasury.toLowerCase().slice(2).padStart(64, "0")}`;
  return (receipt.logs || []).some((log) => log.address?.toLowerCase() === BASE_USDC
    && log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC
    && log.topics?.[2]?.toLowerCase() === recipientTopic
    && BigInt(log.data || "0x0") === BigInt(atomic));
}

async function verifyBaseUsdcTransfer(txHash, treasury, atomic, fetcher = fetch, minimumConfirmations = 12n, env = {}) {
  if (!HEX_TX.test(String(txHash || "")) || !/^0x[a-fA-F0-9]{40}$/.test(String(treasury || "")) || !/^\d+$/.test(String(atomic || ""))) return { verified: false, reason: "invalid_payment_identity" };
  const client = createPaymentRpc(env,fetcher);
  const observations = await collectWitnesses(client, async (_,index) => {
    const chain=await client.request(index,'eth_chainId');
    if(chain!=='0x2105')return {receipt:null,wrongChain:true};
    return {receipt:await client.request(index,'eth_getTransactionReceipt',[txHash]),head:await client.request(index,'eth_blockNumber',[])};
  });
  if(observations.some(o=>o.wrongChain))return {verified:false,reason:'wrong_chain'};
  if (observations.some(({ receipt }) => !receipt)) return { verified: false, reason: "receipt_not_found" };
  const [first, second] = observations;
  if (first.receipt.blockHash !== second.receipt.blockHash || observations.some(({ receipt }) => receipt.status !== "0x1")) return { verified: false, reason: "rpc_disagreement_or_failed_transaction" };
  const block = BigInt(first.receipt.blockNumber);
  const confirmations = observations.map(({ head }) => BigInt(head) - block);
  if (confirmations.some((count) => count < minimumConfirmations)) return { verified: false, reason: "insufficient_confirmations", confirmations: confirmations.map(String) };
  if (!observations.every(({ receipt }) => paidExactly(receipt, treasury, atomic))) return { verified: false, reason: "exact_transfer_not_found" };
  return { verified: true, confirmations: confirmations.map(String), independent_rpc_observations: observations.length, block_number: block.toString() };
}

async function processPendingOrders(env, fetcher = fetch) {
  if (!env.DB || !/^0x[a-fA-F0-9]{40}$/.test(env.TREASURY_WALLET_ADDRESS || "")) return { configured: false, checked: 0, verified: 0 };
  const pending = await env.DB.prepare("SELECT service_orders.id,service_orders.payment_binding_required,service_orders.service_id,service_orders.objective,service_orders.acceptance_criteria,service_orders.target_scope,service_orders.execution_mode,service_orders.quoted_atomic,service_orders.payment_tx_hash FROM service_orders JOIN payment_receipt_claims ON payment_receipt_claims.tx_hash=service_orders.payment_tx_hash AND payment_receipt_claims.purpose_type='service_order' AND payment_receipt_claims.purpose_id=service_orders.id WHERE service_orders.payment_status='pending_verification' AND service_orders.published_task_id IS NULL ORDER BY service_orders.updated_at LIMIT 10").all();
  let verified = 0;
  for (const order of pending.results || []) {
    try {
      const intent = order.payment_binding_required ? await env.DB.prepare("SELECT * FROM checkout_payment_intents WHERE purpose_type='service_order' AND purpose_id=?").bind(order.id).first() : null;
      const payment = order.payment_binding_required ? await verifyPaymentIntent(intent,order.payment_tx_hash,fetcher,env) : await verifyBaseUsdcTransfer(order.payment_tx_hash, env.TREASURY_WALLET_ADDRESS, order.quoted_atomic, fetcher,12n,env);
      if (!payment.verified) continue;
      const service = serviceById(order.service_id);
      if (!service) throw new Error("verified order references an unsupported service");
      const now = Date.now();
      const expiresAt = Math.floor(now / 1000) + 30 * 24 * 60 * 60;
      const description = `Objective:\n${order.objective}\n\nAuthorized target scope:\n${order.target_scope}\n\nExecution mode: ${order.execution_mode}`;
      const gross = BigInt(order.quoted_atomic);
      const platformFee = gross * 1500n / 10000n;
      const economics = {
        gross_atomic: gross.toString(),
        platform_fee_atomic: platformFee.toString(),
        worker_payout_atomic: (gross - platformFee).toString(),
        platform_fee_bps: 1500,
      };
      const results = await env.DB.batch([
        env.DB.prepare("INSERT INTO tasks(title,description,acceptance_criteria,category,reward_atomic,platform_fee_bps,status,fulfillment_mode,created_at,expires_at) SELECT ?,?,?,?,quoted_atomic,1500,'open','digital',?,? FROM service_orders WHERE id=? AND payment_status='pending_verification' AND published_task_id IS NULL")
          .bind(service.name, description, order.acceptance_criteria, service.category, now, expiresAt, order.id),
        env.DB.prepare("UPDATE service_orders SET payment_status='verified',status='open',assigned_agent=NULL,published_task_id=last_insert_rowid(),updated_at=? WHERE id=? AND payment_status='pending_verification' AND published_task_id IS NULL AND EXISTS (SELECT 1 FROM tasks WHERE id=last_insert_rowid() AND created_at=?)")
          .bind(now, order.id, now),
        env.DB.prepare("INSERT INTO order_events(order_id,kind,details,created_at) SELECT id,'payment_verified_and_task_published',?,? FROM service_orders WHERE id=? AND payment_status='verified' AND published_task_id=last_insert_rowid()")
          .bind(JSON.stringify({ tx_hash: order.payment_tx_hash, ...payment, economics, payout_authority: "owner_signature_required" }), now, order.id),
      ]);
      if (Number(results?.[1]?.meta?.changes || 0) === 1) verified += 1;
    } catch (error) {
      console.warn(JSON.stringify({ event: "order_payment_verification_deferred", order_id: order.id, message: String(error.message || error) }));
    }
  }
  return { configured: true, checked: (pending.results || []).length, verified };
}

async function processPendingBounties(env, fetcher = fetch) {
  if (!env.DB || !/^0x[a-fA-F0-9]{40}$/.test(env.TREASURY_WALLET_ADDRESS || "")) return { configured: false, checked: 0, verified: 0 };
  const pending = await env.DB.prepare("SELECT b.id,b.reward_atomic,b.payment_tx_hash FROM bounty_requests b JOIN payment_receipt_claims f ON f.tx_hash=b.payment_tx_hash AND f.purpose_type='bounty' AND f.purpose_id=b.id WHERE b.payment_status='pending_verification' ORDER BY b.updated_at LIMIT 10").all();
  let verified = 0;
  for (const bounty of pending.results || []) {
    try {
      const payment = await verifyBaseUsdcTransfer(bounty.payment_tx_hash,env.TREASURY_WALLET_ADDRESS,bounty.reward_atomic,fetcher,12n,env);
      if (!payment.verified) continue;
      await env.DB.prepare("UPDATE bounty_requests SET payment_status='verified',status='ready_for_review',updated_at=? WHERE id=? AND payment_status='pending_verification'").bind(Date.now(), bounty.id).run();
      verified += 1;
    } catch (error) { console.warn(JSON.stringify({ event: "bounty_payment_verification_deferred", bounty_id: bounty.id, message: String(error.message || error) })); }
  }
  return { configured: true, checked: (pending.results || []).length, verified };
}

async function approveBounty(db, id, reviewNote = "") {
  const bounty = await db.prepare("SELECT * FROM bounty_requests WHERE id=?").bind(id).first();
  if (!bounty || bounty.status !== "ready_for_review" || bounty.payment_status !== "verified") throw new Error("verified bounty is not ready for review");
  const now = Date.now();
  if (clean(reviewNote,1000).length < 20) throw new Error("a scope and acceptance review note is required");
  const results = await db.batch([
    db.prepare("INSERT INTO tasks(title,description,acceptance_criteria,category,reward_atomic,platform_fee_bps,status,fulfillment_mode,created_at,expires_at) SELECT title,description,acceptance_criteria,category,reward_atomic,1500,'open','digital',?,expires_at FROM bounty_requests b WHERE id=? AND status='ready_for_review' AND payment_status='verified' AND authorization_attested=1 AND published_task_id IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM payment_receipt_claims f WHERE f.tx_hash=b.payment_tx_hash AND f.purpose_type='bounty' AND f.purpose_id=b.id) RETURNING id").bind(now,id,Math.floor(now/1000)),
    db.prepare("UPDATE bounty_requests SET status='published',published_task_id=last_insert_rowid(),review_note=?,updated_at=? WHERE id=? AND status='ready_for_review' AND published_task_id IS NULL AND changes()=1").bind(clean(reviewNote,1000),now,id),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) SELECT CASE WHEN changes()=1 THEN 'custom_bounty_published' END,'operator','task',CAST(published_task_id AS TEXT),?,? FROM bounty_requests WHERE id=?").bind(JSON.stringify({bounty_request_id:id,funding_verified:true}),now,id),
  ]);
  if (Number(results[1]?.meta?.changes) !== 1) throw new Error("bounty state changed before publication");
  return { id, status: "published", task_id: results[0]?.results?.[0]?.id };
}

async function reviewOperationsLoop(env) {
  if (!env.DB) return { configured: false };
  const windowStart = Math.floor(Date.now() / 900000) * 900000;
  const counts = {};
  for (const [key, sql] of Object.entries({ pending_bounties: "SELECT COUNT(*) n FROM bounty_requests WHERE status IN ('payment_review','ready_for_review')", open_tasks: "SELECT COUNT(*) n FROM tasks WHERE status='open'", new_inbox: "SELECT COUNT(*) n FROM community_inbox WHERE status='new'", pending_members: "SELECT COUNT(*) n FROM guild_applications WHERE status='pending'" })) counts[key] = Number((await env.DB.prepare(sql).first())?.n || 0);
  const signalKind = Object.values(counts).some(Boolean) ? "operational_signal" : "no_new_signal";
  const observation = {
    measurements: counts,
    interpretation: {
      kind: signalKind,
      rule: "operational_signal iff any measured queue count is greater than zero",
    },
  };
  await env.DB.prepare("INSERT OR IGNORE INTO operations_observations(window_start,signal_kind,details,created_at) VALUES(?,?,?,?)").bind(windowStart, signalKind, JSON.stringify(observation), Date.now()).run();
  return { configured: true, signal_kind: signalKind, ...observation };
}

export { MARKET_BENCHMARKS, SERVICES, approveBounty, authorizedBounty, authorizedOrder, claimPaymentReceipt, createBountyRequest, createOrder, processPendingBounties, processPendingOrders, reviewOperationsLoop, serviceById, submitBountyPaymentReceipt, submitPaymentReceipt, verifyBaseUsdcTransfer };
