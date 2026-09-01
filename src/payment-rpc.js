// Read-only payment transport. Authenticated endpoint URLs belong in Worker
// secrets, never public config, response bodies or logs.
import { evmNetwork } from './evm-networks.js';
const RPCS = Object.freeze(['https://mainnet.base.org', 'https://base-rpc.publicnode.com']);
const READ_METHODS = new Set(['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getBlockByNumber', 'eth_blockNumber']);
const MAX_BYTES = 1_000_000;
class PaymentRpcError extends Error {
  constructor(code, retryAt = null) { super('payment RPC unavailable: ' + code); this.code = code; this.retryAt = retryAt; }
}
function operator(url) {
  if (url.hostname === 'mainnet.base.org') return 'base';
  if (url.hostname === 'base-rpc.publicnode.com') return 'publicnode';
  if (url.hostname === 'base-mainnet.g.alchemy.com') return 'alchemy';
  if (/^[a-z0-9-]+\.base-mainnet\.quiknode\.pro$/.test(url.hostname)) return 'quicknode';
  if (url.hostname === 'base.api.onfinality.io') return 'onfinality';
  throw new PaymentRpcError('unsupported_provider');
}
function paymentRpcProviders(env = {}) {
  const a=env.MAG_BASE_RPC_PRIMARY_URL, b=env.MAG_BASE_RPC_SECONDARY_URL;
  if (Boolean(a)!==Boolean(b)) throw new PaymentRpcError('both_witnesses_required');
  const providers=(a&&b?[a,b]:RPCS).map(value=>{
    let url; try {url=new URL(value);} catch {throw new PaymentRpcError('invalid_provider');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash)throw new PaymentRpcError('invalid_provider');
    return {url:String(value),operator:operator(url)};
  });
  if(providers[0].operator===providers[1].operator)throw new PaymentRpcError('distinct_operators_required');
  return providers;
}
async function boundedJson(response) {
  const reader=response.body?.getReader(), chunks=[]; let size=0;
  if(!reader)throw new PaymentRpcError('missing_response');
  try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>MAX_BYTES)throw new PaymentRpcError('oversized_response');chunks.push(part.value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error;} finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new PaymentRpcError('invalid_response');}
}
function retryAfter(value, now) {
  if(!value)return 0;
  const seconds=/^\d+$/.test(value)?Number(value):NaN;
  const time=Number.isFinite(seconds)?now+seconds*1000:Date.parse(value);
  return Number.isFinite(time)?Math.min(now+86400000,Math.max(now,time)):0;
}
async function fingerprint(url) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// One client per verification operation. Serializes each witness's requests,
// coalesces identical reads and suppresses further requests after a failure.
// D1 backoff survives isolates/restarts; no payment is ever marked failed/paid
// because of an outage. The existing scheduled processors resume automatically.
function createPaymentRpc(env = {}, fetcher = fetch, clock = Date.now) {
  return readOnlyTransport(env, fetcher, clock, paymentRpcProviders(env));
}
// This single-provider client is for development reads only. Payment settlement
// still exclusively constructs createPaymentRpc's two independent witnesses.
function createAlchemyReadRpc(env, network, fetcher = fetch, clock = Date.now) {
  const profile=evmNetwork(network), key=env.MAG_ALCHEMY_API_KEY;
  if(!key)throw new PaymentRpcError('alchemy_credential_missing');
  if(typeof key!=='string'||! /^[A-Za-z0-9_-]{20,128}$/.test(key))throw new PaymentRpcError('invalid_alchemy_credential');
  const client=readOnlyTransport(env,fetcher,clock,[{operator:'alchemy',url:`https://${profile.alchemy_host}/v2/${key}`}]);
  let chainCheck;
  return {request:async(method,params=[])=>{
    if(!READ_METHODS.has(method))throw new PaymentRpcError('read_only_method_required');
    chainCheck??=client.request(0,'eth_chainId').then(chain=>{
      if(chain!==profile.chain_hex)throw new PaymentRpcError('wrong_chain');
      return chain;
    });
    const chain=await chainCheck;
    return method==='eth_chainId'?chain:client.request(0,method,params);
  }};
}
function readOnlyTransport(env, fetcher, clock, providers) {
  const states=new Map();
  function request(index, method, params=[]) {
    if(!READ_METHODS.has(method))return Promise.reject(new PaymentRpcError('read_only_method_required'));
    const provider=providers[index];if(!provider)return Promise.reject(new PaymentRpcError('invalid_witness'));
    let state=states.get(index);
    if(!state){state={tail:Promise.resolve(),cache:new Map(),failure:null};states.set(index,state);}
    const cacheKey=JSON.stringify([method,params]);if(state.cache.has(cacheKey))return state.cache.get(cacheKey);
    const operation=state.tail.then(async()=>{
      if(state.failure)throw state.failure;
      const now=clock(), key=await fingerprint(provider.url);
      const prior=env.DB?await env.DB.prepare('SELECT failures,retry_at,last_failure_at FROM payment_rpc_backoff WHERE provider_key=?').bind(key).first():null;
      if(prior&&prior.retry_at>now){state.failure=new PaymentRpcError('backoff',prior.retry_at);throw state.failure;}
      let retry=0;
      try {
        const response=await fetcher(provider.url,{method:'POST',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(15000)});
        if(!response.ok){retry=retryAfter(response.headers.get('retry-after'),now);await response.body?.cancel().catch(()=>{});throw new PaymentRpcError(response.status===429?'rate_limited':'http_'+response.status);}
        const body=await boundedJson(response);
        if(!body||body.error||!Object.hasOwn(body,'result'))throw new PaymentRpcError(body?.error?'rpc_rejected':'invalid_response');
        return body.result;
      } catch(error) {
        const failures=prior&&now-prior.last_failure_at<86400000?Math.min(10,prior.failures+1):1;
        const until=Math.max(retry,now+Math.min(3600000,60000*2**(failures-1)));
        const code=error instanceof PaymentRpcError?error.code:'transport_error';
        state.failure=new PaymentRpcError(code,until);
        if(env.DB)await env.DB.prepare('INSERT INTO payment_rpc_backoff(provider_key,operator,failures,retry_at,last_failure_at,error_code) VALUES(?,?,?,?,?,?) ON CONFLICT(provider_key) DO UPDATE SET failures=excluded.failures,retry_at=MAX(payment_rpc_backoff.retry_at,excluded.retry_at),last_failure_at=excluded.last_failure_at,error_code=excluded.error_code').bind(key,provider.operator,failures,until,now,code).run();
        throw state.failure;
      }
    });
    state.tail=operation.catch(()=>{});state.cache.set(cacheKey,operation);return operation;
  }
  return {providers:providers.map(p=>({operator:p.operator})),request};
}
async function paymentRpcHealth(env, fetcher=fetch) {
  let client;try{client=createPaymentRpc(env,fetcher);}catch(error){return {ready:false,reason:error.code||'invalid_configuration',witnesses:[]};}
  const witnesses=await Promise.all(client.providers.map(async(provider,index)=>{
    try {
      const chain=await client.request(index,'eth_chainId');
      if(chain!=='0x2105')throw new PaymentRpcError('wrong_chain');
      const block=await client.request(index,'eth_getBlockByNumber',['finalized',false]);
      if(!/^0x[0-9a-f]+$/i.test(block?.number||'')||!/^0x[0-9a-f]{64}$/i.test(block?.hash||''))throw new PaymentRpcError('invalid_finality');
      const txHash=(Array.isArray(block.transactions)?block.transactions:[]).find(value=>/^0x[0-9a-f]{64}$/i.test(value||''));
      if(!txHash)throw new PaymentRpcError('historical_sample_unavailable');
      const transaction=await client.request(index,'eth_getTransactionByHash',[txHash]);
      const receipt=await client.request(index,'eth_getTransactionReceipt',[txHash]);
      if(String(transaction?.hash||'').toLowerCase()!==txHash.toLowerCase()||
        String(receipt?.transactionHash||'').toLowerCase()!==txHash.toLowerCase()||
        transaction?.blockHash!==block.hash||receipt?.blockHash!==block.hash||
        !/^0x[0-9a-f]+$/i.test(receipt?.blockNumber||''))throw new PaymentRpcError('historical_read_invalid');
      return {...provider,ready:true,finalized_number:block.number,finalized_hash:block.hash,historical_transaction:true,historical_receipt:true};
    }catch(error){return {...provider,ready:false,reason:error.code||'unavailable',retry_at:error.retryAt||null};}
  }));
  // Historical read capability is not a real payment or complete checkout acceptance.
  return {ready:witnesses.every(w=>w.ready),scope:'chain_finality_and_historical_receipt_reads',witnesses,real_payment:false,checked_at:new Date().toISOString()};
}
async function collectWitnesses(client, observe) {
  // Drain both observations even on rejection: no orphan work after D1/test
  // teardown or a response, and never substitute a surviving single witness.
  const settled=await Promise.allSettled(client.providers.map(observe));
  const failed=settled.find(r=>r.status==='rejected');if(failed)throw failed.reason;
  return settled.map(r=>r.value);
}
export {RPCS, PaymentRpcError, paymentRpcProviders, createPaymentRpc, createAlchemyReadRpc, collectWitnesses, paymentRpcHealth};
