import {EVM_NETWORKS,evmNetwork} from './evm-networks.js';
import {createAlchemyReadRpc} from './payment-rpc.js';

function chainCatalog(){
  return {scope:'network_development_catalog_not_payment_readiness',default_payment_network:'base',custody:false,signing:false,bridging:false,
    networks:Object.values(EVM_NETWORKS).map(({alchemy_host,...network})=>({...network,native_gas_asset:'ETH',read_adapter:'alchemy',payment_readiness_verified:false})),
    notice:'Base invoices remain native USDC on chain 8453. Ethereum and Robinhood payments are not enabled. ETH gas is not an invoice asset; testnet tokens have no payment value.'};
}
async function alchemyReadHealth(env,network,fetcher=fetch){
  const profile=evmNetwork(network);
  const context={network:profile.id,chain_id:profile.chain_id,testnet:profile.testnet,operator:'alchemy',scope:'single_provider_read_connectivity_only',payment_eligible:false,real_payment:false};
  try{
    const client=createAlchemyReadRpc(env,network,fetcher);
    const block=await client.request('eth_getBlockByNumber',['finalized',false]);
    if(!/^0x[0-9a-f]+$/i.test(block?.number||'')||!/^0x[0-9a-f]{64}$/i.test(block?.hash||''))return {...context,ready:false,reason:'invalid_finality'};
    return {...context,ready:true,finalized_number:block.number,finalized_hash:block.hash,checked_at:new Date().toISOString()};
  }catch(error){return {...context,ready:false,reason:error.code||'unavailable',retry_at:error.retryAt||null};}
}
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
async function handleChainRoutes(request,env,authenticate,fetcher=fetch){
  const url=new URL(request.url);
  if(url.pathname==='/api/chains'){
    if(request.method!=='GET')return Response.json({error:'method_not_allowed'},{status:405,headers});
    return Response.json(chainCatalog(),{headers});
  }
  if(url.pathname!=='/admin/alchemy/health')return null;
  const auth=await authenticate();
  if(!auth.ok)return auth;
  if(request.method!=='GET')return Response.json({error:'method_not_allowed'},{status:405,headers});
  const network=url.searchParams.get('network')||'base';
  try{evmNetwork(network);}catch{return Response.json({error:'unsupported_network'},{status:400,headers});}
  // Fixed read probes only, not a public or arbitrary-method RPC proxy.
  return Response.json(await alchemyReadHealth(env,network,fetcher),{headers});
}
export {chainCatalog,alchemyReadHealth,handleChainRoutes};
