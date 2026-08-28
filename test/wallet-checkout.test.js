import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
const script=readFileSync(new URL("../assets/wallet-checkout.js",import.meta.url),"utf8");
function fixture({sendError=null,stored=null}={}){
 const config={access_token:"fixture",intent_url:"/api/orders/order/payment-intent",receipt_url:"/api/orders/order/payment-receipts",status_url:"/api/orders/order"};
 const elements=Object.fromEntries(["wallet-checkout-config","wallet-pay","wallet-status","wallet-resume"].map(id=>[id,{textContent:id==="wallet-checkout-config"?JSON.stringify(config):"",disabled:false,hidden:true,handlers:{},addEventListener(event,fn){this.handlers[event]=fn;}}]));
 const values=new Map(stored?[["mag.pending-payment:"+config.intent_url,stored]]:[]),calls=[],requests=[];
 const hash="0x"+"b".repeat(64);
 const ctx={document:{getElementById:id=>elements[id]},sessionStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},setTimeout:()=>{},window:{ethereum:{request:async q=>{
  calls.push(q);
  if(q.method==="eth_requestAccounts")return ["0x"+"a".repeat(40)];
  if(q.method==="eth_chainId")return "0x2105";
  if(q.method==="eth_call")return "0x1";
  if(q.method==="eth_sendTransaction"){if(sendError)throw sendError;return hash;}
 }}},fetch:async(path,options)=>{
  requests.push({path,options});
  const payload=path.endsWith("payment-intent")?{payment_request:{chainId:"0x2105",to:"0x"+"c".repeat(40),value:"0x0",data:"0xa9059cbb"}}:path.endsWith("payment-receipts")?{payment_status:"pending_verification"}:{order:{payment_status:"verified"}};
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

