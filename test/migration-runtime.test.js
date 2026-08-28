import test from "node:test";
import assert from "node:assert/strict";
import { TestD1 } from "./helpers/d1.js";
import { createMigrationProject, migrationCompatibility } from "../src/migration-service.js";
import { connectorExecutionPolicy } from "../src/migration-policy.js";
import { recordConnectorResult, replaceMigrationMappings, upsertMigrationConnection, validatePendingMigrationConnections, validatePendingMigrationMappings } from "../src/migration-engine.js";

async function project(db) {
  return createMigrationProject(db,{organization:"Test Company",contact_email:"test@example.test",source_provider:"m365",target_provider:"google_workspace",workloads:["mail"],source_connection_id:"vault:test:source",target_connection_id:"vault:test:target",estimated_bytes:"100",license_count:1,cutover_start:Date.now()+7200000,cutover_end:Date.now()+14400000,source_authorization_attested:true,target_authorization_attested:true,data_processing_consent:true,cutover_preauthorized:true});
}
const mappings={mappings:[{workload:"mail",source_principal:"a@example.test",target_principal:"b@example.test"}]};

test("outbound migration policy waits before cutover and expires without source deletion authority",()=>{
 const p={phase:"delta_sync",cutover_start:1000,cutover_end:2000};
 assert.equal(connectorExecutionPolicy(p,999).wait_until,1000);
 assert.equal(connectorExecutionPolicy(p,1000).wait_until,null);
 assert.ok(connectorExecutionPolicy(p,1000).allowed_phases.includes("preauthorized_cutover"));
 assert.equal(connectorExecutionPolicy(p,1000).source_deletion_allowed,false);
 assert.throws(()=>connectorExecutionPolicy(p,2000),/expired/);
 assert.equal(migrationCompatibility("m365","imap",["calendar"]).compatible,false);
});

test("connection preflight cannot validate credentials changed while the connector was checking",async t=>{
 const db=new TestD1();t.after(()=>db.close());const p=await project(db);
 await upsertMigrationConnection(db,p.id,p.access_token,{side:"source",provider:"m365",vault_reference:"vault:test:original"});
 const result=await validatePendingMigrationConnections({DB:db,MIGRATION_CONNECTOR:{async fetch(){
   await upsertMigrationConnection(db,p.id,p.access_token,{side:"source",provider:"m365",vault_reference:"vault:test:replaced"});
   return Response.json({status:"ready",validation_code:"read-only-preflight-ok"});
 }}});
 assert.equal(result.ready,0);
 assert.equal(db.prepare("SELECT status FROM migration_connections WHERE project_id=?").bind(p.id).first().status,"pending_validation");
 assert.equal(db.prepare("SELECT COUNT(*) n FROM migration_events WHERE kind='connection_validated'").first().n,0);
});

test("mapping preflight cannot approve a replacement mapping set",async t=>{
 const db=new TestD1();t.after(()=>db.close());const p=await project(db);
 for(const [side,provider] of [["source","m365"],["target","google_workspace"]]) await upsertMigrationConnection(db,p.id,p.access_token,{side,provider,vault_reference:"vault:test:"+side});
 await db.prepare("UPDATE migration_connections SET status='ready'").run();
 await replaceMigrationMappings(db,p.id,p.access_token,mappings);
 const result=await validatePendingMigrationMappings({DB:db,MIGRATION_CONNECTOR:{async fetch(url,init){
   const request=JSON.parse(init.body);
   await replaceMigrationMappings(db,p.id,p.access_token,{mappings:[{...mappings.mappings[0],target_principal:"replacement@example.test"}]});
   return Response.json({status:"ready",validation_code:"mappings-exist",mapping_digest:request.mapping_digest});
 }}});
 assert.equal(result.validated,0);
 assert.equal(db.prepare("SELECT status FROM migration_mappings WHERE project_id=?").bind(p.id).first().status,"pending");
});

test("migration raw wire results persist once and reject changed, stale, or unpaid results",async t=>{
 const db=new TestD1();t.after(()=>db.close());const p=await project(db);
 await db.prepare("UPDATE migration_projects SET phase='initial_sync',status='running',payment_status='verified' WHERE id=?").bind(p.id).run();
 const result={status:"continue",phase:"initial_sync",batch_id:"batch:000001",cursor:"checkpoint-1",attempted:1,succeeded:1,failed:0,bytes:20,receipts:[{workload:"mail",source_object_id:"message1",target_object_id:"copy1",source_version:"1",content_digest:"sha256:"+"a".repeat(64),status:"verified",bytes_copied:"20"}]};
 await recordConnectorResult(db,p.id,result,{generation:0,idempotencyKey:"request:000001"});
 assert.equal((await recordConnectorResult(db,p.id,result,{generation:0,idempotencyKey:"request:000001"})).duplicate,true);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM migration_checkpoints").first().n,1);
 await assert.rejects(()=>recordConnectorResult(db,p.id,{...result,bytes:30},{generation:0,idempotencyKey:"request:000001"}),/changed content/);
 await assert.rejects(()=>recordConnectorResult(db,p.id,{...result,batch_id:"batch:000002"},{generation:1}),/generation/);
 await db.prepare("UPDATE migration_projects SET payment_status='not_requested' WHERE id=?").bind(p.id).run();
 await assert.rejects(()=>recordConnectorResult(db,p.id,{...result,batch_id:"batch:000002"},{generation:0}),/not authorized/);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM migration_batch_receipts").first().n,1);
});
