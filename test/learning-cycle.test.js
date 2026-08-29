import test from "node:test";
import assert from "node:assert/strict";
import { boundedLearningActions, validateLearningRecord } from "../src/learning-cycle.js";

function record(overrides = {}) {
  return {
    cycle_id: "20260829T030000Z-checkout-contract",
    observed_at: "2026-08-29T03:00:00Z",
    objective: "Improve payment activation accuracy without weakening fulfillment controls.",
    observation: "The provider dashboard exposes payment-method toggles but not a signing-secret control.",
    hypothesis: "Keeping fulfillment fail-closed until a signed event is reproduced prevents false activation.",
    action: "reproduce_test",
    evidence: [{ kind: "test", ref: "test/saturnshift.test.js", claim: "The signed-event fixture passes and replay is rejected." }],
    verification: { status: "passed", method: "node --test test/saturnshift.test.js", result: "All focused tests passed." },
    capability_delta: "improved",
    lesson: "Provider UI capability and webhook fulfillment capability must be verified separately.",
    next_action: "Wait for the account-specific signing secret and run a provider-generated test event.",
    approval: { required: false },
    execution_status: "completed",
    ...overrides,
  };
}

test("verified autonomous learning records are accepted", () => {
  const result = validateLearningRecord(record());
  assert.equal(result.capability_delta, "improved");
  assert.equal(result.execution_status, "completed");
});

test("improvement claims require passed verification", () => {
  assert.throws(() => validateLearningRecord(record({ verification: { status: "unknown", method: "not run", result: "No receipt." } })), /passed verification/);
});

test("public communication remains human-gated and draft-only", () => {
  const draft = validateLearningRecord(record({
    action: "draft_public_message",
    capability_delta: "no_change",
    approval: { required: true, reason: "Public representation of MAG requires owner approval." },
    execution_status: "drafted",
  }));
  assert.equal(draft.approval.required, true);
  assert.equal(draft.execution_status, "drafted");
  assert.throws(() => validateLearningRecord(record({ action: "draft_public_message", approval: { required: false } })), /human approval/);
});

test("no-new-signal records cannot claim improvement", () => {
  assert.throws(() => validateLearningRecord(record({ action: "record_no_new_signal" })), /cannot claim/);
});

test("unbounded actions are rejected", () => {
  assert.throws(() => validateLearningRecord(record({ action: "execute_payment" })), /bounded action set/);
  assert.ok(boundedLearningActions().autonomous.includes("add_test"));
  assert.ok(boundedLearningActions().gated.includes("draft_financial_action"));
});
