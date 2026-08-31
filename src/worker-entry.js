import application from "./index.js";
import { handleAgentConnectionRoutes, processAgentConnections } from "./agent-connections.js";
import { runHostedAgentCycle } from "./hosted-agent.js";
import { paymentRpcHealth } from './payment-rpc.js';
import { handleChainRoutes } from './alchemy-chains.js';
export { MigrationWorkflow } from "./migration-workflow.js";

export default {
  async fetch(request, env, ctx) {
    const chain=await handleChainRoutes(request,env,()=>application.fetch(new Request(new URL('/admin/config',request.url),{headers:request.headers}),env,ctx));
    if(chain)return chain;
    if (new URL(request.url).pathname === '/admin/payment-rpc-health') {
      // Reuse the application's owner authentication; never expose a public
      // RPC proxy or place a token in a URL. This diagnostic moves no money.
      const auth = await application.fetch(new Request(new URL('/admin/config',request.url),{headers:request.headers}),env,ctx);
      if (!auth.ok) return auth;
      if (request.method !== 'GET') return new Response('Method not allowed',{status:405});
      return Response.json(await paymentRpcHealth(env),{headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
    }
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
