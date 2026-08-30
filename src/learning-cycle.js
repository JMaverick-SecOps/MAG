const AUTONOMOUS_ACTIONS = new Set([
  "research",
  "rescore_bounty",
  "reproduce_test",
  "add_test",
  "improve_docs",
  "patch_nonfinancial",
  "monitor_delivery",
  "record_no_new_signal",
]);

const GATED_ACTIONS = new Set([
  "draft_financial_action",
  "draft_public_message",
  "draft_outreach",
  "draft_irreversible_action",
]);

const CAPABILITY_DELTAS = new Set(["improved", "no_change", "regressed"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "unknown"]);

function requiredText(value, field, maximum = 4000) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} is required`);
  if (normalized.length > maximum) throw new Error(`${field} is too long`);
  return normalized;
}

function validTimestamp(value) {
  const normalized = requiredText(value, "observed_at", 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(normalized)) {
    throw new Error("observed_at must be an ISO-8601 UTC timestamp");
  }
  if (!Number.isFinite(Date.parse(normalized))) throw new Error("observed_at is invalid");
  return normalized;
}

function validateEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("at least one evidence item is required");
  if (evidence.length > 20) throw new Error("too many evidence items");
  return evidence.map((item, index) => ({
    kind: requiredText(item?.kind, `evidence[${index}].kind`, 40),
    ref: requiredText(item?.ref, `evidence[${index}].ref`, 1000),
    claim: requiredText(item?.claim, `evidence[${index}].claim`, 1000),
  }));
}

// Checks record shape and bounded-action policy, not the truth of its evidence.
// A caller's "passed" status cannot substitute for a separately observed run
// or receipt. Never execute or fetch caller-supplied method/ref fields here.
export function validateLearningRecord(input = {}) {
  const action = requiredText(input.action, "action", 80);
  const autonomous = AUTONOMOUS_ACTIONS.has(action);
  const gated = GATED_ACTIONS.has(action);
  if (!autonomous && !gated) throw new Error("action is outside the bounded action set");

  const capabilityDelta = requiredText(input.capability_delta, "capability_delta", 20);
  if (!CAPABILITY_DELTAS.has(capabilityDelta)) throw new Error("capability_delta is invalid");

  const verificationStatus = requiredText(input.verification?.status, "verification.status", 20);
  if (!VERIFICATION_STATUSES.has(verificationStatus)) throw new Error("verification.status is invalid");

  const approvalRequired = input.approval?.required === true;
  if (gated && !approvalRequired) throw new Error("gated actions must require human approval");
  if (autonomous && approvalRequired) throw new Error("autonomous actions cannot be marked as gated");
  if (gated && input.execution_status !== "drafted") throw new Error("gated actions must stop at drafted status");
  if (capabilityDelta === "improved" && verificationStatus !== "passed") {
    throw new Error("an improvement claim requires passed verification");
  }
  if (action === "record_no_new_signal" && capabilityDelta !== "no_change") {
    throw new Error("no-new-signal records cannot claim a capability change");
  }

  return {
    validation_scope: "record_shape_and_policy",
    cycle_id: requiredText(input.cycle_id, "cycle_id", 120),
    observed_at: validTimestamp(input.observed_at),
    objective: requiredText(input.objective, "objective"),
    observation: requiredText(input.observation, "observation"),
    hypothesis: requiredText(input.hypothesis, "hypothesis"),
    action,
    evidence: validateEvidence(input.evidence),
    verification: {
      status: verificationStatus,
      status_source: "caller_assertion",
      evidence_check: "not_performed",
      method: requiredText(input.verification?.method, "verification.method", 1000),
      result: requiredText(input.verification?.result, "verification.result", 2000),
    },
    capability_delta: capabilityDelta,
    lesson: requiredText(input.lesson, "lesson", 2000),
    next_action: requiredText(input.next_action, "next_action", 2000),
    approval: {
      required: approvalRequired,
      reason: approvalRequired ? requiredText(input.approval?.reason, "approval.reason", 1000) : "none",
    },
    execution_status: gated ? "drafted" : "completed",
  };
}

export function boundedLearningActions() {
  return {
    autonomous: [...AUTONOMOUS_ACTIONS],
    gated: [...GATED_ACTIONS],
  };
}
