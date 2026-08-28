import { createHash } from "node:crypto";
import { CHUNK_BYTES } from "./migration-provider-clients.js";
function version(metadata){const value=metadata?.eTag||metadata?.version||metadata?.rev;if(!value)throw new Error("source_version_required");return String(value);}
async function copyVerifiedFile({source,target,sourceId,targetName,reference,expectedSize,expectedVersion,loadState,saveState,reserveBytes,authorize}) {
 if(!Number.isSafeInteger(expectedSize)||expectedSize<1||!expectedVersion||!/^[a-f0-9]{64}$/.test(reference||""))throw new Error("bounded_versioned_file_required");
 for(const fn of [loadState,saveState,reserveBytes,authorize])if(typeof fn!=="function")throw new Error("private_durable_checkpoint_and_authorization_required");
 const check=async()=>{if(await authorize()!==true)throw new Error("migration_authorization_revoked");const meta=await source.metadata(sourceId);if(Number(meta.size)!==expectedSize||version(meta)!==String(expectedVersion))throw new Error("source_changed_during_migration");};
 await check();
 await reserveBytes(reference,expectedSize); // Caller must atomically deduplicate against the paid pool.
 let state=await loadState(reference);
 if(state&&(state.source_id!==sourceId||state.size!==expectedSize||state.version!==String(expectedVersion)||state.target_name!==targetName))throw new Error("checkpoint_scope_mismatch");
 if(state?.stage==="creating")throw new Error("upload_creation_outcome_unknown_reconcile_before_retry");
 if(!state){
  state={source_id:sourceId,size:expectedSize,version:String(expectedVersion),target_name:targetName,stage:"creating",offset:0};
  await saveState(reference,state);
  state={...state,session:await target.startUpload(targetName,expectedSize,reference),stage:"uploading"};
  await saveState(reference,state);
 }
 while(state.stage==="uploading"){
  await check();
  const length=Math.min(CHUNK_BYTES,expectedSize-state.offset);
  const bytes=await source.readRange(sourceId,state.offset,length,expectedSize,expectedVersion);
  if(bytes.byteLength!==length)throw new Error("source_chunk_truncated");
  if(await authorize()!==true)throw new Error("migration_authorization_revoked");
  const result=await target.uploadChunk(state.session,state.offset,bytes);
  if(result.done){
   if(state.offset+length!==expectedSize||!result.item_id)throw new Error("premature_upload_completion");
   state={...state,offset:expectedSize,stage:"verifying",target_id:result.item_id};
  }else{
   if(result.next_offset!==state.offset+length)throw new Error("upload_offset_not_confirmed");
   state={...state,offset:result.next_offset};
  }
  await saveState(reference,state);
 }
 if(!["verifying","verified"].includes(state.stage)||!state.target_id)throw new Error("invalid_transfer_checkpoint");
 const sourceHash=createHash("sha256"),targetHash=createHash("sha256");
 for(let offset=0;offset<expectedSize;offset+=CHUNK_BYTES){
  await check();const length=Math.min(CHUNK_BYTES,expectedSize-offset);
  sourceHash.update(await source.readRange(sourceId,offset,length,expectedSize,expectedVersion));
  targetHash.update(await target.readRange(state.target_id,offset,length,expectedSize));
 }
 await check();
 const digest=sourceHash.digest("hex");
 if(targetHash.digest("hex")!==digest)throw new Error("target_content_verification_failed");
 state={...state,stage:"verified",digest:"sha256:"+digest};await saveState(reference,state);
 return {source_object_id:sourceId,target_object_id:state.target_id,source_version:String(expectedVersion),content_digest:state.digest,bytes_copied:expectedSize,status:"verified"};
}
export { copyVerifiedFile };
