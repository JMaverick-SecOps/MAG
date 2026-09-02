import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const script=readFileSync(new URL("../assets/wallet-checkout.js",import.meta.url),"utf8");
function fixture({sendError=null,stored=null,paymentRequest={}}={}){
 const config={access_token:"fixture",intent_url:"/api/orders/order/payment-intent",receipt_url:"/api/orders/order/payment-receipts",status_url:"/api/orders/order"};
 const elements=Object.fromEntries(["wallet-checkout-config","wallet-pay","wallet-status","wallet-resume"].map(id=>[id,{textContent:id==="wallet-checkout-config"?JSON.stringify(config):"",disabled:false,hidden:true,handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}}]));
 const values=new Map(stored?[["mag.pending-payment:"+config.intent_url,stored]]:[]),calls=[],requests=[];
 const hash="0x"+"b".repeat(64);
 const treasury="0x"+"d".repeat(40),amount="1000000",reference="e".repeat(64);
 const data="0xa9059cbb"+treasury.slice(2).padStart(64,"0")+BigInt(amount).toString(16).padStart(64,"0")+reference;
 const intent={chainId:"0x2105",to:"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",value:"0x0",data,reference,amount_atomic:amount,treasury_address:treasury,...paymentRequest};
 const ctx={document:{getElementById:id=>elements[id]},sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},setTimeout:()=>{},window:{ethereum:{request:async q=>{
  calls.push(q);
  if(q.method==="eth_requestAccounts")return ["0x"+"a".repeat(40)];
  if(q.method==="eth_chainId")return "0x2105";
  if(q.method==="eth_call")return "0x1";
  if(q.method==="eth_sendTransaction"){if(sendError)throw sendError;return hash;}
 }}},fetch:async(path,options)=>{
  requests.push({path,options});
  const payload=path.endsWith("payment-intent")?{payment_request:intent}:path.endsWith("payment-receipts")?{payment_status:"pending_verification"}:{order:{payment_status:"verified"}};
  return {ok:true,json:async()=>payload};
 }};
 runInNewContext(script,ctx);
 return {elements,calls,requests,values,hash,click:()=>elements["wallet-pay"].handlers.click()};
}
test("wallet checkout fills the transaction, asks for wallet approval and saves its receipt",async()=>{
 const f=fixture();await f.click();
 assert.equal(f.calls.filter(x=>x.method==="eth_sendTransaction").length,1);
 assert.equal(f.calls.find(x=>x.method==="eth_sendTransaction").params[0].value,"0x0");
 const receipt=f.requests.find(x=>x.path.endsWith("payment-receipts"));
 assert.equal(JSON.parse(receipt.options.body).tx_hash,f.hash);
 assert.ok(f.elements["wallet-pay"].disabled);
 assert.match(f.elements["wallet-status"].textContent,/Payment submitted/);
});
test("wallet checkout refuses a payment whose displayed asset is not derived from the encoded token and amount",async()=>{
 for(const paymentRequest of [{to:"0x"+"c".repeat(40)},{amount_atomic:"1000001"},{treasury_address:"0x"+"a".repeat(40)}]){
  const f=fixture({paymentRequest});await f.click();
  assert.equal(f.calls.some(x=>x.method==="eth_sendTransaction"),false);
  assert.match(f.elements["wallet-status"].textContent,/asset or unit provenance is invalid/);
 }
});
test("unknown send outcome stays disabled, while an explicit wallet rejection may retry",async()=>{
 const unknown=fixture({sendError:new Error("connection lost")});await unknown.click();
 assert.ok(unknown.elements["wallet-pay"].disabled);
 assert.match(unknown.elements["wallet-status"].textContent,/unknown/);
 const rejected=fixture({sendError:Object.assign(new Error("User rejected"),{code:4001})});await rejected.click();
 assert.equal(rejected.elements["wallet-pay"].disabled,false);
 assert.equal(rejected.requests.filter(x=>x.path.endsWith("payment-receipts")).length,0);
});
test("returning to a sent or uncertain transfer does not initiate a second payment",()=>{
 for(const stored of ["0x"+"b".repeat(64),"unknown"]){
  const f=fixture({stored});assert.equal(f.elements["wallet-pay"].disabled,true);assert.equal(f.calls.length,0);
 }
});
