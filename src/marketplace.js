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
  for (const key of Array.isArray(record.keys) ? record.keys.filter((item) => item.status === "active" && item.custody === "self") : []) {
    try { const publicKey = await crypto.subtle.importKey("raw", b64url(key.public_key || key.x), { name: "Ed25519" }, false, ["verify"]); if (await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)) return { handle, signedAt }; } catch {}
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
  await db.batch([
    db.prepare("INSERT INTO task_claims(task_id,agent_handle,signed_at,signature,claimed_at,updated_at) VALUES(?,?,?,?,?,?)").bind(taskId, verified.handle, verified.signedAt, input.signature, now, now),
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=? AND status='open'").bind(taskId),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) VALUES('task_claimed',?,'task',?,?,?)").bind(verified.handle, String(taskId), JSON.stringify({ signed_at: verified.signedAt }), now),
  ]);
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
  const keys = Array.isArray(record.keys) ? record.keys.filter((key) => key.status === "active" && key.custody === "self") : [];
  const signature = b64url(String(input.signature || ""));
  const message = new TextEncoder().encode(submissionPreimage({ taskId: input.task_id, handle, artifact, signedAt }));
  for (const key of keys) {
    try {
      const publicKey = await crypto.subtle.importKey("raw", b64url(key.public_key || key.x), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, message)) return { handle, artifact, signedAt };
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
  if (claim && claim.agent_handle !== verified.handle) throw new Error("task is claimed by another agent");
  const note = String(input.note || "").trim().slice(0, 2000);
  const now = Date.now();
  const result = await db.prepare("INSERT INTO submissions(task_id,agent_handle,artifact,note,signed_at,signature,created_at) VALUES(?,?,?,?,?,?,?) RETURNING id")
    .bind(taskId, verified.handle, verified.artifact, note, verified.signedAt, input.signature, now).first();
  await db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) VALUES('work_submitted',?,'submission',?,?,?)")
    .bind(verified.handle, String(result.id), JSON.stringify({ task_id: taskId, artifact: verified.artifact }), now).run();
  await db.prepare("UPDATE tasks SET status='review' WHERE id=?").bind(taskId).run();
  return { id: result.id, task_id: taskId, agent_handle: verified.handle, status: "review" };
}

export { claimPreimage, claimTask, createTask, listTasks, payoutBreakdown, submissionPreimage, submitWork, validateTask, verifyAgentSubmission };
