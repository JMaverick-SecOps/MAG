import application from "./index.js";
import { handleAgentConnectionRoutes, processAgentConnections } from "./agent-connections.js";
import { runHostedAgentCycle } from "./hosted-agent.js";
export { MigrationWorkflow } from "./migration-workflow.js";

export default {
  async fetch(request, env, ctx) {
    const connection = await handleAgentConnectionRoutes(request, env);
    return connection || application.fetch(request, env, ctx);
  },
  scheduled(event, env, ctx) {
    application.scheduled(event, env, ctx);
    ctx.waitUntil(processAgentConnections(env).then(async result => {
      const hosted = await runHostedAgentCycle(env);
      console.log(JSON.stringify({ event: "agent_connection_cycle", result, hosted }));
    }).catch(() => {
      console.warn(JSON.stringify({ event: "agent_connection_cycle", status: "deferred" }));
    }));
  },
};
