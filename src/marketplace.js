const HANDLE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const SAFE_URL = /^https:\/\//i;
const CATEGORIES = new Set(["automation", "engineering", "research", "sow", "music", "art", "game-development", "operations"]);
const DEFAULT_FEE_BPS = 1500;
const MAX_FEE_BPS = 2500;

function b64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function activeKeys(record) {
  return Array.isArray(record.keys) ? record.keys.filter((key) => key.status === "active") : [];
}

function validateTask(input) {
  const title = String(input.title || "").trim();
  const description = String(input.description || "").trim();
  const acceptance = String(input.acceptance_criteria || "").trim();
  const category = String(input.category || "").trim().toLowerCase();
  const reward = String(input.reward_atomic || "");
  const expiresAt = Number(input.expires_at);
  const fee = Number(input.platform_fee_bps ?? DEFAULT_FEE_BPS);
  if (title.length < 8 || title.length > 160) throw new Error("title must be 8-160 characters");
  if (description.length < 20 || description.length > 8000) throw new Error("description must be 20-8000 characters");
  if (acceptance.length < 20 || acceptance.length > 4000) throw new Error("objective acceptance criteria are required");
  if (!CATEGORIES.has(category)) throw new Error("unsupported category");
  if (!/^\d+$/.test(reward) || BigInt(reward) < 100000n) throw new Error("reward must be at least 0.10 USDC");
  if (!Number.isInteger(fee) || fee < 0 || fee > MAX_FEE_BPS) throw new Error("platform fee must be 0-25%");
  if (!Number.isInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) + 3600) throw new Error("expiry must be at least one hour away");
  return { title, description, acceptance, category, reward, expiresAt, fee };
}

function payoutBreakdown(rewardAtomic, feeBps) {
  const gross = BigInt(rewardAtomic);
  const fee = gross * BigInt(feeBps) / 10000n;
  return { gross_atomic: gross.toString(), platform_fee_atomic: fee.toString(), worker_payout_atomic: (gross - fee).toString() };
}

function submissionPreimage({ taskId, handle, artifact, signedAt }) {
  return "mavverick.submit.v1:" + taskId + ":" + handle + ":" + artifact + ":" + signedAt;
}

function claimPreimage({ taskId, handle, signedAt }) {
  return "mavverick.claim.v1:" + taskId + ":" + handle + ":" + signedAt;
}

async function verifyClaim(input, fetcher = fetch, now = Date.now()) {
  const handle = String(input.handle || "").toLowerCase();
  const signedAt = Number(input.signed_at);
  if (!HANDLE.test(handle)) throw new Error("invalid 1F916 handle");
  if (!Number.isInteger(signedAt) || Math.abs(now - signedAt) > 5 * 60_000) throw new Error("signature timestamp outside five-minute window");
  const response = await fetcher("https://1f916.ai/api/keys/" + encodeURIComponent(handle), { method: "GET", redirect: "manual", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("unable to verify 1F916 identity");
  const record = await response.json();
  const signature = b64url(String(input.signature || ""));
  const message = new TextEncoder().encode(claimPreimage({ taskId: input.task_id, handle, signedAt }));
  for (const key of activeKeys(record)) {
    try { const publicKey = await crypto.subtle.importKey("raw", b64url(key.public_key || key.x), { name: "Ed25519" }, false, ["verify"]); if (await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)) return { handle, signedAt, custodyClaim: key.custody || "undeclared" }; } catch {}
  }
  throw new Error("invalid agent signature");
}

async function claimTask(db, taskId, input, fetcher = fetch) {
  const verified = await verifyClaim({ ...input, task_id: taskId }, fetcher);
  const member = await db.prepare("SELECT handle FROM guild_applications WHERE handle=? AND status='active'").bind(verified.handle).first();
  if (!member) throw new Error("active MAG membership required");
  const task = await db.prepare("SELECT id,status,expires_at FROM tasks WHERE id=?").bind(taskId).first();
  if (!task || task.status !== "open" || task.expires_at <= Math.floor(Date.now() / 1000)) throw new Error("task is not available");
  const now = Date.now();
  const results = await db.batch([
    db.prepare("INSERT INTO task_claims(task_id,agent_handle,signed_at,signature,claimed_at,updated_at) SELECT ?,?,?,?,?,? FROM tasks WHERE id=? AND status='open' AND expires_at>?").bind(taskId, verified.handle, verified.signedAt, input.signature, now, now, taskId, Math.floor(now / 1000)),
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=? AND status='open' AND EXISTS (SELECT 1 FROM task_claims WHERE task_id=? AND agent_handle=? AND signed_at=? AND claimed_at=?)").bind(taskId, taskId, verified.handle, verified.signedAt, now),
    db.prepare("UPDATE service_orders SET status='in_progress',assigned_agent=?,claimed_at=?,updated_at=? WHERE published_task_id=? AND status='open' AND EXISTS (SELECT 1 FROM task_claims WHERE task_id=? AND agent_handle=? AND signed_at=? AND claimed_at=?)").bind(verified.handle, now, now, taskId, taskId, verified.handle, verified.signedAt, now),
    db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) SELECT id,'task_claimed',?,? FROM service_orders WHERE published_task_id=? AND status='in_progress' AND assigned_agent=? AND claimed_at=?").bind(JSON.stringify({ task_id: taskId, agent_handle: verified.handle, signed_at: verified.signedAt }), now, taskId, verified.handle, now),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) SELECT 'task_claimed',?,'task',?,?,? WHERE EXISTS (SELECT 1 FROM task_claims WHERE task_id=? AND agent_handle=? AND signed_at=? AND claimed_at=?)").bind(verified.handle, String(taskId), JSON.stringify({ signed_at: verified.signedAt, custody_claim: verified.custodyClaim, custody_is_testimony: true }), now, taskId, verified.handle, verified.signedAt, now),
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1) throw new Error("task is not available");
  return { task_id: taskId, agent_handle: verified.handle, status: "in_progress" };
}

