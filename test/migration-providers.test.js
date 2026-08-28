import test from "node:test";
import assert from "node:assert/strict";
import { CHUNK_BYTES, boundedBytes, GraphDriveClient, GoogleDriveClient, DropboxClient, GmailClient, GraphMailboxClient, validateChunk } from "../src/migration-provider-clients.js";
import { copyVerifiedFile } from "../src/migration-file-copy.js";
const token=async()=>"fixture-token";
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json",...headers}});
const range=(data,offset=0,total=data.length)=>new Response(data,{status:206,headers:{"content-range":"bytes "+offset+"-"+(offset+data.length-1)+"/"+total}});
test("Graph follows only operator-approved transfer hosts and never forwards OAuth to signed downloads",async()=>{
 const calls=[],data=new Uint8Array([1,2,3]);
 const client=new GraphDriveClient({driveId:"drive-id",rootId:"root:1",allowedTransferOrigins:["https://tenant.sharepoint.com"],token,fetcher:async(url,options)=>{
  calls.push({url,options});
  if(url.includes("/children"))return json({value:[]});
  if(url.includes("/content"))return new Response(null,{status:302,headers:{location:"https://tenant.sharepoint.com/download?signed=fixture"}});
  assert.equal(options.headers.Authorization,undefined);
  assert.equal(options.headers.Range,"bytes=0-2");return range(data);
 }});
 await client.listChildren();assert.match(calls[0].url,/root%3A1\/children/);
 assert.deepEqual(await client.readRange("file-id",0,3,3,"etag1"),data);
 assert.equal(calls[1].options.headers.Authorization,"Bearer fixture-token");
 await assert.rejects(()=>client.listChildren("root:1","https://evil.example/children"),/scope/);
 const blocked=new GraphDriveClient({driveId:"d",rootId:"r",token,fetcher:async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/secret"}})});
 await assert.rejects(()=>blocked.readRange("file",0,3,3,"v"),/allowlisted/);
});
test("Graph uploads fail on conflict and require exact provider-confirmed chunk offsets",async()=>{
 let step=0;const client=new GraphDriveClient({driveId:"d",rootId:"r",allowedTransferOrigins:["https://tenant.sharepoint.com"],token,fetcher:async(url,options)=>{
  step++;
  if(step===1){assert.equal(JSON.parse(options.body).item["@microsoft.graph.conflictBehavior"],"fail");return json({uploadUrl:"https://tenant.sharepoint.com/upload/session",expirationDateTime:"2026-08-30T00:00:00Z"});}
  assert.equal(options.headers.Authorization,undefined);
  if(step===2)return json({nextExpectedRanges:[CHUNK_BYTES+"-"]},202);
  return json({id:"target",size:CHUNK_BYTES+2},201);
 }});
 const session=await client.startUpload("example.bin",CHUNK_BYTES+2);
 assert.deepEqual(await client.uploadChunk(session,0,new Uint8Array(CHUNK_BYTES)),{done:false,next_offset:CHUNK_BYTES});
 assert.equal((await client.uploadChunk(session,CHUNK_BYTES,new Uint8Array(2))).item_id,"target");
 await assert.rejects(()=>client.startUpload("../escape",3),/file_name/);
 await assert.rejects(()=>client.startUpload("file",0),/file_size/);
 assert.throws(()=>validateChunk(1,8,new Uint8Array(7)),/unaligned/);
});
test("Google Drive resumable transfers pin parent, stable reference, scope and offsets",async()=>{
 const calls=[];const client=new GoogleDriveClient({rootId:"approved-root",token,fetcher:async(url,options)=>{
  calls.push({url,options});
  if(options.method==="POST"){
   assert.equal(JSON.parse(options.body).parents[0],"approved-root");
   assert.equal(JSON.parse(options.body).appProperties.magMigrationReference,"a".repeat(64));
   return new Response(null,{status:200,headers:{location:"https://www.googleapis.com/upload/drive/v3/files?upload_id=fixture"}});
  }
  if(options.headers["Content-Length"]==="0")return new Response(null,{status:308,headers:{range:"bytes=0-"+(CHUNK_BYTES-1)}});
  if(options.headers["Content-Range"].startsWith("bytes 0-"))return new Response(null,{status:308,headers:{range:"bytes=0-"+(CHUNK_BYTES-1)}});
  return json({id:"target"});
 }});
 const session=await client.startUpload("file.bin",CHUNK_BYTES+1,"a".repeat(64));
 assert.equal((await client.uploadChunk(session,0,new Uint8Array(CHUNK_BYTES))).next_offset,CHUNK_BYTES);
 assert.equal((await client.uploadStatus(session)).next_offset,CHUNK_BYTES);
 assert.equal((await client.uploadChunk(session,CHUNK_BYTES,new Uint8Array(1))).item_id,"target");
 await assert.rejects(()=>client.uploadStatus({...session,url:"https://www.googleapis.com/oauth2/token"}),/location/);
});
test("Dropbox is root-scoped, disables overwrites and returns a readable verified target path",async()=>{
 const client=new DropboxClient({rootPath:"/approved",token,fetcher:async(url,options)=>{
  if(url.endsWith("/start"))return json({session_id:"session"});
  if(url.endsWith("/finish")){
   const arg=JSON.parse(options.headers["Dropbox-API-Arg"]);assert.equal(arg.commit.mode,"add");assert.equal(arg.commit.strict_conflict,true);assert.equal(arg.commit.autorename,false);
   return json({id:"id:target",size:3,path_lower:"/approved/file.bin",content_hash:"fixture"});
  }
  return range(new Uint8Array([1,2,3]));
 }});
 const session=await client.startUpload("file.bin",3),completed=await client.uploadChunk(session,0,new Uint8Array([1,2,3]));
 assert.equal(completed.item_id,"/approved/file.bin");
 assert.equal((await client.readRange(completed.item_id,0,3,3)).length,3);
 await assert.rejects(()=>client.metadata("/outside/secrets"),/outside_scope/);
});
test("Gmail imports are bounded, never send mail, and suppress calendar processing; Graph exports only",async()=>{
 const requests=[];const gmail=new GmailClient({mailbox:"user@example.test",token,fetcher:async(url,options)=>{requests.push({url,options});return json({id:"imported"});}});
 await gmail.importMessage("U3ViamVjdDogdGVzdA0KDQpCb2R5",["INBOX"]);
 assert.ok(requests[0].url.includes("/messages/import?"));
 assert.ok(requests[0].url.includes("processForCalendar=false"));
 assert.ok(requests[0].url.includes("neverMarkSpam=false"));
 assert.ok(!requests[0].url.includes("/send"));
 await assert.rejects(()=>gmail.importMessage("secret\ninjection"),/bounded/);
 let cancelled=false;const oversized=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(10));},cancel(){cancelled=true;}}));
 await assert.rejects(()=>boundedBytes(oversized,3),/too_large/);assert.equal(cancelled,true);
 const graph=new GraphMailboxClient({mailbox:"user@example.test",token,fetcher:async(url)=>{assert.ok(url.endsWith("/$value"));return new Response("Subject: test\r\n\r\nBody");}});
 assert.match(new TextDecoder().decode(await graph.exportMessage("message-id")),/Subject: test/);
 assert.equal(graph.importMessage,undefined);
});
function copyFixture(options={}) {
 const data=new Uint8Array([10,20,30,40]);let state=null,starts=0,uploads=0,authorized=true,version="v1";
 const source={metadata:async()=>({size:data.length,version}),readRange:async(_id,offset,length)=>data.slice(offset,offset+length)};
 const target={startUpload:async()=>{starts++;return {total:data.length};},uploadChunk:async()=>{uploads++;return {done:true,item_id:"target"};},readRange:async(_id,offset,length)=>options.corrupt?new Uint8Array(length):data.slice(offset,offset+length)};
 const input={source,target,sourceId:"source",targetName:"file",reference:"b".repeat(64),expectedSize:data.length,expectedVersion:"v1",loadState:async()=>structuredClone(state),saveState:async(_ref,value)=>{state=structuredClone(value);},reserveBytes:async(ref,size)=>{assert.equal(ref,"b".repeat(64));assert.equal(size,4);},authorize:async()=>authorized};
 return {input,get state(){return state;},get starts(){return starts;},get uploads(){return uploads;},revoke(){authorized=false;},change(){version="v2";}};
}
test("File copies verify full source and destination content and never upload twice on resume",async()=>{
 const f=copyFixture(),first=await copyVerifiedFile(f.input);
 assert.equal(first.status,"verified");assert.match(first.content_digest,/^sha256:[0-9a-f]{64}$/);
 assert.equal(f.starts,1);assert.equal(f.uploads,1);
 assert.deepEqual(await copyVerifiedFile(f.input),first);
 assert.equal(f.uploads,1);
 await assert.rejects(()=>copyVerifiedFile({...f.input,targetName:"other"}),/scope_mismatch/);
});
test("File copy fails closed on corrupt output, changed source and revoked authorization",async()=>{
 const corrupt=copyFixture({corrupt:true});await assert.rejects(()=>copyVerifiedFile(corrupt.input),/verification_failed/);
 assert.equal(corrupt.state.stage,"verifying");
 const revoked=copyFixture();revoked.revoke();await assert.rejects(()=>copyVerifiedFile(revoked.input),/revoked/);assert.equal(revoked.starts,0);
 const changed=copyFixture();changed.change();await assert.rejects(()=>copyVerifiedFile(changed.input),/source_changed/);assert.equal(changed.starts,0);
});
test("An unknown upload creation outcome is never automatically retried",async()=>{
 const f=copyFixture();f.input.target.startUpload=async()=>{throw new Error("connection_lost_after_provider_creation");};
 await assert.rejects(()=>copyVerifiedFile(f.input),/connection_lost/);
 assert.equal(f.state.stage,"creating");
 await assert.rejects(()=>copyVerifiedFile(f.input),/outcome_unknown/);
});

