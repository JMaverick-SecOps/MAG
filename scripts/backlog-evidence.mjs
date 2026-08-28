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
