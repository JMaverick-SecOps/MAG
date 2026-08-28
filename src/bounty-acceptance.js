import { payoutBreakdown, validateAcceptance } from "./marketplace.js";
async function completeFundedBounty(db, submissionId, input, now = Date.now()) {
  const id=Number(submissionId);
  if(!Number.isSafeInteger(id)||id<1) throw new Error("invalid submission id");
  const row=await db.prepare(`SELECT s.*,t.title,t.status task_status,t.reward_atomic,t.platform_fee_bps,
    b.id bounty_id,b.status bounty_status,b.payment_status,b.authorization_attested,b.reward_atomic funded_atomic,
    EXISTS(SELECT 1 FROM payment_receipt_claims f WHERE f.tx_hash=b.payment_tx_hash AND f.purpose_type='bounty' AND f.purpose_id=b.id) funding_verified
    FROM submissions s JOIN tasks t ON t.id=s.task_id JOIN bounty_requests b ON b.published_task_id=t.id WHERE s.id=?`).bind(id).first();
  if(!row || row.payment_status!=="verified" || !row.funding_verified || row.authorization_attested!==1 || row.funded_atomic!==row.reward_atomic || Number(row.platform_fee_bps)!==1500) throw new Error("verified funded bounty required");
  const economics=payoutBreakdown(row.reward_atomic,row.platform_fee_bps);
  const existing=await db.prepare("SELECT p.id,p.status,r.id receipt_id FROM payout_proposals p JOIN task_acceptance_receipts r ON r.task_id=p.task_id AND r.submission_id=p.submission_id WHERE p.task_id=? AND p.submission_id=? AND p.gross_atomic=? AND p.platform_fee_atomic=? AND p.worker_payout_atomic=? AND p.agent_handle=? AND p.asset='USDC' AND p.network='Base'").bind(row.task_id,id,economics.gross_atomic,economics.platform_fee_atomic,economics.worker_payout_atomic,row.agent_handle).first();
  if(existing && row.status==="accepted" && row.task_status==="completed" && row.bounty_status==="completed") return {submission:{id,status:"accepted"},payout_proposal:existing,notification:"deduplicated",economics};
  if(row.status!=="submitted" || row.task_status!=="review" || row.bounty_status!=="published") throw new Error("bounty is not ready for acceptance");
  const evidence=validateAcceptance(input), receiptId=crypto.randomUUID(), proposalId=crypto.randomUUID();
  await db.batch([
    db.prepare(`UPDATE submissions SET status='accepted' WHERE id=? AND status='submitted'
      AND EXISTS(SELECT 1 FROM tasks t JOIN bounty_requests b ON b.published_task_id=t.id JOIN payment_receipt_claims f ON f.tx_hash=b.payment_tx_hash AND f.purpose_id=b.id AND f.purpose_type='bounty'
        WHERE t.id=submissions.task_id AND t.status='review' AND b.status='published' AND b.payment_status='verified' AND b.authorization_attested=1 AND b.reward_atomic=t.reward_atomic AND t.reward_atomic=? AND t.platform_fee_bps=1500)
      AND NOT EXISTS(SELECT 1 FROM task_acceptance_receipts r WHERE r.task_id=submissions.task_id)
      AND NOT EXISTS(SELECT 1 FROM payout_proposals p WHERE p.task_id=submissions.task_id)`).bind(id,row.reward_atomic),
    db.prepare("INSERT INTO task_acceptance_receipts(id,task_id,submission_id,verifier,verification_summary,evidence_url,created_at) SELECT ?,task_id,id,'operator',?,?,? FROM submissions WHERE changes()=1 AND id=? AND status='accepted'").bind(receiptId,evidence.verificationSummary,evidence.evidenceUrl,now,id),
    db.prepare("UPDATE tasks SET status='completed' WHERE id=? AND status='review' AND EXISTS(SELECT 1 FROM task_acceptance_receipts WHERE id=? AND task_id=tasks.id)").bind(row.task_id,receiptId),
    db.prepare("UPDATE bounty_requests SET status='completed',updated_at=? WHERE id=? AND status='published' AND EXISTS(SELECT 1 FROM task_acceptance_receipts WHERE id=?)").bind(now,row.bounty_id,receiptId),
    db.prepare("INSERT INTO payout_proposals(id,task_id,submission_id,agent_handle,gross_atomic,platform_fee_atomic,worker_payout_atomic,asset,network,status,created_at,updated_at) SELECT ?,task_id,submission_id,?,?,?,?,'USDC','Base','awaiting_owner_signature',?,? FROM task_acceptance_receipts WHERE id=?").bind(proposalId,row.agent_handle,economics.gross_atomic,economics.platform_fee_atomic,economics.worker_payout_atomic,now,now,receiptId),
    db.prepare("INSERT INTO notification_events(id,dedupe_key,kind,subject,message,created_at) SELECT ?,?,'bounty_completed',?,?,? FROM payout_proposals WHERE id=? ON CONFLICT(dedupe_key) DO NOTHING").bind(crypto.randomUUID(),`bounty_completed:${id}`,`MAG bounty completed: ${row.title}`.slice(0,160),`Accepted submission ${id}. Agent: ${row.agent_handle}. Evidence: ${evidence.evidenceUrl}. Payout still requires owner approval.`,now,proposalId),
    db.prepare("INSERT INTO audit_events(kind,actor,subject_type,subject_id,details,created_at) SELECT CASE WHEN EXISTS(SELECT 1 FROM payout_proposals p JOIN tasks t ON t.id=p.task_id JOIN bounty_requests b ON b.published_task_id=t.id WHERE p.id=? AND t.status='completed' AND b.status='completed') THEN 'bounty_accepted' END,'operator','submission',?,?,?").bind(proposalId,String(id),JSON.stringify({receipt_id:receiptId,evidence_url:evidence.evidenceUrl,payout_authority:"owner_signature_required"}),now),
  ]);
  return {submission:{id,status:"accepted"},payout_proposal:{id:proposalId,status:"awaiting_owner_signature"},acceptance_receipt:{id:receiptId},notification:"queued",economics};
}
export { completeFundedBounty };