async function verifyAgentSubmission(input, fetcher = fetch, now = Date.now()) {
  const handle = String(input.handle || "").toLowerCase();
  const artifact = String(input.artifact || "").trim();
  const signedAt = Number(input.signed_at);
  if (!HANDLE.test(handle)) throw new Error("invalid 1F916 handle");
  if (!SAFE_URL.test(artifact) || artifact.length > 1000) throw new Error("artifact must be an HTTPS URL");
  if (!Number.isInteger(signedAt) || Math.abs(now - signedAt) > 5 * 60_000) throw new Error("signature timestamp outside five-minute window");
  const response = await fetcher("https://1f916.ai/api/keys/" + encodeURIComponent(handle), { method: "GET", redirect: "manual", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("unable to verify 1F916 identity");
  const record = await response.json();
  const keys = activeKeys(record);
  const signature = b64url(String(input.signature || ""));
  const message = new TextEncoder().encode(submissionPreimage({ taskId: input.task_id, handle, artifact, signedAt }));
  for (const key of keys) {
    try {
      const publicKey = await crypto.subtle.importKey("raw", b64url(key.public_key || key.x), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)) return { handle, artifact, signedAt, custodyClaim: key.custody || "undeclared" };
    } catch {}
  }
  throw new Error("invalid agent signature");
}

async function listTasks(db) {
  const result = await db.prepare("SELECT t.id,t.title,t.description,t.acceptance_criteria,t.category,t.reward_atomic,t.platform_fee_bps,t.fulfillment_mode,t.status,t.expires_at,c.agent_handle AS claimed_by FROM tasks t LEFT JOIN task_claims c ON c.task_id=t.id AND c.status='active' WHERE t.status IN ('open','in_progress','review') AND t.expires_at>? ORDER BY t.id DESC LIMIT 100").bind(Math.floor(Date.now() / 1000)).all();
  return result.results.map((task) => ({ ...task, payout: payoutBreakdown(task.reward_atomic, task.platform_fee_bps) }));
}

async function createTask(db, input) {
  const task = validateTask(input);
  const now = Date.now();
  const result = await db.prepare("INSERT INTO tasks(title,description,acceptance_criteria,category,reward_atomic,platform_fee_bps,status,fulfillment_mode,created_at,expires_at) VALUES(?,?,?,?,?,?,'draft','digital',?,?) RETURNING id")
    .bind(task.title, task.description, task.acceptance, task.category, task.reward, task.fee, now, task.expiresAt).first();
  await db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) VALUES('task_created','operator','task',?,?,?)")
    .bind(String(result.id), JSON.stringify({ status: "draft", payout: payoutBreakdown(task.reward, task.fee) }), now).run();
  return { id: result.id, status: "draft", payout: payoutBreakdown(task.reward, task.fee) };
}

