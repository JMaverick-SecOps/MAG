import test from 'node:test';
import assert from 'node:assert/strict';
import {TestD1} from './helpers/d1.js';
import {RPCS,createPaymentRpc,paymentRpcProviders,paymentRpcHealth} from '../src/payment-rpc.js';
import {transferRequest,verifyPaymentIntent,USDC} from '../src/payment-intents.js';
import {verifyBaseUsdcTransfer} from '../src/commerce.js';
const env={MAG_BASE_RPC_PRIMARY_URL:'https://base-mainnet.g.alchemy.com/v2/SYNTHETIC-KEY',MAG_BASE_RPC_SECONDARY_URL:'https://synthetic.base-mainnet.quiknode.pro/SYNTHETIC-KEY/'};
function db(t){const DB=new TestD1();t.after(()=>DB.close());return DB;}
test('two operator configuration supports secrets and rejects partial, duplicate, insecure or unapproved hosts',()=>{
  assert.deepEqual(paymentRpcProviders(env).map(p=>p.operator),['alchemy','quicknode']);
  assert.equal(paymentRpcProviders({}).length,2);
  for(const patch of [
    {MAG_BASE_RPC_SECONDARY_URL:''},
    {MAG_BASE_RPC_SECONDARY_URL:'https://base-mainnet.g.alchemy.com/v2/OTHER'},
    {MAG_BASE_RPC_PRIMARY_URL:'http://base-mainnet.g.alchemy.com/v2/key'},
    {MAG_BASE_RPC_PRIMARY_URL:'https://base-mainnet.g.alchemy.com.attacker.invalid/key'},
    {MAG_BASE_RPC_PRIMARY_URL:'https://user:key@base-mainnet.g.alchemy.com/v2/key'},
    {MAG_BASE_RPC_PRIMARY_URL:'https://127.0.0.1/'},
  ])assert.throws(()=>paymentRpcProviders({...env,...patch}));
});
test('HTTP 429 honors Retry-After across fresh clients; recovery retries without human credit',async t=>{
  const DB=db(t);let now=1000000,calls=0;
  const fetcher=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});};
  await assert.rejects(createPaymentRpc({...env,DB},fetcher,()=>now).request(0,'eth_chainId'),/rate_limited/);
  const row=DB.prepare('SELECT * FROM payment_rpc_backoff').first();assert.equal(row.retry_at,now+120000);
  await assert.rejects(createPaymentRpc({...env,DB},fetcher,()=>now).request(0,'eth_chainId'),/backoff/);
  assert.equal(calls,1);
  now+=120001;
  assert.equal(await createPaymentRpc({...env,DB},async()=>{calls++;return Response.json({result:'0x2105'});},()=>now).request(0,'eth_chainId'),'0x2105');
  assert.equal(calls,2);
  assert.equal(DB.prepare('SELECT COUNT(*) n FROM payment_receipt_claims').first().n,0);
});
test('date Retry-After, JSON-RPC quota, invalid JSON and transport errors never leak credentials',async t=>{
  const DB=db(t), now=Date.parse('2026-08-31T19:00:00Z');
  for(const response of [()=>new Response('',{status:429,headers:{'retry-after':new Date(now+180000).toUTCString()}}),()=>Response.json({error:{code:-32001,message:'SYNTHETIC-KEY'}}),()=>new Response('SYNTHETIC-KEY'),()=>{throw Error('SYNTHETIC-KEY');}]){
    DB.prepare('DELETE FROM payment_rpc_backoff').run();
    await assert.rejects(createPaymentRpc({...env,DB},async()=>response(),()=>now).request(0,'eth_chainId'),e=>!String(e).includes('SYNTHETIC-KEY'));
    assert.ok(DB.prepare('SELECT retry_at FROM payment_rpc_backoff').first().retry_at>now);
    assert.ok(!JSON.stringify(DB.prepare('SELECT * FROM payment_rpc_backoff').all()).includes('SYNTHETIC-KEY'));
  }
});
test('each provider is serialized, repeated reads coalesce, outage stops the remaining burst',async()=>{
  let calls=0,active=0,max=0;
  const client=createPaymentRpc({},async()=>{calls++;active++;max=Math.max(max,active);await Promise.resolve();active--;return Response.json({result:'0x2105'});});
  await Promise.all([client.request(0,'eth_chainId'),client.request(0,'eth_chainId'),client.request(0,'eth_blockNumber')]);
  assert.equal(calls,2);assert.equal(max,1);
  calls=0;const failed=createPaymentRpc({},async()=>{calls++;return new Response('',{status:429});});
  const results=await Promise.allSettled([failed.request(0,'eth_chainId'),failed.request(0,'eth_blockNumber'),failed.request(0,'eth_getBlockByNumber',['finalized',false])]);
  assert.equal(calls,1);assert.ok(results.every(r=>r.status==='rejected'));
});
test('transport rejects redirects, excessive responses and every write/signing method',async()=>{
  const redirected=createPaymentRpc({},async(url,init)=>{assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{location:'https://attacker.invalid'}});});
  await assert.rejects(redirected.request(0,'eth_chainId'),/http_302/);
  await assert.rejects(createPaymentRpc({},async()=>new Response('x'.repeat(1000001))).request(0,'eth_chainId'),/oversized/);
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','wallet_sendCalls'])await assert.rejects(createPaymentRpc({},()=>{throw Error('must not call');}).request(0,method),/read_only/);
});
test('health is metadata only, two witnesses required; wrong chain and outage fail closed',async()=>{
  const good=async(url,init)=>Response.json({result:JSON.parse(init.body).method==='eth_chainId'?'0x2105':{number:'0x100',hash:'0x'+'c'.repeat(64)}});
  const health=await paymentRpcHealth(env,good);assert.equal(health.ready,true);assert.equal(health.real_payment,false);assert.ok(!JSON.stringify(health).includes('SYNTHETIC-KEY'));
  assert.equal((await paymentRpcHealth(env,async(url,init)=>url===env.MAG_BASE_RPC_PRIMARY_URL?Response.json({result:'0x1'}):good(url,init))).ready,false);
  assert.equal((await paymentRpcHealth(env,async()=>new Response('',{status:429}))).ready,false);
});
test('bound orders, subscriptions, agent-days and legacy transfers use configured witnesses without fallback',async()=>{
  const treasury='0x'+'a'.repeat(40), hash='0x'+'b'.repeat(64), block='0x'+'c'.repeat(64), calls=[];
  for(const purpose of ['service_order','subscription_invoice','agent_connection_day']){
    const payment=await transferRequest(purpose,crypto.randomUUID(),treasury,'1000000');
    const receipt={transactionHash:hash,status:'0x1',blockNumber:'0x100',blockHash:block,logs:[{address:USDC,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef','0x'+'0'.repeat(64),'0x'+treasury.slice(2).padStart(64,'0')],data:'0xf4240'}]};
    const fetcher=async(url,init)=>{calls.push(url);const method=JSON.parse(init.body).method;return Response.json({result:method==='eth_chainId'?'0x2105':method==='eth_getTransactionReceipt'?receipt:method==='eth_getTransactionByHash'?{hash,blockHash:block,to:USDC,input:payment.data,value:'0x0'}:method==='eth_blockNumber'?'0x120':{number:'0x110'}});};
    assert.equal((await verifyPaymentIntent({...payment,calldata:payment.data},hash,fetcher,env)).verified,true);
    assert.equal((await verifyBaseUsdcTransfer(hash,treasury,'1000000',fetcher,12n,env)).verified,true);
    await assert.rejects(verifyPaymentIntent({...payment,calldata:payment.data},hash,(url,init)=>url===env.MAG_BASE_RPC_SECONDARY_URL?Promise.resolve(new Response('',{status:429})):fetcher(url,init),env));
  }
  assert.deepEqual([...new Set(calls)].sort(),[env.MAG_BASE_RPC_PRIMARY_URL,env.MAG_BASE_RPC_SECONDARY_URL].sort());
  assert.ok(calls.every(url=>!RPCS.includes(url)));
});
