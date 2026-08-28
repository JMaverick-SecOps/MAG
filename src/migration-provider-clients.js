// Provider I/O only. These clients are never exposed as public HTTP endpoints.
// A certified private connector must bind them to a paid, authorized project,
// vault credentials, durable checkpoints, byte reservations and revocation.
const CHUNK_BYTES=5*1024*1024; // divisible by both Graph 320 KiB and Drive 256 KiB
const id=v=>{if(!/^[a-zA-Z0-9!_.:@+-]{1,400}$/.test(v||""))throw new Error("invalid_provider_identifier");return encodeURIComponent(v);};
const leaf=v=>{if(!v||v.length>200||/[\u0000-\u001f\\/]/.test(v)||v==="."||v==="..")throw new Error("invalid_file_name");return v;};
async function boundedBytes(response,max=CHUNK_BYTES+65536) {
 if(!response.body)return new Uint8Array();
 const reader=response.body.getReader(),chunks=[];let total=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;total+=value.byteLength;if(total>max)throw new Error("provider_response_too_large");chunks.push(value);}}
 catch(error){await reader.cancel().catch(()=>{});throw error;}
 const bytes=new Uint8Array(total);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.byteLength;}return bytes;
}
async function jsonResponse(response,max=1048576) {return JSON.parse(new TextDecoder().decode(await boundedBytes(response,max)));}
class ProviderClient {
 constructor(token,fetcher=fetch){if(typeof token!=="function")throw new Error("private_token_provider_required");this.token=token;this.fetcher=fetcher;}
 async request(url,options={},sendToken=true,allowedStatuses=[]) {
  const response=await this.fetcher(url,{...options,redirect:"manual",signal:AbortSignal.timeout(60000),headers:{...(sendToken?{Authorization:"Bearer "+await this.token()}:{}),...options.headers}});
  if(!response.ok&&!allowedStatuses.includes(response.status)){await response.body?.cancel();throw new Error("provider_http_"+response.status);}
  return response;
 }
 async json(url,options={}){return jsonResponse(await this.request(url,options));}
}
function signedLocation(url,allowedOrigins) {
 const value=new URL(url);
 if(value.protocol!=="https:"||value.username||value.password||value.hash||!allowedOrigins.includes(value.origin))throw new Error("provider_location_not_operator_allowlisted");
 return value.href;
}
function validateChunk(offset,total,bytes) {
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(total)||total<1||offset>=total||!(bytes instanceof Uint8Array)||!bytes.byteLength||bytes.byteLength>CHUNK_BYTES||offset+bytes.byteLength>total)throw new Error("invalid_upload_range");
 if(offset%CHUNK_BYTES!==0||offset+bytes.byteLength<total&&bytes.byteLength!==CHUNK_BYTES)throw new Error("unaligned_upload_range");
}
function validateTotal(total){if(!Number.isSafeInteger(total)||total<1)throw new Error("positive_bounded_file_size_required");}
function googleResumeOffset(response) {
 const range=response.headers.get("range");
 if(!range)return 0;
 const match=/^bytes=0-([0-9]+)$/.exec(range);
 if(!match||!Number.isSafeInteger(Number(match[1])+1))throw new Error("invalid_provider_upload_offset");
 return Number(match[1])+1;
}
class GraphDriveClient extends ProviderClient {
 constructor({driveId,rootId,allowedTransferOrigins=[],token,fetcher}){super(token,fetcher);this.base="https://graph.microsoft.com/v1.0/drives/"+id(driveId);id(rootId);this.root=rootId;this.transferOrigins=allowedTransferOrigins;}
 async listChildren(folderId=this.root,next=null) {
  const path=this.base+"/items/"+id(folderId)+"/children";
  const url=next?new URL(next):new URL(path+"?$select=id,name,size,eTag,file,folder&$top=100");
  if(url.origin!=="https://graph.microsoft.com"||url.pathname!==new URL(path).pathname)throw new Error("out_of_scope_pagination");
  return this.json(url.href);
 }
 async metadata(itemId){return this.json(this.base+"/items/"+id(itemId)+"?$select=id,name,size,eTag,file,folder");}
 async readRange(itemId,offset,length,total,etag) {
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||offset<0||length<1||length>CHUNK_BYTES||offset+length>total)throw new Error("invalid_download_range");
  const response=await this.request(this.base+"/items/"+id(itemId)+"/content",{headers:{"If-Match":etag}},true,[302]);
  if(response.status!==302)throw new Error("expected_scoped_graph_download_redirect");
  const location=signedLocation(response.headers.get("location"),this.transferOrigins);
  await response.body?.cancel();
  const content=await this.request(location,{headers:{Range:`bytes=${offset}-${offset+length-1}`}},false);
  return exactRange(content,offset,length,total);
 }
 async startUpload(name,total) {
  validateTotal(total);
  const itemName=leaf(name);
  const response=await this.json(this.base+"/items/"+id(this.root)+":/"+encodeURIComponent(itemName)+":/createUploadSession",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({item:{"@microsoft.graph.conflictBehavior":"fail",name:itemName}})});
  return {provider:"graph",url:signedLocation(response.uploadUrl,this.transferOrigins),total,expires_at:response.expirationDateTime};
 }
 async uploadChunk(session,offset,bytes) {
  validateChunk(offset,session.total,bytes);
  const response=await this.request(signedLocation(session.url,this.transferOrigins),{method:"PUT",headers:{"Content-Length":String(bytes.byteLength),"Content-Range":`bytes ${offset}-${offset+bytes.byteLength-1}/${session.total}`},body:bytes},false);
  const result=await jsonResponse(response);
  if(response.status===202){const next=Number(/^([0-9]+)-$/.exec(result.nextExpectedRanges?.[0]||"")?.[1]);if(!Number.isSafeInteger(next)||next!==offset+bytes.byteLength)throw new Error("provider_offset_requires_reconciliation");return {done:false,next_offset:next};}
  if(![200,201].includes(response.status)||!result.id||Number(result.size)!==session.total)throw new Error("provider_completion_not_verified");
  return {done:true,item_id:result.id,size:Number(result.size)};
 }
}
async function exactRange(response,offset,length,total) {
 if(response.status!==206||response.headers.get("content-range")!==`bytes ${offset}-${offset+length-1}/${total}`) {await response.body?.cancel();throw new Error("provider_range_mismatch");}
 const data=await boundedBytes(response,length);if(data.byteLength!==length)throw new Error("truncated_provider_range");return data;
}
class GoogleDriveClient extends ProviderClient {
 constructor({rootId,token,fetcher}){super(token,fetcher);id(rootId);this.root=rootId;this.base="https://www.googleapis.com/drive/v3";}
 async listChildren(folderId=this.root,pageToken="") {
  id(folderId);const url=new URL(this.base+"/files");
  url.search=new URLSearchParams({q:"'"+folderId+"' in parents and trashed = false",fields:"nextPageToken,files(id,name,size,version,mimeType,md5Checksum)",pageSize:"100",supportsAllDrives:"true",includeItemsFromAllDrives:"true",...(pageToken?{pageToken}:{})});
  return this.json(url.href);
 }
 async metadata(itemId){return this.json(this.base+"/files/"+id(itemId)+"?fields=id,name,size,version,mimeType,md5Checksum&supportsAllDrives=true");}
 async readRange(itemId,offset,length,total) {
  if(!Number.isSafeInteger(length)||length<1||length>CHUNK_BYTES||!Number.isSafeInteger(offset)||offset<0||offset+length>total)throw new Error("invalid_download_range");
  return exactRange(await this.request(this.base+"/files/"+id(itemId)+"?alt=media&supportsAllDrives=true",{headers:{Range:`bytes=${offset}-${offset+length-1}`}}),offset,length,total);
 }
 async startUpload(name,total,reference) {
  validateTotal(total);
  if(!/^[a-f0-9]{64}$/.test(reference||""))throw new Error("stable_object_reference_required");
  const response=await this.request("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",{method:"POST",headers:{"content-type":"application/json; charset=UTF-8","X-Upload-Content-Type":"application/octet-stream","X-Upload-Content-Length":String(total)},body:JSON.stringify({name:leaf(name),parents:[this.root],appProperties:{magMigrationReference:reference}})});
  const url=signedLocation(response.headers.get("location"),["https://www.googleapis.com"]);
  if(!new URL(url).pathname.startsWith("/upload/drive/v3/files"))throw new Error("invalid_google_upload_location");
  await response.body?.cancel();return {provider:"google",url,total};
 }
 async uploadChunk(session,offset,bytes) {
  validateChunk(offset,session.total,bytes);
  const url=signedLocation(session.url,["https://www.googleapis.com"]);
  if(!new URL(url).pathname.startsWith("/upload/drive/v3/files"))throw new Error("invalid_google_upload_location");
  const response=await this.request(url,{method:"PUT",headers:{"Content-Length":String(bytes.byteLength),"Content-Range":`bytes ${offset}-${offset+bytes.byteLength-1}/${session.total}`},body:bytes},true,[308]);
  if(response.status===308){const next=googleResumeOffset(response);await response.body?.cancel();if(next!==offset+bytes.byteLength)throw new Error("provider_offset_requires_reconciliation");return {done:false,next_offset:next};}
  const result=await jsonResponse(response);if(!result.id)throw new Error("provider_completion_not_verified");
  return {done:true,item_id:result.id};
 }
 async uploadStatus(session) {
  const url=signedLocation(session.url,["https://www.googleapis.com"]);
  if(!new URL(url).pathname.startsWith("/upload/drive/v3/files"))throw new Error("invalid_google_upload_location");
  const response=await this.request(url,{method:"PUT",headers:{"Content-Length":"0","Content-Range":"bytes */"+session.total}},true,[308]);
  if(response.status===308){const next=googleResumeOffset(response);await response.body?.cancel();return {done:false,next_offset:next};}return {done:true,item:await jsonResponse(response)};
 }
}
class DropboxClient extends ProviderClient {
 constructor({rootPath,token,fetcher}){super(token,fetcher);if(typeof rootPath!=="string"||!rootPath.startsWith("/")||rootPath.includes("..")||/[\u0000-\u001f]/.test(rootPath))throw new Error("explicit_dropbox_root_required");this.root=rootPath.replace(/\/$/,"");}
 async metadata(path){this.path(path);return this.json("https://api.dropboxapi.com/2/files/get_metadata",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path})});}
 path(path){if(path!==this.root&&!path.startsWith(this.root+"/")||path.includes("..")||/[\u0000-\u001f]/.test(path))throw new Error("dropbox_path_outside_scope");return path;}
 async listChildren(path=this.root,cursor=null){this.path(path);return this.json("https://api.dropboxapi.com/2/files/list_folder"+(cursor?"/continue":""),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(cursor?{cursor}:{path,recursive:false,limit:100,include_deleted:false})});}
 async readRange(path,offset,length,total) {
  this.path(path);if(!Number.isSafeInteger(length)||length<1||length>CHUNK_BYTES||!Number.isSafeInteger(offset)||offset<0||offset+length>total)throw new Error("invalid_download_range");
  return exactRange(await this.request("https://content.dropboxapi.com/2/files/download",{method:"POST",headers:{"Dropbox-API-Arg":JSON.stringify({path}),Range:`bytes=${offset}-${offset+length-1}`}}),offset,length,total);
 }
 async startUpload(name,total) {
  validateTotal(total);
  const path=this.root+"/"+leaf(name),response=await this.json("https://content.dropboxapi.com/2/files/upload_session/start",{method:"POST",headers:{"content-type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify({close:false})},body:new Uint8Array()});
  if(!response.session_id)throw new Error("provider_upload_session_missing");
  return {provider:"dropbox",session_id:response.session_id,path,total};
 }
 async uploadChunk(session,offset,bytes) {
  validateChunk(offset,session.total,bytes);this.path(session.path);
  const final=offset+bytes.byteLength===session.total;
  const arg={cursor:{session_id:session.session_id,offset},...(final?{commit:{path:session.path,mode:"add",autorename:false,mute:true,strict_conflict:true}}:{close:false})};
  const response=await this.request("https://content.dropboxapi.com/2/files/upload_session/"+(final?"finish":"append_v2"),{method:"POST",headers:{"content-type":"application/octet-stream","Dropbox-API-Arg":JSON.stringify(arg)},body:bytes});
  if(!final){await response.body?.cancel();return {done:false,next_offset:offset+bytes.byteLength};}
  const result=await jsonResponse(response);if(!result.id||Number(result.size)!==session.total||String(result.path_lower||"").toLowerCase()!==session.path.toLowerCase())throw new Error("provider_completion_not_verified");return {done:true,item_id:session.path,provider_item_id:result.id,size:result.size,content_hash:result.content_hash};
 }
}
class GmailClient extends ProviderClient {
 constructor({mailbox,token,fetcher}){super(token,fetcher);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox))throw new Error("explicit_mailbox_required");this.base="https://gmail.googleapis.com/gmail/v1/users/"+encodeURIComponent(mailbox);}
 async listMessages(pageToken=""){const url=new URL(this.base+"/messages");url.search=new URLSearchParams({maxResults:"100",includeSpamTrash:"true",...(pageToken?{pageToken}:{})});return this.json(url.href);}
 async exportMessage(messageId){return jsonResponse(await this.request(this.base+"/messages/"+id(messageId)+"?format=raw"),8*1024*1024+65536);}
 async importMessage(raw,labelIds=[]) {
  if(!/^[A-Za-z0-9_-]+={0,2}$/.test(raw||"")||raw.length>8*1024*1024||!Array.isArray(labelIds)||labelIds.length>100||labelIds.some(x=>!/^[A-Za-z0-9_-]{1,100}$/.test(x)))throw new Error("invalid_bounded_mail_import");
  // Import never sends mail, bypasses spam classification, or creates calendar events.
  return this.json(this.base+"/messages/import?internalDateSource=dateHeader&processForCalendar=false&neverMarkSpam=false&deleted=false",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({raw,labelIds})});
 }
}
class GraphMailboxClient extends ProviderClient {
 constructor({mailbox,token,fetcher}){super(token,fetcher);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox))throw new Error("explicit_mailbox_required");this.base="https://graph.microsoft.com/v1.0/users/"+encodeURIComponent(mailbox);}
 async listMessages(next=null){const url=next?new URL(next):new URL(this.base+"/messages?$select=id,internetMessageId,receivedDateTime,parentFolderId&$top=100");if(url.origin!=="https://graph.microsoft.com"||url.pathname!==new URL(this.base+"/messages").pathname)throw new Error("out_of_scope_pagination");return this.json(url.href);}
 async exportMessage(messageId){return boundedBytes(await this.request(this.base+"/messages/"+id(messageId)+"/$value"),8*1024*1024);}
}
export { CHUNK_BYTES, boundedBytes, signedLocation, validateChunk, googleResumeOffset, GraphDriveClient, GoogleDriveClient, DropboxClient, GmailClient, GraphMailboxClient };