async function submitWork(db, taskId, input, fetcher = fetch) {
  const verified = await verifyAgentSubmission({ ...input, task_id: taskId }, fetcher);
  const task = await db.prepare("SELECT id,status,expires_at FROM tasks WHERE id=?").bind(taskId).first();
  if (!task || !new Set(["open", "in_progress"]).has(task.status) || task.expires_at <= Math.floor(Date.now() / 1000)) throw new Error("task is not accepting work");
  const claim = await db.prepare("SELECT agent_handle FROM task_claims WHERE task_id=? AND status='active'").bind(taskId).first();
  if (!claim || claim.agent_handle !== verified.handle) throw new Error("an active signed claim by this agent is required before submission");
  const note = String(input.note || "").trim().slice(0, 2000);
  const now = Date.now();
  const results = await db.batch([
    db.prepare("INSERT INTO submissions(task_id,agent_handle,artifact,note,signed_at,signature,created_at) SELECT ?,?,?,?,?,?,? FROM tasks WHERE id=? AND status='in_progress' AND expires_at>? AND EXISTS (SELECT 1 FROM task_claims c JOIN guild_applications m ON m.handle=c.agent_handle AND m.status='active' WHERE c.task_id=tasks.id AND c.status='active' AND c.agent_handle=?) RETURNING id")
      .bind(taskId, verified.handle, verified.artifact, note, verified.signedAt, input.signature, now, taskId, Math.floor(now / 1000), verified.handle),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) VALUES(CASE WHEN changes()=1 THEN 'submission_authorized' ELSE NULL END,?,'task',?,'{}',?)").bind(verified.handle, String(taskId), now),
    db.prepare("UPDATE tasks SET status='review' WHERE id=? AND status IN ('open','in_progress') AND EXISTS (SELECT 1 FROM submissions WHERE task_id=? AND agent_handle=? AND artifact=? AND created_at=?)").bind(taskId, taskId, verified.handle, verified.artifact, now),
    db.prepare("UPDATE service_orders SET status='review',assigned_agent=?,delivery_submission_id=(SELECT id FROM submissions WHERE task_id=? AND agent_handle=? AND artifact=? AND created_at=?),delivery_artifact=?,delivered_at=?,updated_at=? WHERE published_task_id=? AND status IN ('open','in_progress') AND EXISTS (SELECT 1 FROM submissions WHERE task_id=? AND agent_handle=? AND artifact=? AND created_at=?)")
      .bind(verified.handle, taskId, verified.handle, verified.artifact, now, verified.artifact, now, now, taskId, taskId, verified.handle, verified.artifact, now),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) SELECT 'work_submitted',?,'submission',CAST(id AS TEXT),?,? FROM submissions WHERE task_id=? AND agent_handle=? AND artifact=? AND created_at=?")
      .bind(verified.handle, JSON.stringify({ task_id: taskId, artifact: verified.artifact, custody_claim: verified.custodyClaim, custody_is_testimony: true }), now, taskId, verified.handle, verified.artifact, now),
    db.prepare("INSERT INTO order_events(order_id,kind,details,created_at) SELECT id,'delivery_submitted',?,? FROM service_orders WHERE published_task_id=? AND status='review' AND delivery_submission_id=(SELECT id FROM submissions WHERE task_id=? AND agent_handle=? AND artifact=? AND created_at=?)")
      .bind(JSON.stringify({ task_id: taskId, artifact: verified.artifact, agent_handle: verified.handle }), now, taskId, taskId, verified.handle, verified.artifact, now),
  ]);
  const id = results?.[0]?.results?.[0]?.id ?? results?.[0]?.meta?.last_row_id;
  if (id === undefined || id === null) throw new Error("submission was not persisted");
  return { id, task_id: taskId, agent_handle: verified.handle, status: "review" };
}

