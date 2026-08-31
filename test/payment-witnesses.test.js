// Lesson from 1F916 post #2776: two observations are not proof of independent
// failure domains. These are synthetic fault tests, not an on-chain receipt.
import test from "node:test";
import assert from "node:assert/strict";
import { RPCS, USDC, transferRequest, verifyPaymentIntent } from "../src/payment-intents.js";
const TX="0x"+"b".repeat(64), TREASURY="0x"+"a".repeat(40), BLOCK="0x"+"c".repeat(64);
async function fixture() {
  const request=await transferRequest("service_order",crypto.randomUUID(),TREASURY,"49000000");
  const intent={...request,calldata:request.data};
  const base={
    receipt:{transactionHash:TX,blockHash:BLOCK,blockNumber:"0x100",status:"0x1",logs:[{address:USDC,topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+"0".repeat(64),"0x"+TREASURY.slice(2).padStart(64,"0")],data:"0x"+BigInt(intent.amount_atomic).toString(16)}]},
    transaction:{hash:TX,blockHash:BLOCK,to:USDC,input:request.data,value:"0x0"},
    finalized:{number:"0x101"}
  };
  function fetcher(mutate=()=>{}) {return async(url,init)=>{
    const state=structuredClone(base);mutate(state,RPCS.indexOf(url));
    const method=JSON.parse(init.body).method;
    return Response.json({result:method==="eth_chainId"?"0x2105":method==="eth_getTransactionReceipt"?state.receipt:method==="eth_getTransactionByHash"?state.transaction:state.finalized});
  };}
  return {intent,fetcher};
}
test("positive control: agreeing synthetic finalized observations pass the narrow predicate",async()=>{
  const f=await fixture();
  assert.equal((await verifyPaymentIntent(f.intent,TX,f.fetcher())).verified,true);
});
test("either witness can independently falsify finality, reference or transfer amount",async()=>{
  for(const failingWitness of [0,1]){
    for(const [mutation,reason] of [
      [state=>{state.finalized.number="0xff";},"payment_not_finalized"],
      [state=>{state.transaction.input=state.transaction.input.slice(0,-1)+"f";},"payment_reference_mismatch"],
      [state=>{state.receipt.logs[0].data="0x1";},"exact_transfer_not_found"]
    ]){
      const f=await fixture();
      // Force a difference even if the last reference nibble happened to be f.
      const fetcher=f.fetcher((state,witness)=>{if(witness===failingWitness){mutation(state);if(reason==="payment_reference_mismatch")state.transaction.input="0x";}});
      const result=await verifyPaymentIntent(f.intent,TX,fetcher);
      assert.equal(result.verified,false);assert.equal(result.reason,reason);
    }
  }
});
test("individually consistent but disagreeing block observations fail",async()=>{
  const f=await fixture();
  const result=await verifyPaymentIntent(f.intent,TX,f.fetcher((state,witness)=>{
    if(witness===1){state.receipt.blockHash="0x"+"d".repeat(64);state.transaction.blockHash=state.receipt.blockHash;}
  }));
  assert.equal(result.reason,"rpc_disagreement");
});
test("either unavailable witness prevents a verified payment result",async()=>{
  for(const unavailable of [0,1]){
    const f=await fixture(), valid=f.fetcher();
    await assert.rejects(()=>verifyPaymentIntent(f.intent,TX,(url,init)=>RPCS.indexOf(url)===unavailable?Promise.resolve(new Response("",{status:503})):valid(url,init)),/RPC unavailable/);
  }
});
test("joint blind spot: both mocked witnesses can agree on fabricated evidence",async()=>{
  const f=await fixture();
  const result=await verifyPaymentIntent(f.intent,TX,f.fetcher(state=>{
    state.receipt.blockHash="0x"+"e".repeat(64);state.transaction.blockHash=state.receipt.blockHash;
  }));
  assert.equal(result.verified,true);
  // Passing here documents trust in upstream RPC observations, not a real
  // transfer, provider independence, work acceptance, or spendable income.
});
