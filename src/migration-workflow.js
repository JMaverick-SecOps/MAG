import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { migrationReadiness, recordConnectorResult, validateConnectorResult } from "./migration-engine.js";
import { connectorExecutionPolicy } from "./migration-policy.js";

const MAX_RESPONSE_BYTES = 65536;
const MAX_BATCHES_PER_INSTANCE = 250;

async function readBoundedJson(response, maximum = MAX_RESPONSE_BYTES) {
  if (!response.body) throw new Error("connector returned an empty response");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) throw new Error("connector response exceeds the bounded result size");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) { await reader.cancel("response too large"); throw new Error("connector response exceeds the bounded result size"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function connectorAdvance(connector, payload) {
  const response = await connector.fetch("https://migration-connector.internal/v1/migrations/advance", { method: "POST", headers: { "content-type": "application/json", "x-mag-contract": "mag.migration.connector.v1" }, body: JSON.stringify(payload) });
  if (!response.ok) {
    if ([400, 401, 403, 404, 409, 422].includes(response.status)) throw new NonRetryableError(`connector refused the bounded request (${response.status})`);
    throw new Error(`connector temporarily failed (${response.status})`);
  }
  const raw = await readBoundedJson(response);
  validateConnectorResult(raw);
  return raw;
}

export class MigrationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const projectId = String(event.payload?.projectId || "");
    const generation = Number(event.payload?.generation || 0);
    if (!/^[0-9a-f-]{36}$/i.test(projectId) || !Number.isInteger(generation) || generation < 0) throw new NonRetryableError("invalid migration workflow payload");
    if (!this.env.MIGRATION_CONNECTOR) throw new NonRetryableError("private migration connector binding is not configured");

    const readiness = await step.do("load authorized project", async () => await migrationReadiness(this.env.DB, projectId, { execution: true, expectedGeneration: generation }));
    if (!readiness.ready) throw new NonRetryableError(`migration is not ready: ${readiness.reasons.join(",")}`);

    let cursor = await step.do("load continuation cursor", async () => {
      const row = await this.env.DB.prepare("SELECT continuation_cursor FROM migration_projects WHERE id=?").bind(projectId).first();
      return row?.continuation_cursor || null;
    });

    for (let index = 0; index < MAX_BATCHES_PER_INSTANCE; index += 1) {
      const idempotencyKey = `${projectId}:${generation}:${index}`;
      const policy = await step.do(`authorize batch ${index}`, async () => {
        const fresh = await migrationReadiness(this.env.DB, projectId, { execution: true, expectedGeneration: generation });
        if (!fresh.ready) throw new NonRetryableError(`migration authorization changed: ${fresh.reasons.join(",")}`);
        return connectorExecutionPolicy(fresh.project);
      });
      if (policy.wait_until) await step.sleepUntil(`wait for cutover ${index}`, new Date(policy.wait_until));
      const result = await step.do(`connector batch ${String(index).padStart(3, "0")}`, { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => {
        // Re-read on every retry, including after a durable sleep.
        const fresh = await migrationReadiness(this.env.DB, projectId, { execution: true, expectedGeneration: generation });
        if (!fresh.ready) throw new NonRetryableError(`migration authorization changed: ${fresh.reasons.join(",")}`);
        const authorization = connectorExecutionPolicy(fresh.project);
        if (authorization.wait_until) throw new NonRetryableError("cutover window has not opened");
        return connectorAdvance(this.env.MIGRATION_CONNECTOR, { contract: "mag.migration.connector.v1", project_id: projectId, generation, cursor, idempotency_key: idempotencyKey, execution_authorization: authorization });
      });
      await step.do(`record batch ${String(index).padStart(3, "0")}`, async () => await recordConnectorResult(this.env.DB, projectId, result, { generation, idempotencyKey }));
      if (result.status === "complete" || result.status === "blocked") return { project_id: projectId, generation, status: result.status, phase: result.phase };
      cursor = result.cursor;
    }

    const continuation = await step.do("reserve continuation", async () => {
      const nextGeneration = generation + 1;
      const instanceId = `migration-${projectId}-g${nextGeneration}`;
      const result = await this.env.DB.prepare("UPDATE migration_projects SET workflow_generation=?,workflow_instance_id=?,continuation_cursor=?,status='starting',updated_at=? WHERE id=? AND workflow_generation=? AND status='running'").bind(nextGeneration, instanceId, cursor, Date.now(), projectId, generation).run();
      if (Number(result?.meta?.changes ?? 0) !== 1) throw new NonRetryableError("migration continuation state could not be reserved");
      return { instanceId, nextGeneration };
    });
    try {
      await step.do("start continuation", async () => {
        await this.env.MIGRATION_WORKFLOW.createBatch([{ id: continuation.instanceId, params: { projectId, generation: continuation.nextGeneration } }]);
        return { instance_id: continuation.instanceId };
      });
      await step.do("record continuation", async () => await this.env.DB.prepare("UPDATE migration_projects SET status='running',updated_at=? WHERE id=? AND workflow_generation=? AND workflow_instance_id=? AND status='starting'").bind(Date.now(), projectId, continuation.nextGeneration, continuation.instanceId).run());
    } catch (error) {
      await step.do("release failed continuation", async () => await this.env.DB.prepare("UPDATE migration_projects SET status='needs_attention',workflow_instance_id=NULL,workflow_generation=workflow_generation+1,updated_at=? WHERE id=? AND workflow_generation=? AND workflow_instance_id=?").bind(Date.now(), projectId, continuation.nextGeneration, continuation.instanceId).run());
      throw error;
    }
    return { project_id: projectId, generation, status: "continued", next_generation: continuation.nextGeneration };
  }
}

export { connectorAdvance, readBoundedJson };
