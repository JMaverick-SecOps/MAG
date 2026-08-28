// Offline diagnostic only: equal endpoints do not prove an inactive interval.
// Inputs are caller-supplied snapshots, not proof of their completeness or truth.
function valid(snapshot) {
  if (!snapshot || !Number.isSafeInteger(snapshot.observed_at) || snapshot.observed_at < 0 ||
      typeof snapshot.scope !== "string" || !snapshot.scope || snapshot.scope.length > 256 ||
      snapshot.complete !== true || !Array.isArray(snapshot.items) || snapshot.items.length > 10000 ||
      snapshot.total !== snapshot.items.length) return false;
  const ids = new Set();
  for (const item of snapshot.items) {
    if (!item || typeof item.id !== "string" || !item.id || item.id.length > 256 ||
        typeof item.version !== "string" || !item.version || item.version.length > 256 ||
        !Number.isSafeInteger(item.updated_at) || item.updated_at < 0 || item.updated_at > snapshot.observed_at ||
        ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}
function medianAge(snapshot) {
  const ages = snapshot.items.map(item => snapshot.observed_at - item.updated_at).sort((a,b) => a-b);
  const n = ages.length;
  return n === 0 ? null : n % 2 ? ages[(n-1)/2] : ages[n/2-1]/2 + ages[n/2]/2;
}

// Preserve the three-state distinction from public review: no observed fork is
// not evidence that a fork is impossible. Inputs are descriptions, not proof.
// Source discussion: https://1f916.ai/api/comment/28002
export function classifyDisagreementFalsifier(input) {
  const base = {
    independence_proven: false,
    fault_relevance_proven: false,
    input_is_evidence: false
  };
  if (!input || typeof input !== "object" ||
      typeof input.candidate_event !== "string" || !input.candidate_event ||
      input.candidate_event.length > 1000 ||
      typeof input.challenge_surface !== "string" || !input.challenge_surface ||
      input.challenge_surface.length > 1000 ||
      (input.causal_cut != null && (typeof input.causal_cut !== "string" ||
        !input.causal_cut || input.causal_cut.length > 1000)) ||
      !Array.isArray(input.assumptions) || input.assumptions.length > 32 ||
      Array.from(input.assumptions).some(item => typeof item !== "string" || !item || item.length > 500)) {
    return { state: "unknown", reason: "bounded_description_required", ...base };
  }
  if (input.status === "observed") {
    if (typeof input.observation_receipt !== "string" || !input.observation_receipt ||
        input.observation_receipt.length > 2000) {
      return { state: "unknown", reason: "observation_receipt_required", ...base };
    }
    return {
      state: "observed_divergence",
      candidate_event: input.candidate_event,
      causal_cut: typeof input.causal_cut === "string" ? input.causal_cut : null,
      assumptions: [...input.assumptions],
      challenge_surface: input.challenge_surface,
      observation_receipt: input.observation_receipt,
      ...base,
      limit: "A caller-supplied receipt fixes a checkable target; this helper does not verify the receipt or establish that the divergence crosses the relevant fault boundary."
    };
  }
  if (input.status === "structurally_excluded") {
    if (input.closed_model !== true ||
        typeof input.causal_cut !== "string" || !input.causal_cut ||
        input.causal_cut.length > 1000 ||
        typeof input.causal_cut_evidence !== "string" || !input.causal_cut_evidence ||
        input.causal_cut_evidence.length > 2000) {
      return {
        state: "unwitnessed",
        reason: "closed_model_and_causal_cut_evidence_required",
        candidate_event: input.candidate_event,
        assumptions: [...input.assumptions],
        challenge_surface: input.challenge_surface,
        ...base
      };
    }
    return {
      state: "structurally_excluded",
      candidate_event: input.candidate_event,
      causal_cut: input.causal_cut,
      causal_cut_evidence: input.causal_cut_evidence,
      assumptions: [...input.assumptions],
      challenge_surface: input.challenge_surface,
      ...base,
      limit: "This records a caller-supplied closed-model claim and evidence pointer; it does not verify either or prove general independence."
    };
  }
  if (input.status === "unwitnessed") {
    return {
      state: "unwitnessed",
      candidate_event: input.candidate_event,
      causal_cut: typeof input.causal_cut === "string" ? input.causal_cut : null,
      assumptions: [...input.assumptions],
      challenge_surface: input.challenge_surface,
      ...base,
      limit: "Failure to construct a disagreement event proves neither absence nor structural exclusion."
    };
  }
  return { state: "unknown", reason: "recognized_status_required", ...base };
}

export function compareBacklogSnapshots(before, after) {
  const unknown = reason => ({ state: "unknown", reason, continuous_inactivity_proven: false });
  if (!valid(before) || !valid(after)) return unknown("complete_valid_snapshots_required");
  if (before.scope !== after.scope) return unknown("scope_mismatch");
  if (after.observed_at <= before.observed_at) return unknown("increasing_observation_times_required");
  const old = new Map(before.items.map(item => [item.id,item]));
  const current = new Map(after.items.map(item => [item.id,item]));
  const added = [...current.keys()].filter(id => !old.has(id)).sort();
  const removed = [...old.keys()].filter(id => !current.has(id)).sort();
  const changed = [...current.keys()].filter(id => old.has(id) &&
    (old.get(id).version !== current.get(id).version || old.get(id).updated_at !== current.get(id).updated_at)).sort();
  const first = medianAge(before), last = medianAge(after);
  return {
    state: added.length || removed.length || changed.length ? "changed_at_observations" : "unchanged_at_observations",
    counts: [before.items.length,after.items.length],
    median_ages: [first,last],
    age_slope: first === null || last === null ? null : (last-first)/(after.observed_at-before.observed_at),
    added,removed,changed,
    continuous_inactivity_proven: false,
    limit: "Two caller-supplied snapshots cannot exclude unobserved changes or prove their own completeness."
  };
}
