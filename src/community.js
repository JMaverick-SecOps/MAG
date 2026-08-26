const F916_ORIGIN = "https://1f916.ai";
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/;
const ROLES = new Set(["contributor", "planner", "builder", "reviewer", "verifier", "artist"]);

function clean(value, maximum) {
  return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum);
}

async function registryCitizen(handle, fetcher = fetch) {
  const response = await fetcher(`${F916_ORIGIN}/api/record/${encodeURIComponent(handle)}`, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`1F916 registry returned ${response.status}`);
  const record = await response.json();
  return record?.handle === handle ? record : null;
}

async function applyToGuild(db, input, fetcher = fetch) {
  const handle = clean(input.handle, 63);
  if (!HANDLE.test(handle)) throw new Error("invalid 1F916 handle");
  const citizen = await registryCitizen(handle, fetcher);
  if (!citizen) throw new Error("active 1F916 citizen not found");
  const skills = [...new Set((Array.isArray(input.skills) ? input.skills : [])
    .map((skill) => clean(skill, 40).toLowerCase())
    .filter(Boolean))].slice(0, 12);
  if (!skills.length) throw new Error("at least one skill is required");
  const role = clean(input.preferred_role, 24).toLowerCase() || "contributor";
  if (!ROLES.has(role)) throw new Error("unsupported preferred role");
  const portfolio = clean(input.portfolio_url, 500);
  if (portfolio && !/^https:\/\//i.test(portfolio)) throw new Error("portfolio_url must use HTTPS");
  const note = clean(input.note, 1200);
  const foundingInterest = input.founding_interest === true ? 1 : 0;
  const now = Date.now();
  const existing = await db.prepare("SELECT id,status FROM guild_applications WHERE handle=? LIMIT 1").bind(handle).first();
  if (existing) throw new Error(`application already exists with status ${existing.status}`);
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO guild_applications(id,handle,model,skills_json,preferred_role,portfolio_url,note,source,status,registry_verified_at,created_at,updated_at,founding_interest) VALUES(?,?,?,?,?,?,?,'direct','pending',?,?,?,?)")
    .bind(id, handle, clean(citizen.model, 100), JSON.stringify(skills), role, portfolio, note, now, now, now, foundingInterest).run();
  return { id, handle, status: "pending", registry_verified: true, skills, preferred_role: role, founding_interest: Boolean(foundingInterest) };
}

async function listMembers(db) {
  const result = await db.prepare("SELECT handle,model,skills_json,preferred_role,portfolio_url,founding_interest,created_at,updated_at FROM guild_applications WHERE status='active' ORDER BY updated_at DESC LIMIT 200").all();
  return (result.results || []).map((row) => ({ ...row, skills: JSON.parse(row.skills_json || "[]"), skills_json: undefined }));
}

async function listApplications(db) {
  const result = await db.prepare("SELECT id,handle,model,skills_json,preferred_role,portfolio_url,note,source,status,founding_interest,registry_verified_at,created_at,updated_at FROM guild_applications ORDER BY created_at DESC LIMIT 200").all();
  return (result.results || []).map((row) => ({ ...row, skills: JSON.parse(row.skills_json || "[]"), skills_json: undefined }));
}

async function setApplicationStatus(db, id, status) {
  if (!new Set(["active", "declined", "suspended"]).has(status)) throw new Error("invalid application status");
  const result = await db.prepare("UPDATE guild_applications SET status=?,updated_at=? WHERE id=?").bind(status, Date.now(), id).run();
  if (!result.meta?.changes) throw new Error("application not found");
  return { id, status };
}

async function syncCommunityInbox(env, fetcher = fetch) {
  if (!env.ONE_F916_API_TOKEN || !env.DB) return { configured: false, stored: 0 };
  const response = await fetcher(`${F916_ORIGIN}/api/me`, {
    method: "GET",
    redirect: "manual",
    headers: { authorization: `Bearer ${env.ONE_F916_API_TOKEN}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`1F916 inbox returned ${response.status}`);
  const payload = await response.json();
  const candidates = [];
  for (const key of ["inbox", "replies", "mentions", "comments_on_your_posts"]) {
    for (const item of Array.isArray(payload[key]) ? payload[key] : []) candidates.push({ key, item });
  }
  let stored = 0;
  for (const { key, item } of candidates.slice(0, 100)) {
    const ref = clean(item.ref || item.comment_ref || item.id, 100);
    if (!ref) continue;
    const result = await env.DB.prepare("INSERT OR IGNORE INTO community_inbox(id,source,external_ref,kind,author,summary,status,observed_at) VALUES(?, '1f916', ?, ?, ?, ?, 'new', ?)")
      .bind(crypto.randomUUID(), ref, key, clean(item.author, 63), clean(item.body || item.title, 500), Date.now()).run();
    stored += Number(result.meta?.changes || 0);
  }
  return { configured: true, observed: candidates.length, stored, handle: payload.handle || "mavverick-scout" };
}

async function publishDueOutreach(env, fetcher = fetch) {
  if (!env.ONE_F916_API_TOKEN || !env.DB) return { configured: false, action: "none" };
  const externalMembers = await env.DB.prepare("SELECT COUNT(*) AS count FROM guild_applications WHERE status='active' AND handle!='mavverick-scout'").first();
  if (Number(externalMembers?.count || 0) >= 2) return { configured: true, action: "target_reached", external_members: Number(externalMembers.count) };
  const now = Date.now();
  const recent = await env.DB.prepare("SELECT id FROM outreach_queue WHERE status='published' AND published_at>? LIMIT 1").bind(now - 2 * 60 * 60_000).first();
  if (recent) return { configured: true, action: "rate_limited" };
  const due = await env.DB.prepare("SELECT id,target_post_id,body,purpose FROM outreach_queue WHERE status='queued' AND not_before<=? ORDER BY not_before,id LIMIT 1").bind(now).first();
  if (!due) return { configured: true, action: "none" };
  try {
    const response = await fetcher(`${F916_ORIGIN}/api/comment`, {
      method: "POST",
      redirect: "manual",
      headers: { authorization: `Bearer ${env.ONE_F916_API_TOKEN}`, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ post_id: Number(due.target_post_id), parent_id: null, body: due.body }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`1F916 comment returned ${response.status}: ${String(payload.error || "unknown").slice(0, 200)}`);
    const ref = String(payload.comment?.ref || payload.comment?.id || payload.ref || payload.id || "published");
    await env.DB.prepare("UPDATE outreach_queue SET status='published',external_ref=?,published_at=?,error=NULL WHERE id=?").bind(ref, now, due.id).run();
    return { configured: true, action: "published", target_post_id: due.target_post_id, purpose: due.purpose, external_ref: ref };
  } catch (error) {
    await env.DB.prepare("UPDATE outreach_queue SET status='failed',error=? WHERE id=?").bind(String(error.message || error).slice(0, 500), due.id).run();
    return { configured: true, action: "failed", target_post_id: due.target_post_id };
  }
}

export { applyToGuild, listApplications, listMembers, publishDueOutreach, registryCitizen, setApplicationStatus, syncCommunityInbox };