function validateAcceptance(input = {}) {
  const record = input && typeof input === "object" ? input : {};
  const verificationSummary = String(record.verification_summary || "").trim();
  const evidenceUrl = String(record.evidence_url || "").trim();
  if (verificationSummary.length < 20 || verificationSummary.length > 4000) throw new Error("verification_summary must be 20-4000 characters");
  if (evidenceUrl.length > 1000) throw new Error("evidence_url must be an HTTPS URL of at most 1000 characters");
  let parsedEvidenceUrl;
  try { parsedEvidenceUrl = new URL(evidenceUrl); } catch { throw new Error("evidence_url must be an HTTPS URL"); }
  if (parsedEvidenceUrl.protocol !== "https:" || !parsedEvidenceUrl.hostname || parsedEvidenceUrl.username || parsedEvidenceUrl.password) throw new Error("evidence_url must be an HTTPS URL without embedded credentials");
  return { verificationSummary, evidenceUrl: parsedEvidenceUrl.href };
}

const VERIFIED_ORDER_FUNDING = `(
  (o.payment_provider='base_usdc_direct' AND EXISTS (
    SELECT 1 FROM payment_receipt_claims funding
    WHERE funding.tx_hash=o.payment_tx_hash AND funding.purpose_type='service_order' AND funding.purpose_id=o.id
  )) OR (o.payment_provider='saturnshift' AND EXISTS (
    SELECT 1 FROM payment_provider_receipt_claims funding
    JOIN payment_provider_events e ON e.provider=funding.provider AND e.event_id=funding.event_id
    WHERE funding.provider='saturnshift' AND funding.payment_id=o.provider_payment_id
      AND funding.purpose_type='service_order' AND funding.purpose_id=o.id
      AND e.order_id=o.id AND e.payment_id=o.provider_payment_id
      AND e.event_id=o.provider_verification_event_id AND e.processing_status='applied'
      AND json_extract(e.details,'$.settlement_asset')='USDC'
      AND lower(json_extract(e.details,'$.settlement_network'))='base'
      AND json_extract(e.details,'$.amount_atomic')=o.quoted_atomic
      AND json_extract(e.details,'$.external_reference')=o.id
      AND json_extract(e.details,'$.idempotency_key')=o.id
  ))
)`;

async function readAcceptanceState(db, submissionId) {
  return db.prepare(`SELECT
      s.id,s.task_id,s.agent_handle,s.artifact,s.status AS submission_status,
      t.title,t.status AS task_status,t.reward_atomic,t.platform_fee_bps,
      o.id AS order_id,o.status AS order_status,o.payment_status,o.payment_tx_hash,o.authorization_attested,o.quoted_atomic,
      ${VERIFIED_ORDER_FUNDING} AS funding_verified,
      o.assigned_agent,o.delivery_submission_id,o.delivery_artifact,o.delivered_at,o.accepted_at,
      r.id AS acceptance_receipt_id,r.task_id AS receipt_task_id,r.submission_id AS receipt_submission_id,
      r.verifier,r.verification_summary,r.evidence_url,
      p.id AS payout_proposal_id,p.task_id AS payout_task_id,p.submission_id AS payout_submission_id,
      p.agent_handle AS payout_agent_handle,p.gross_atomic,p.platform_fee_atomic,p.worker_payout_atomic,
      p.asset AS payout_asset,p.network AS payout_network,p.status AS payout_status,
      EXISTS(SELECT 1 FROM task_acceptance_receipts conflicting_receipt WHERE conflicting_receipt.task_id=t.id AND conflicting_receipt.submission_id<>s.id) AS receipt_conflict,
      EXISTS(SELECT 1 FROM payout_proposals conflicting_proposal WHERE conflicting_proposal.task_id=t.id AND conflicting_proposal.submission_id<>s.id) AS payout_conflict,
      EXISTS(SELECT 1 FROM order_events event WHERE event.order_id=o.id AND event.kind='delivery_accepted'
        AND CAST(json_extract(event.details,'$.submission_id') AS INTEGER)=s.id
        AND json_extract(event.details,'$.payout_authority')='owner_signature_required') AS has_delivery_accepted_event
    FROM submissions s
    JOIN tasks t ON t.id=s.task_id
    JOIN service_orders o ON o.published_task_id=t.id AND o.delivery_submission_id=s.id
    LEFT JOIN task_acceptance_receipts r ON r.task_id=t.id AND r.submission_id=s.id
    LEFT JOIN payout_proposals p ON p.task_id=t.id AND p.submission_id=s.id
    WHERE s.id=?`).bind(submissionId).first();
}

