import { authorizedTenant } from "./managed-ops.js";
async function access(db,id,token){const t=await authorizedTenant(db,id,token);if(!t||t.status!=="active")throw new Error("active tenant authorization required");return t;}
const clean=(v,n)=>String(v||"").trim().replace(/[\u0000-\u001f]/g," ").slice(0,n);
async function createContract(db,tenant,token,input,now=Date.now()){
 await access(db,tenant,token);
 const name=clean(input.name,160),customer=clean(input.customer_name,160),rate=String(input.hourly_atomic||"");
 if(name.length<3||customer.length<2||!/^[1-9][0-9]{0,11}$/.test(rate))throw new Error("name, customer and bounded positive USDC hourly rate required");
 const id=crypto.randomUUID();
 await db.batch([
  db.prepare("INSERT INTO psa_contracts(id,tenant_id,name,customer_name,hourly_atomic,created_at) VALUES(?,?,?,?,?,?)").bind(id,tenant,name,customer,rate,now),
  db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'psa_contract_created',?,?)").bind(tenant,JSON.stringify({contract_id:id,hourly_atomic:rate}),now)
 ]);
 return {id,name,customer_name:customer,hourly_atomic:rate};
}
async function logTime(db,tenant,token,input,now=Date.now()){
 await access(db,tenant,token);const minutes=Number(input.minutes),note=clean(input.note,2000);
 if(!Number.isInteger(minutes)||minutes<1||minutes>1440||note.length<10||!/^[0-9a-f-]{36}$/i.test(input.request_key||""))throw new Error("bounded work minutes, evidence note and request_key required");
 const contract=await db.prepare("SELECT * FROM psa_contracts WHERE id=? AND tenant_id=? AND status='active'").bind(input.contract_id,tenant).first();
 const ticket=await db.prepare("SELECT id FROM managed_tickets WHERE id=? AND tenant_id=?").bind(input.ticket_id,tenant).first();
 if(!contract||!ticket)throw new Error("ticket and active contract must belong to this tenant");
 const id=crypto.randomUUID(),amount=(BigInt(contract.hourly_atomic)*BigInt(minutes)/60n).toString();
 await db.batch([
  db.prepare("INSERT INTO psa_time_entries(id,tenant_id,contract_id,ticket_id,minutes,note,amount_atomic,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(id,tenant,contract.id,ticket.id,minutes,note,amount,input.request_key,now),
  db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,'psa_time_submitted',?,?)").bind(tenant,JSON.stringify({entry_id:id,minutes,amount_atomic:amount}),now)
 ]);
 return {id,status:"submitted",amount_atomic:amount};
}
async function reviewTime(db,tenant,token,id,input,now=Date.now()){
 await access(db,tenant,token);if(!["approved","rejected"].includes(input.status))throw new Error("approved or rejected status required");
 await db.batch([
  db.prepare("UPDATE psa_time_entries SET status=? WHERE id=? AND tenant_id=? AND status='submitted' AND invoice_id IS NULL").bind(input.status,id,tenant),
  db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,CASE WHEN changes()=1 THEN 'psa_time_reviewed' ELSE NULL END,?,?)").bind(tenant,JSON.stringify({entry_id:id,status:input.status}),now)
 ]);
 return {id,status:input.status};
}
async function draftInvoice(db,tenant,token,input,now=Date.now()){
 await access(db,tenant,token);
 if(!/^[0-9a-f-]{36}$/i.test(input.request_key||""))throw new Error("request_key required");
 const existing=await db.prepare("SELECT * FROM psa_invoices WHERE tenant_id=? AND request_key=?").bind(tenant,input.request_key).first();
 if(existing){if(existing.contract_id!==input.contract_id)throw new Error("invoice retry differs from original");return existing;}
 const entries=(await db.prepare("SELECT id,amount_atomic FROM psa_time_entries WHERE tenant_id=? AND contract_id=? AND status='approved' AND invoice_id IS NULL ORDER BY created_at LIMIT 500").bind(tenant,input.contract_id).all()).results;
 if(!entries.length)throw new Error("no approved unbilled work for this contract");
 const amount=entries.reduce((sum,e)=>sum+BigInt(e.amount_atomic),0n).toString(),id=crypto.randomUUID();
 await db.batch([
  db.prepare("INSERT INTO psa_invoices(id,tenant_id,contract_id,amount_atomic,request_key,created_at) VALUES(?,?,?,?,?,?)").bind(id,tenant,input.contract_id,amount,input.request_key,now),
  db.prepare("UPDATE psa_time_entries SET invoice_id=? WHERE tenant_id=? AND contract_id=? AND status='approved' AND invoice_id IS NULL AND id IN (SELECT value FROM json_each(?))").bind(id,tenant,input.contract_id,JSON.stringify(entries.map(e=>e.id))),
  db.prepare("INSERT INTO managed_ops_events(tenant_id,kind,details,created_at) VALUES(?,CASE WHEN changes()=? THEN 'psa_invoice_drafted' ELSE NULL END,?,?)").bind(tenant,entries.length,JSON.stringify({invoice_id:id,amount_atomic:amount,entries:entries.length,automatic_charge:false}),now)
 ]);
 return {id,status:"draft",amount_atomic:amount,asset:"USDC",automatic_charge:false};
}
async function billingSummary(db,tenant,token){
 await access(db,tenant,token);
 const results=await db.batch([
  db.prepare("SELECT * FROM psa_contracts WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100").bind(tenant),
  db.prepare("SELECT * FROM psa_time_entries WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200").bind(tenant),
  db.prepare("SELECT * FROM psa_invoices WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100").bind(tenant)
 ]);
 return {contracts:results[0].results,time_entries:results[1].results,invoices:results[2].results,automatic_charge:false};
}
export { createContract, logTime, reviewTime, draftInvoice, billingSummary };
