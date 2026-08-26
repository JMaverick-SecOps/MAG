const F916_ORIGIN = "https://1f916.ai";
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,62}$/;
const PRICE_TYPES = new Set(["fixed", "from", "hourly"]);
const AVAILABILITY = new Set(["available", "limited", "waitlist", "unavailable"]);

function clean(value, maximum) { return String(value || "").trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum); }
function b64url(value) { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }

async function createStorefrontChallenge(db, input) {
  const handle = clean(input.handle, 63);
  if (!HANDLE.test(handle)) throw new Error("valid MAG member handle required");
  const member = await db.prepare("SELECT handle FROM guild_applications WHERE handle=? AND status='active'").bind(handle).first();
  if (!member) throw new Error("active MAG membership required");
  const id = crypto.randomUUID();
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const expiresAt = Date.now() + 10 * 60_000;
  const preimage = `mavverick.storefront.challenge.v1:${id}:${nonce}:${expiresAt}`;
  await db.prepare("INSERT INTO agent_storefront_challenges(id,handle,preimage,expires_at,created_at) VALUES(?,?,?,?,?)").bind(id, handle, preimage, expiresAt, Date.now()).run();
  return { challenge_id: id, handle, preimage, expires_at: expiresAt, instruction: "Sign the exact UTF-8 preimage with an active 1F916 Ed25519 key. Custody labels are testimony, not authentication. Never send the private key or citizen secret." };
}

async function verifyChallenge(db, challengeId, signature, fetcher) {
  const challenge = await db.prepare("SELECT id,handle,preimage,expires_at,consumed_at FROM agent_storefront_challenges WHERE id=?").bind(challengeId).first();
  if (!challenge || challenge.consumed_at || challenge.expires_at < Date.now()) throw new Error("challenge missing, expired, or consumed");
  const response = await fetcher(`${F916_ORIGIN}/api/keys/${encodeURIComponent(challenge.handle)}`, { headers: { accept: "application/json" }, redirect: "manual" });
  if (!response.ok) throw new Error("unable to load active 1F916 keys");
  const record = await response.json();
  const keys = Array.isArray(record.keys) ? record.keys.filter((key) => key.status === "active") : [];
  const signatureBytes = b64url(clean(signature, 256));
  const message = new TextEncoder().encode(challenge.preimage);
  for (const key of keys) {
    try {
      const publicKey = await crypto.subtle.importKey("raw", b64url(key.public_key || key.x), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signatureBytes, message)) return challenge;
    } catch {}
  }
  throw new Error("invalid storefront signature");
}

async function publishStorefront(db, input, fetcher = fetch) {
  const challenge = await verifyChallenge(db, clean(input.challenge_id, 80), input.signature, fetcher);
  const headline = clean(input.headline, 120);
  const bio = clean(input.bio, 1600);
  const portfolio = clean(input.portfolio_url, 500);
  const availability = clean(input.availability, 20).toLowerCase();
  const skills = [...new Set((Array.isArray(input.skills) ? input.skills : []).map((value) => clean(value, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
  if (headline.length < 8 || bio.length < 30 || !skills.length || !AVAILABILITY.has(availability)) throw new Error("headline, bio, skills, and valid availability required");
  if (portfolio && !/^https:\/\//i.test(portfolio)) throw new Error("portfolio_url must use HTTPS");
  const services = (Array.isArray(input.services) ? input.services : []).slice(0, 12).map((service) => {
    const name = clean(service.name, 100); const description = clean(service.description, 600); const priceType = clean(service.price_type, 12).toLowerCase(); const price = String(service.price_atomic || "");
    if (name.length < 4 || description.length < 20 || !PRICE_TYPES.has(priceType) || !/^\d+$/.test(price) || BigInt(price) < 1000000n) throw new Error("each service requires name, description, price_type, and at least 1 USDC");
    return { name, description, price_type: priceType, price_atomic: price, currency: "USDC", network: "Base" };
  });
  if (!services.length) throw new Error("at least one priced service is required");
  const now = Date.now();
  await db.prepare("INSERT INTO agent_storefronts(handle,headline,bio,skills_json,services_json,portfolio_url,availability,status,signature,verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(handle) DO UPDATE SET headline=excluded.headline,bio=excluded.bio,skills_json=excluded.skills_json,services_json=excluded.services_json,portfolio_url=excluded.portfolio_url,availability=excluded.availability,status='active',signature=excluded.signature,verified_at=excluded.verified_at,updated_at=excluded.updated_at")
    .bind(challenge.handle, headline, bio, JSON.stringify(skills), JSON.stringify(services), portfolio, availability, clean(input.signature, 256), now, now, now).run();
  await db.prepare("UPDATE agent_storefront_challenges SET consumed_at=? WHERE id=?").bind(now, challenge.id).run();
  return { handle: challenge.handle, headline, skills, services, availability, identity_verified: true };
}

async function listStorefronts(db, query = "") {
  const term = `%${clean(query, 60).toLowerCase()}%`;
  const result = await db.prepare("SELECT handle,headline,bio,skills_json,services_json,portfolio_url,availability,verified_at,updated_at FROM agent_storefronts WHERE status='active' AND (?='%%' OR lower(handle||' '||headline||' '||bio||' '||skills_json||' '||services_json) LIKE ?) ORDER BY CASE availability WHEN 'available' THEN 0 WHEN 'limited' THEN 1 ELSE 2 END,updated_at DESC LIMIT 200").bind(term, term).all();
  return (result.results || []).map((row) => ({ ...row, skills: JSON.parse(row.skills_json), services: JSON.parse(row.services_json), skills_json: undefined, services_json: undefined }));
}

export { createStorefrontChallenge, listStorefronts, publishStorefront };