function acceptanceEconomicsMatch(row) {
  if (!row?.payout_proposal_id) return false;
  const economics = payoutBreakdown(row.reward_atomic, row.platform_fee_bps);
  return row.gross_atomic === economics.gross_atomic
    && row.platform_fee_atomic === economics.platform_fee_atomic
    && row.worker_payout_atomic === economics.worker_payout_atomic;
}

function acceptanceEvidenceMatches(row) {
  try {
    const acceptance = validateAcceptance({ verification_summary: row.verification_summary, evidence_url: row.evidence_url });
    return acceptance.verificationSummary === row.verification_summary && acceptance.evidenceUrl === row.evidence_url;
  } catch { return false; }
}

function isCompletedAcceptance(row) {
  return Boolean(row
    && row.submission_status === "accepted"
    && row.task_status === "completed"
    && row.order_status === "completed"
    && row.payment_status === "verified"
    && Number(row.accepted_at) > 0
    && Number(row.funding_verified) === 1
    && Number(row.authorization_attested) === 1
    && row.assigned_agent === row.agent_handle
    && row.delivery_artifact === row.artifact
    && Number(row.delivered_at) > 0
    && String(row.quoted_atomic) === String(row.reward_atomic)
    && Number(row.platform_fee_bps) === DEFAULT_FEE_BPS
    && row.acceptance_receipt_id
    && Number(row.receipt_task_id) === Number(row.task_id)
    && Number(row.receipt_submission_id) === Number(row.id)
    && row.verifier === "operator"
    && row.payout_proposal_id
    && Number(row.payout_task_id) === Number(row.task_id)
    && Number(row.payout_submission_id) === Number(row.id)
    && row.payout_agent_handle === row.agent_handle
    && row.payout_asset === "USDC"
    && row.payout_network === "Base"
    && row.payout_status === "awaiting_owner_signature"
    && !Number(row.receipt_conflict)
    && !Number(row.payout_conflict)
    && Number(row.has_delivery_accepted_event) === 1
    && acceptanceEvidenceMatches(row)
    && acceptanceEconomicsMatch(row));
}

function completedSubmissionResult(row) {
  return {
    order: { id: row.order_id, status: row.order_status },
    task: { id: row.task_id, status: row.task_status },
    submission: { id: row.id, status: row.submission_status },
    economics: payoutBreakdown(row.reward_atomic, row.platform_fee_bps),
    acceptance_receipt: {
      id: row.acceptance_receipt_id,
      verification_summary: row.verification_summary,
      evidence_url: row.evidence_url,
    },
    payout_proposal: { id: row.payout_proposal_id, status: row.payout_status },
  };
}

function assertFreshAcceptanceState(submission) {
  if (!submission) throw new Error("submission is not the linked delivery for a paid service order");
  if (submission.submission_status !== "submitted" || submission.task_status !== "review" || submission.order_status !== "review") throw new Error("submission is not ready for acceptance");
  if (submission.payment_status !== "verified") throw new Error("service-order payment is not verified");
  if (Number(submission.funding_verified) !== 1) throw new Error("service-order payment evidence is missing or inconsistent");
  if (submission.accepted_at !== null && submission.accepted_at !== undefined) throw new Error("service order already has an inconsistent acceptance timestamp");
  if (submission.assigned_agent !== submission.agent_handle || submission.delivery_artifact !== submission.artifact || submission.delivered_at === null || submission.delivered_at === undefined) throw new Error("submission does not match the linked service-order delivery");
  if (String(submission.quoted_atomic) !== String(submission.reward_atomic) || Number(submission.platform_fee_bps) !== DEFAULT_FEE_BPS) throw new Error("service-order payout economics do not match the published task");
  if (submission.acceptance_receipt_id || submission.payout_proposal_id || Number(submission.receipt_conflict) || Number(submission.payout_conflict)) throw new Error("submission has conflicting acceptance or payout records");
}

