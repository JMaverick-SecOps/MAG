const PHASES = ["preflight", "discovery", "mapping_validation", "initial_sync", "delta_sync", "preauthorized_cutover", "verification", "report"];

// This policy is passed to the private connector before any external operation.
// The connector must enforce it as well as its tenant-scoped provider permissions.
function connectorExecutionPolicy(project, now = Date.now()) {
  const start = Number(project.cutover_start), end = Number(project.cutover_end);
  const phase = project.phase === "intake" ? "preflight" : project.phase;
  const index = PHASES.indexOf(phase);
  if (index < 0 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || now >= end) throw new Error("migration authorization is invalid or expired");
  const canReachCutover = ["delta_sync", "preauthorized_cutover"].includes(phase);
  return {
    wait_until: canReachCutover && now < start ? start : null,
    allowed_phases: PHASES.slice(index, index + 2).filter(p => p !== "preauthorized_cutover" || now >= start),
    cutover_not_before: start, expires_at: end,
    source_deletion_allowed: false, scope_expansion_allowed: false,
  };
}

export { connectorExecutionPolicy };
