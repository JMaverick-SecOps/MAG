import test from 'node:test';
import assert from 'node:assert/strict';
import {EVM_NETWORKS,evmNetwork} from '../src/evm-networks.js';
import {chainCatalog,alchemyReadHealth,handleChainRoutes} from '../src/alchemy-chains.js';
import {createAlchemyReadRpc,createPaymentRpc} from '../src/payment-rpc.js';
import {transferRequest,verifyPaymentIntent,USDC} from '../src/payment-intents.js';
import {TestD1} from './helpers/d1.js';
const key='SYNTHETIC-ALCHEMY-READ-ONLY';
const env={MAG_ALCHEMY_API_KEY:key};
const block={number:'0x100',hash:'0x'+'c'.repeat(64)};
function good(profile,calls=[]){return async(url,init)=>{calls.push({url,method:JSON.parse(init.body).method});return Response.json({result:JSON.parse(init.body).method==='eth_chainId'?profile.chain_hex:block});};}

test('chain catalog separates Base invoices, Ethereum, Robinhood mainnet and testnet',()=>{
  const catalog=chainCatalog();assert.equal(catalog.default_payment_network,'base');
  assert.deepEqual(catalog.networks.map(n=>n.chain_id),[8453,1,4663,46630]);
  for(const p of Object.values(EVM_NETWORKS))assert.equal(BigInt(p.chain_hex),BigInt(p.chain_id));
  assert.equal(evmNetwork('robinhood').native_usdc,null);
  assert.equal(evmNetwork('robinhood-testnet').checkout_implementation,'never_accept_testnet_payments');
  assert.ok(catalog.networks.every(n=>!n.payment_readiness_verified));
  for(const invalid of ['constructor','__proto__','https://attacker.invalid',8453])assert.throws(()=>evmNetwork(invalid),/unsupported_network/);
  assert.ok(!JSON.stringify(catalog).includes(key));
});
test('Alchemy read probes verify the requested chain and never claim payment readiness',async()=>{
  for(const profile of Object.values(EVM_NETWORKS)){
    const calls=[],health=await alchemyReadHealth(env,profile.id,good(profile,calls));
    assert.equal(health.ready,true);assert.equal(health.payment_eligible,false);assert.equal(health.real_payment,false);
    assert.deepEqual(calls.map(c=>c.method),['eth_chainId','eth_getBlockByNumber']);
    assert.ok(calls.every(c=>new URL(c.url).hostname===profile.alchemy_host));
    assert.ok(!JSON.stringify(health).includes(key));
  }
});
test('missing credentials, wrong chain, bad finality and injected keys fail closed',async()=>{
  assert.equal((await alchemyReadHealth({},'base')).reason,'alchemy_credential_missing');
  for(const bad of ['key\nheader: injected','https://attacker.invalid',{},'short'])assert.throws(()=>createAlchemyReadRpc({MAG_ALCHEMY_API_KEY:bad},'base'),/invalid_alchemy_credential/);
  const health=await alchemyReadHealth(env,'robinhood',good(EVM_NETWORKS.base));
  assert.equal(health.ready,false);assert.equal(health.reason,'wrong_chain');
  assert.equal((await alchemyReadHealth(env,'base',async(u,i)=>Response.json({result:JSON.parse(i.body).method==='eth_chainId'?'0x2105':{number:'0x1'}}))).reason,'invalid_finality');
});
test('read development cannot sign, send, approve or bridge and shares persistent quota backoff',async t=>{
  const DB=new TestD1();t.after(()=>DB.close());let calls=0;
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign','wallet_sendCalls','wallet_addEthereumChain'])await assert.rejects(createAlchemyReadRpc(env,'base',()=>{calls++;}).request(method),/read_only/);
  assert.equal(calls,0);
  const fetcher=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});};
  await assert.rejects(createAlchemyReadRpc({...env,DB},'base',fetcher,()=>100000).request('eth_blockNumber'),/rate_limited/);
  await assert.rejects(createAlchemyReadRpc({...env,DB},'base',fetcher,()=>100001).request('eth_blockNumber'),/backoff/);
  assert.equal(calls,1);assert.ok(!JSON.stringify(DB.prepare('SELECT * FROM payment_rpc_backoff').all()).includes(key));
});
test('Alchemy admin diagnostic requires auth and cannot be used as an arbitrary RPC proxy',async()=>{
  let reads=0;const fetcher=async()=>{reads++;throw Error('not expected');};
  const denied=()=>new Response('Unauthorized',{status:401});const allowed=()=>new Response('{}');
  assert.equal((await handleChainRoutes(new Request('https://mag.test/admin/alchemy/health?network=ethereum'),env,denied,fetcher)).status,401);
  assert.equal((await handleChainRoutes(new Request('https://mag.test/admin/alchemy/health?network=constructor'),env,allowed,fetcher)).status,400);
  assert.equal((await handleChainRoutes(new Request('https://mag.test/admin/alchemy/health',{method:'POST'}),env,allowed,fetcher)).status,405);
  assert.equal(reads,0);
  const response=await handleChainRoutes(new Request('https://mag.test/admin/alchemy/health?network=robinhood'),env,allowed,good(EVM_NETWORKS.robinhood));
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).ready,true);
  assert.equal((await handleChainRoutes(new Request('https://mag.test/api/chains'),{},denied,fetcher)).status,200);
});
test('new development networks cannot redirect Base invoices or substitute a single payment witness',async()=>{
  const p=await transferRequest('agent_connection_day',crypto.randomUUID(),'0x'+'a'.repeat(40),'1000000');
  assert.equal(p.chainId,'0x2105');assert.equal(p.to,USDC);
  assert.equal(createPaymentRpc(env).providers.length,2);
  const result=await verifyPaymentIntent({...p,calldata:p.data},'0x'+'b'.repeat(64),good(EVM_NETWORKS.robinhood),env);
  assert.equal(result.verified,false);assert.equal(result.reason,'wrong_chain');
});
