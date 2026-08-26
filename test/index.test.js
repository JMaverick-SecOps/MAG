import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, scoreListing, tokensMatch } from "../src/index.js";
import { payoutBreakdown, submissionPreimage, validateTask } from "../src/marketplace.js";

const env = { SCOUT_ENVIRONMENT: "test", SCOUT_MODE: "shadow", SCOUT_ADMIN_TOKEN: "secret" };

test("health endpoint reports ready", async () => {
  const response = await handleRequest(new Request("https://example.test/health"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, "mavverick-scout");
});

test("admin endpoint requires authorization", async () => {
  const response = await handleRequest(new Request("https://example.test/admin/config"), env);
  assert.equal(response.status, 401);
});

test("constant-time token helper validates exact token", async () => {
  assert.equal(await tokensMatch("secret", "secret"), true);
  assert.equal(await tokensMatch("wrong", "secret"), false);
});

test("profitable verifiable listings score above zero", () => {
  const result = scoreListing({ id: 7, title: "Fix Worker bug", condition: "Submit a passing pull request", amount_atomic: "10000000" });
  assert.equal(result.blocked, false);
  assert.equal(result.reward_cents, 1000);
  assert.ok(result.expected_profit_cents > 0);
});

test("wallet and credential requests are blocked", () => {
  const result = scoreListing({ id: 8, title: "Upload private key", condition: "Send the private key to claim", amount_atomic: "999000000" });
  assert.equal(result.blocked, true);
  assert.equal(result.score, -1);
});

test("signing guide never exposes an address or key", async () => {
  const request = new Request("https://example.test/admin/wallet/signing-guide", { headers: { authorization: "Bearer secret" } });
  const response = await handleRequest(request, { ...env, TREASURY_WALLET_ADDRESS: "0x0000000000000000000000000000000000000abc" });
  const body = await response.json();
  assert.equal(body.payout_address_configured, true);
  assert.equal(JSON.stringify(body).includes("0xabc"), false);
});

test("marketplace discloses a fair platform fee and worker payout", () => {
  assert.deepEqual(payoutBreakdown("100000000", 1500), {
    gross_atomic: "100000000",
    platform_fee_atomic: "15000000",
    worker_payout_atomic: "85000000",
  });
});

test("task validation requires objective criteria and limits fees", () => {
  const base = {
    title: "Automate a weekly operations report",
    description: "Build and document a reliable automation for the weekly operations report.",
    acceptance_criteria: "A reproducible test produces the expected report from the supplied fixture.",
    category: "automation",
    reward_atomic: "10000000",
    expires_at: Math.floor(Date.now() / 1000) + 7200,
  };
  assert.equal(validateTask(base).fee, 1500);
  assert.throws(() => validateTask({ ...base, platform_fee_bps: 3000 }), /0-25%/);
});

test("submission signatures use an explicit domain-separated preimage", () => {
  assert.equal(
    submissionPreimage({ taskId: 4, handle: "agent-one", artifact: "https://example.com/proof", signedAt: 123 }),
    "mavverick.submit.v1:4:agent-one:https://example.com/proof:123",
  );
});

test("public landing page discloses operator and independent 1F916 relationship", async () => {
  const response = await handleRequest(new Request("https://example.test/"), env);
  const body = await response.text();
  assert.match(body, /MAVVERICK Agent Guild/);
  assert.match(body, /MAVVERICK LLC/);
  assert.match(body, /not an official 1F916 service/i);
  assert.match(body, /Phase Two supports opt-in agent collaboration/i);
  assert.doesNotMatch(body, /Phase one is noncustodial and digital-work only/i);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
});

test("public offer catalog has clear starting prices and USDC-only settlement", async () => {
  const response = await handleRequest(new Request("https://example.test/api/offers"), env);
  const body = await response.json();
  assert.equal(body.offers.length, 3);
  assert.equal(body.payment_configured, false);
  assert.equal(body.settlement, "USDC on Base only");
  assert.match(body.offers[0].price, /\$149/);
});

test("revenue readiness reports capabilities but never secrets", async () => {
  const request = new Request("https://example.test/admin/revenue-readiness", { headers: { authorization: "Bearer secret" } });
  const response = await handleRequest(request, { ...env, DB: {}, TREASURY_WALLET_ADDRESS: "0x0000000000000000000000000000000000000abc" });
  const serialized = JSON.stringify(await response.json());
  assert.match(serialized, /ready_for_leads/);
  assert.equal(serialized.includes("0x0000000000000000000000000000000000000abc"), false);
});

test("payment config exposes only public Base USDC settlement metadata", async () => {
  const treasury = "0x0000000000000000000000000000000000000abc";
  const response = await handleRequest(new Request("https://example.test/api/payment-config"), { ...env, TREASURY_WALLET_ADDRESS: treasury });
  const body = await response.json();
  assert.equal(body.chain_id, 8453);
  assert.equal(body.treasury_address, treasury);
  assert.equal(body.asset, "USDC");
  assert.equal(body.custody.includes("no signing authority"), true);
});

test("phase two community manifest is transparent and opt-in", async () => {
  const response = await handleRequest(new Request("https://example.com/api/community"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.phase, 2);
  assert.equal(body.citizen, "mavverick-scout");
  assert.match(body.relationship, /independent/);
  assert.ok(body.principles.includes("opt-in participation"));
  assert.ok(body.principles.includes("no paid engagement"));
});

test("sponsorship catalog separates sponsorship from investments", async () => {
  const response = await handleRequest(new Request("https://example.com/api/sponsorships"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.tiers.length, 3);
  assert.match(body.legal, /no equity/i);
  assert.match(body.worker_bounty_policy, /85% worker/);
});

test("citizen support publishes exact one-dollar Base USDC terms", async () => {
  const response = await handleRequest(new Request("https://example.com/api/citizen-support"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.amount_atomic, "1000000");
  assert.equal(body.chain_id, 8453);
  assert.match(body.program, /\$1 USDC/);
  assert.match(body.allocation, /no automatic entitlement/i);
});

test("autonomous service catalog enforces bounded purchasing", async () => {
  const response = await handleRequest(new Request("https://example.com/api/services"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.services.length >= 21);
  assert.ok(body.services.some((service) => service.id === "m365-audit"));
  assert.ok(body.services.some((service) => service.id === "trading-research"));
  assert.ok(body.services.some((service) => service.id === "custom-application"));
  assert.ok(body.services.some((service) => service.id === "iam-operations"));
  assert.ok(body.services.some((service) => service.id === "mcp-delivery"));
  assert.ok(body.services.some((service) => service.id === "n8n-workflow"));
  assert.ok(body.services.some((service) => service.id === "options-signals"));
  assert.ok(body.services.some((service) => service.id === "website-starter"));
  assert.ok(body.services.some((service) => service.id === "technical-seo"));
  assert.ok(body.services.some((service) => service.id === "data-analysis"));
  assert.equal(body.market_benchmarks.relationship.includes("no affiliation"), true);
  assert.ok(body.market_benchmarks.items.length >= 7);
  assert.ok(body.prohibited.includes("unauthorized access"));
  assert.ok(body.prohibited.includes("unbounded spending"));
});
