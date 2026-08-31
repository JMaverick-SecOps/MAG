// Non-monetary release checks. No customer, payment, or tenant is created.
import assert from "node:assert/strict";

const origin = "https://mavverick-scout.magai.workers.dev";
const results = [];
async function check(path, status = 200, options = {}) {
  const response = await fetch(new URL(path, origin), {
    redirect: "error", signal: AbortSignal.timeout(20_000), ...options,
  });
  assert.equal(response.status, status, `${options.method || "GET"} ${path}`);
  results.push({ method: options.method || "GET", path, status });
  return response;
}

const health = await (await check("/health")).json();
assert.equal(health.ok, true);
assert.equal(health.service, "mavverick-scout");

for (const path of ["/", "/hire", "/work", "/ops", "/ops/console", "/ops/screenconnect", "/orders/status", "/agents", "/contribute", "/post-bounty", "/migrations", "/security"]) {
  const response = await check(path);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  if (["/ops/console", "/orders/status"].includes(path)) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  await response.arrayBuffer();
}
const selected = await (await check("/hire?service=website-starter")).text();
assert.match(selected, /name="service_id" value="website-starter"/);
assert.match(selected, /name="max_budget_atomic"[^>]*value="99000000"/);
assert.match(selected, /action="\/orders"/);

for (const path of ["/api/tasks", "/api/services", "/api/migrations", "/api/managed-ops", "/api/managed-ops/screenconnect", "/api/security-reviews"]) {
  const response = await check(path);
  assert.match(response.headers.get("content-type"), /application\/json/);
  await response.json();
}

const providers = await (await check("/api/payment-providers")).json();
assert.equal(typeof providers.paid_intake_ready, "boolean");
assert.equal(providers.saturnshift.delivery_test.supported, true);
assert.equal(providers.saturnshift.delivery_test.payment_activation, false);
const securityPage = await (await check("/security")).text();
for (const id of ["static-scan-review", "focused-code-review", "application-review", "architecture-threat-model"]) {
  assert.ok(securityPage.includes('href="/hire?service='+id+'#checkout"'), id);
  const form = await (await check("/hire?service="+id)).text();
  assert.ok(form.includes('name="tier_id" value="'+id+'"'));
  assert.ok(form.includes('action="/intake/security-reviews"'));
  assert.ok(!form.includes('action="/orders"'));
}
const operationsPage = await (await check("/ops")).text();
assert.ok(operationsPage.includes('href="#demo"'));
assert.ok(operationsPage.includes('href="/hire?service=managed-ops-psa#checkout"'));
assert.ok(operationsPage.includes("Planned · not available for activation"));
for (const plan of ["psa-workspace", "managed-visibility"]) {
  const form = await (await check("/hire?service=managed-ops-psa&plan="+plan)).text();
  assert.ok(form.includes('<option value="'+plan+'" selected>'));
}
const invalidJson = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
const agentConnection = await (await check("/api/agent-connections")).json();
assert.equal(agentConnection.amount_atomic, "1000000");
assert.equal(agentConnection.chain_id, 8453);
assert.equal(agentConnection.automatic_debit, false);
assert.equal(typeof agentConnection.enabled, "boolean");
assert.equal(typeof agentConnection.hosted_work_watch_enabled, "boolean");
if (!agentConnection.enabled) {
  for (const path of ["/api/agent-connections", "/api/agent-connections/signing-payload"]) {
    const response = await check(path, 503, invalidJson);
    assert.equal((await response.json()).error, "agent_connection_checkout_disabled");
  }
}
if (!providers.paid_intake_ready) {
  assert.match(selected, /Paid intake is temporarily unavailable/);
  for (const path of ["/orders", "/api/orders", "/bounties", "/api/bounties", "/orders/00000000-0000-4000-8000-000000000001/checkout"]) {
    const response = await check(path, 503, invalidJson);
    assert.equal((await response.json()).error, "paid_intake_unavailable");
  }
}
if (!providers.saturnshift.signed_webhook_configured) {
  await check("/api/webhooks/saturnshift", 503, invalidJson);
}
const catalog=await (await check("/api/services")).json();
const catalogHtml=await (await check("/hire")).text();
for(const service of catalog.services)assert.ok(catalogHtml.includes('href="/hire?service='+service.id+'#checkout"'),service.id);
for(const id of ["migration-fabric","static-scan-review","managed-ops-psa"]){
  const html=await (await check("/hire?service="+id)).text();
  assert.ok(html.includes(id==="managed-ops-psa"?'action="/subscriptions"':'action="/intake/'),id);
}
const plans=await (await check("/api/subscriptions/plans")).json();
assert.equal(plans.automatic_debit,false);
assert.ok(!plans.enabled_plans.includes("managed-security"));
await check("/subscriptions/billing",401);
await check("/api/rmm/poll",403,invalidJson);
await check("/api/rmm/results",403,invalidJson);
const wallet=await (await check("/wallet-checkout.js")).text();
assert.ok(wallet.includes("eth_sendTransaction"));
assert.ok(wallet.includes("sendOutcomeUnknown"));
await check("/admin/config", 401);
await check("/orders/status", 404, { method: "POST", body: new URLSearchParams({ order_id: "00000000-0000-4000-8000-000000000001", access_token: "invalid-release-test-token" }) });

for (const path of ["/mag-logo.png", "/mag-logo-light.png", "/mag-logo-dark.png", "/mag-app-icon.png", "/mag-favicon.png"]) {
  const response = await check(path);
  assert.match(response.headers.get("content-type"), /image\/png/);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.ok(bytes.length < 2_000_000, `${path} exceeds the branding upload limit`);
  assert.deepEqual(Array.from(bytes.slice(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
}
console.log(JSON.stringify({ checked_at: new Date().toISOString(), origin, checks_passed: results.length, paid_intake_ready: providers.paid_intake_ready, saturnshift_enabled: providers.saturnshift.configured, results }, null, 2));
