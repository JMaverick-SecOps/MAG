import { createMigrationProject, PROVIDERS } from "./migration-service.js";
import { createSecurityReview, tierById } from "./security-services.js";
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
function identityFields(){return '<label>Organization<input name="organization" autocomplete="organization" minlength="2" maxlength="140" required></label><label>Work email<input name="contact_email" type="email" autocomplete="email" required></label>';}
function specializedServiceForm(service) {
 if(service.id==="migration-fabric"){
  const options=selected=>Object.entries(PROVIDERS).map(([id,p])=>'<option value="'+id+'"'+(id===selected?" selected":"")+'>'+esc(p.name)+'</option>').join("");
  return '<form method="post" action="/intake/migrations"><h2>Migration Fabric · prefilled licensing</h2><p><strong>18 USDC per 500 GiB license, pooled within this project.</strong> The license count and invoice total are calculated from your estimated data size. Payment stays off until live connector and delivery preflight passes.</p>'+identityFields()+
  '<label>Source<select name="source_provider">'+options("m365")+'</select></label><label>Destination<select name="target_provider">'+options("google_workspace")+'</select></label><label>Workload<select name="workload"><option value="mail">Email messages and folders</option><option value="files">Files and folders</option></select></label><label>Estimated data (GiB)<input name="estimated_gib" type="number" min="1" max="50000000" step="1" value="500" required></label>'+
  '<details open><summary>Authorized connection and cutover information</summary><p>Use references issued through your secure connector setup. Never enter passwords, tokens or private keys. Live provider certification is still required.</p><label>Source connection reference<input name="source_connection_id" placeholder="connector:your-source-connection" pattern="(?:vault|secret-store|connector):[a-zA-Z0-9][a-zA-Z0-9._:-]{6,145}" required></label><label>Destination connection reference<input name="target_connection_id" placeholder="connector:your-target-connection" pattern="(?:vault|secret-store|connector):[a-zA-Z0-9][a-zA-Z0-9._:-]{6,145}" required></label><label>Cutover start (UTC)<input type="datetime-local" name="cutover_start_utc" required></label><label>Cutover end (UTC)<input type="datetime-local" name="cutover_end_utc" required></label></details>'+
  '<label class="check"><input type="checkbox" name="authorization_attested" value="yes" required>I authorize both providers, the data-processing scope and this cutover window. No source deletion is authorized.</label><button>Create migration preflight · no payment yet</button><p class="muted">If you do not have secure connection references, the operator must provision the connector first. Source-to-target mappings are validated before payment. Calendar/contact conversion and native Google-document conversion are not certified.</p></form>';
 }
 const tier=tierById(service.id);
 if(!tier)return "";
 return '<form method="post" action="/intake/security-reviews"><h2>'+esc(tier.name)+'</h2><input type="hidden" name="tier_id" value="'+tier.id+'"><p><strong>'+esc(tier.price)+'</strong> · '+esc(tier.limits)+'</p><p>The review, deliverables and price are selected. Provide only the authorized repository scope. Payment stays off until isolated review capacity is confirmed.</p>'+identityFields()+
 '<label>Repository URL<input type="url" name="repository_url" placeholder="https://github.com/organization/repository" required></label><label>Exact commit SHA<input name="commit_sha" pattern="(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})" minlength="40" maxlength="64" required></label><label>Repository-relative paths (one per line)<textarea name="scope_paths" placeholder="src/" required></textarea></label><label>Estimated lines in scope<input type="number" name="declared_loc" min="1" max="'+tier.max_loc+'" required></label><label>Files in scope<input type="number" name="declared_file_count" min="1" max="'+tier.max_files+'" required></label><label class="check"><input type="checkbox" name="authorization_attested" value="yes" required>I control or have permission to review this repository, have rights to the submitted code and authorize non-destructive static testing.</label><button>Submit selected review · no payment yet</button></form>';
}
function response(body,status=200){return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MAG service setup</title><style>body{max-width:820px;margin:40px auto;padding:20px;background:#061a33;color:#eaf7ff;font:16px/1.6 system-ui}a{color:#11d8ed}code{overflow-wrap:anywhere}section{padding:20px;border:1px solid #28516f;border-radius:12px}</style></head><body><a href="/hire">← Service catalog</a>'+body+'</body></html>',{status,headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","referrer-policy":"no-referrer","content-security-policy":"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'","x-content-type-options":"nosniff"}});}
async function handleSpecializedIntake(request,env,url) {
 if(request.method!=="POST"||!["/intake/migrations","/intake/security-reviews"].includes(url.pathname))return null;
 if(request.headers.get("origin")!==url.origin)return response("<h1>Same-origin form submission required</h1>",403);
 if(!env.DB)return response("<h1>Service intake unavailable</h1>",503);
 if(!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded"))return response("<h1>Use the service setup form</h1>",415);
 try{
  const reader=request.body?.getReader();let size=0,text="",decoder=new TextDecoder();
  if(reader)try{while(true){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>16000)throw new Error("request too large");text+=decoder.decode(p.value,{stream:true});}text+=decoder.decode();}catch(error){await reader.cancel().catch(()=>{});throw error;}
  const f=Object.fromEntries(new URLSearchParams(text)), authorized=f.authorization_attested==="yes";let created;
  if(url.pathname.endsWith("/migrations")){
   if(!/^[1-9][0-9]{0,7}$/.test(f.estimated_gib||"")||BigInt(f.estimated_gib)>50000000n)throw new Error("valid estimated data size required");
   const fileWorkload={m365:"onedrive",google_workspace:"google_drive",dropbox:"dropbox",sharepoint:"sharepoint",google_drive:"google_drive"}[f.source_provider];
   const workload=f.workload==="mail"?"mail":f.workload==="files"?fileWorkload:null;
   if(!workload)throw new Error("select a supported workload");
   const utc=value=>/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value||"")?Date.parse(value+"Z"):NaN;
   created=await createMigrationProject(env.DB,{...f,estimated_bytes:(BigInt(f.estimated_gib)*1073741824n).toString(),license_count:((BigInt(f.estimated_gib)+499n)/500n).toString(),workloads:[workload],cutover_start:utc(f.cutover_start_utc),cutover_end:utc(f.cutover_end_utc),source_authorization_attested:authorized,target_authorization_attested:authorized,data_processing_consent:authorized,cutover_preauthorized:authorized});
  }else{
   created=await createSecurityReview(env.DB,{...f,scope_paths:String(f.scope_paths||"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean),authorization_attested:authorized,repository_license_attested:authorized,safe_testing_consent:authorized});
  }
  const amount=created.quote.total_price_atomic||created.quote.amount_atomic;
  return response('<h1>Your service setup is recorded</h1><section><p>Quote: <strong>'+Number(amount)/1e6+' USDC</strong></p><p>Status: '+esc(created.status)+'</p><p>No payment was requested or accepted. Delivery-capacity and authorization checks must pass first.</p><p>Save these private recovery details:</p><p>ID: <code>'+esc(created.id)+'</code></p><p>Access token: <code>'+esc(created.access_token)+'</code></p><p>Do not post these credentials publicly.</p></section>',201);
 }catch(error){return response('<h1>Check the service setup</h1><p>'+esc(error.message)+'</p><p><a href="/hire">Return to the selected service</a></p>',400);}
}
export { specializedServiceForm, handleSpecializedIntake };