async function completeSubmission(db, submissionId, input, now = Date.now()) {
  const normalizedSubmissionId = Number(submissionId);
  if (!Number.isSafeInteger(normalizedSubmissionId) || normalizedSubmissionId < 1) throw new Error("submission id must be a positive integer");
  if (!Number.isSafeInteger(now) || now < 1) throw new Error("acceptance timestamp is invalid");

  const submission = await readAcceptanceState(db, normalizedSubmissionId);
  if (isCompletedAcceptance(submission)) return { ...completedSubmissionResult(submission), notification: "deduplicated" };
  assertFreshAcceptanceState(submission);
  const acceptance = validateAcceptance(input);
  const economics = payoutBreakdown(submission.reward_atomic, submission.platform_fee_bps);
  const receiptId = crypto.randomUUID();
  const proposalId = crypto.randomUUID();
  const notificationId = crypto.randomUUID();
  const details = JSON.stringify({ order_id: submission.order_id, task_id: submission.task_id, submission_id: submission.id, artifact: submission.artifact, verification_summary: acceptance.verificationSummary, evidence_url: acceptance.evidenceUrl, payout_authority: "owner_signature_required" });
  let results;
  let batchFailure;

  try {
    results = await db.batch([
      db.prepare(`UPDATE submissions SET status='accepted'
        WHERE id=? AND task_id=? AND status='submitted' AND agent_handle=? AND artifact=?
          AND EXISTS (
            SELECT 1 FROM tasks t JOIN service_orders o ON o.published_task_id=t.id
            WHERE t.id=? AND t.status='review' AND t.reward_atomic=? AND t.platform_fee_bps=?
              AND o.id=? AND o.status='review' AND o.payment_status='verified'
              AND ${VERIFIED_ORDER_FUNDING} AND o.authorization_attested=1 AND o.accepted_at IS NULL
              AND o.delivery_submission_id=submissions.id AND o.assigned_agent=submissions.agent_handle
              AND o.delivery_artifact=submissions.artifact AND o.delivered_at IS NOT NULL
              AND o.quoted_atomic=t.reward_atomic
              AND NOT EXISTS (SELECT 1 FROM task_acceptance_receipts receipt WHERE receipt.task_id=t.id OR receipt.submission_id=submissions.id)
              AND NOT EXISTS (SELECT 1 FROM payout_proposals proposal WHERE proposal.task_id=t.id OR proposal.submission_id=submissions.id)
          )`).bind(submission.id, submission.task_id, submission.agent_handle, submission.artifact, submission.task_id, String(submission.reward_atomic), Number(submission.platform_fee_bps), submission.order_id),
      db.prepare(`INSERT INTO task_acceptance_receipts(id,task_id,submission_id,verifier,verification_summary,evidence_url,created_at)
        SELECT ?,s.task_id,s.id,'operator',?,?,?
        FROM submissions s
        JOIN tasks t ON t.id=s.task_id
        JOIN service_orders o ON o.published_task_id=t.id AND o.delivery_submission_id=s.id
        WHERE changes()=1 AND s.id=? AND s.status='accepted' AND t.status='review'
          AND o.id=? AND o.status='review' AND o.payment_status='verified' AND o.accepted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM task_acceptance_receipts receipt WHERE receipt.task_id=t.id OR receipt.submission_id=s.id)
          AND NOT EXISTS (SELECT 1 FROM payout_proposals proposal WHERE proposal.task_id=t.id OR proposal.submission_id=s.id)`).bind(receiptId, acceptance.verificationSummary, acceptance.evidenceUrl, now, submission.id, submission.order_id),
      db.prepare(`UPDATE tasks SET status='completed'
        WHERE id=? AND status='review'
          AND EXISTS (SELECT 1 FROM task_acceptance_receipts receipt WHERE receipt.id=? AND receipt.task_id=tasks.id AND receipt.submission_id=?)
          AND EXISTS (SELECT 1 FROM service_orders o WHERE o.id=? AND o.published_task_id=tasks.id AND o.delivery_submission_id=? AND o.status='review' AND o.payment_status='verified')`).bind(submission.task_id, receiptId, submission.id, submission.order_id, submission.id),
      db.prepare(`INSERT INTO payout_proposals(id,task_id,submission_id,agent_handle,gross_atomic,platform_fee_atomic,worker_payout_atomic,asset,network,status,created_at,updated_at)
        SELECT ?,t.id,s.id,s.agent_handle,?,?,?,'USDC','Base','awaiting_owner_signature',?,?
        FROM submissions s
        JOIN tasks t ON t.id=s.task_id
        JOIN service_orders o ON o.published_task_id=t.id AND o.delivery_submission_id=s.id
        JOIN task_acceptance_receipts receipt ON receipt.id=? AND receipt.task_id=t.id AND receipt.submission_id=s.id
        WHERE s.id=? AND s.status='accepted' AND t.status='completed'
          AND o.id=? AND o.status='completed' AND o.payment_status='verified' AND o.accepted_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM payout_proposals proposal WHERE proposal.task_id=t.id OR proposal.submission_id=s.id)`).bind(proposalId, economics.gross_atomic, economics.platform_fee_atomic, economics.worker_payout_atomic, now, now, receiptId, submission.id, submission.order_id),
      db.prepare(`INSERT INTO notification_events(id,dedupe_key,kind,subject,message,created_at)
        SELECT ?,?,'bounty_completed',?,?,? FROM payout_proposals WHERE id=?
        ON CONFLICT(dedupe_key) DO NOTHING`).bind(notificationId, `bounty_completed:${submission.id}`, `MAG bounty completed: ${submission.title}`.slice(0, 160), `MAG bounty completed\nTask: ${submission.title}\nAgent: ${submission.agent_handle}\nArtifact: ${submission.artifact}\nSubmission: ${submission.id}\nPayment is not implied; verify acceptance and payout separately.`.slice(0, 1500), now, proposalId),
      db.prepare(`INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at)
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM submissions s
          JOIN tasks t ON t.id=s.task_id
          JOIN service_orders o ON o.published_task_id=t.id AND o.delivery_submission_id=s.id
          JOIN task_acceptance_receipts receipt ON receipt.task_id=t.id AND receipt.submission_id=s.id
          JOIN payout_proposals proposal ON proposal.task_id=t.id AND proposal.submission_id=s.id
          WHERE s.id=? AND s.status='accepted' AND t.status='completed'
            AND o.id=? AND o.status='completed' AND o.payment_status='verified' AND o.accepted_at IS NOT NULL
            AND receipt.id=? AND receipt.verifier='operator' AND receipt.verification_summary=? AND receipt.evidence_url=?
            AND proposal.id=? AND proposal.agent_handle=s.agent_handle
            AND proposal.gross_atomic=? AND proposal.platform_fee_atomic=? AND proposal.worker_payout_atomic=?
            AND proposal.asset='USDC' AND proposal.network='Base' AND proposal.status='awaiting_owner_signature'
            AND EXISTS (SELECT 1 FROM order_events event WHERE event.order_id=o.id AND event.kind='delivery_accepted'
              AND CAST(json_extract(event.details,'$.submission_id') AS INTEGER)=s.id
              AND json_extract(event.details,'$.payout_authority')='owner_signature_required')
        ) THEN 'work_accepted' END,'operator','submission',?,?,?`).bind(submission.id, submission.order_id, receiptId, acceptance.verificationSummary, acceptance.evidenceUrl, proposalId, economics.gross_atomic, economics.platform_fee_atomic, economics.worker_payout_atomic, String(submission.id), details, now),
    ]);
  } catch (error) { batchFailure = error; }

  const completed = await readAcceptanceState(db, submission.id);
  if (!isCompletedAcceptance(completed)) {
    const failure = new Error("submission acceptance failed atomically; reload and retry");
    if (batchFailure !== undefined) failure.cause = batchFailure;
    throw failure;
  }
  return { ...completedSubmissionResult(completed), notification: Number(results?.[4]?.meta?.changes || 0) === 1 ? "queued" : "deduplicated" };
}

export { claimPreimage, claimTask, completeSubmission, createTask, listTasks, payoutBreakdown, submissionPreimage, submitWork, validateAcceptance, validateTask, verifyAgentSubmission };
