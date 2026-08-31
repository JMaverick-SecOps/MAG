import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { processPendingOrders } from "../src/commerce.js";
import { claimPreimage, claimTask, completeSubmission, submissionPreimage, submitWork, validateAcceptance } from "../src/marketplace.js";

const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

class TestStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  first(column) {
    const row = this.database.prepare(this.sql).get(...this.values);
    return column ? row?.[column] ?? null : row ?? null;
  }

  all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values), meta: { changes: 0 } };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }

  executeForBatch() {
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = this.database.prepare(this.sql).all(...this.values);
      return {
        success: true,
        results,
        meta: {
          changes: results.length,
          last_row_id: results[0]?.id,
        },
      };
    }
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(this.sql)) return this.all();
    return this.run();
  }
}

class TestD1 {
  constructor({ failBatchOn = "" } = {}) {
    this.failBatchOn = failBatchOn;
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys=ON");
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const filename of readdirSync(directory).filter((name) => /^\d{4}.*\.sql$/.test(name)).sort()) {
      this.sqlite.exec(readFileSync(fileURLToPath(new URL(`../migrations/${filename}`, import.meta.url)), "utf8"));
    }
  }

  prepare(sql) {
    return new TestStatement(this.sqlite, sql);
  }

  batch(statements) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (this.failBatchOn && statement.sql.includes(this.failBatchOn)) throw new Error("injected batch failure");
        return statement.executeForBatch();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

function jsonRpcFetcher({ treasury, amountAtomic }) {
  const recipientTopic = `0x${treasury.slice(2).toLowerCase().padStart(64, "0")}`;
  const receipt = {
    status: "0x1",
    blockHash: `0x${"b".repeat(64)}`,
    blockNumber: "0x64",
    logs: [{
      address: BASE_USDC,
      topics: [TRANSFER_TOPIC, `0x${"0".repeat(64)}`, recipientTopic],
      data: `0x${BigInt(amountAtomic).toString(16)}`,
    }],
  };
  return async (_url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === "eth_chainId" ? "0x2105" : method === "eth_getTransactionReceipt" ? receipt : "0x70";
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  };
}

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

async function signingFixture() {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));
  const fetcher = async () => Response.json({ keys: [{ status: "active", custody: "undeclared", public_key: publicKey }] });
  return {
    async claim(taskId, handle) {
      const signed_at = Date.now();
      const message = new TextEncoder().encode(claimPreimage({ taskId, handle, signedAt: signed_at }));
      const signature = base64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, message)));
      return { input: { handle, signed_at, signature }, fetcher };
    },
    async submission(taskId, handle, artifact) {
      const signed_at = Date.now();
      const message = new TextEncoder().encode(submissionPreimage({ taskId, handle, artifact, signedAt: signed_at }));
      const signature = base64url(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, keyPair.privateKey, message)));
      return { input: { handle, artifact, note: "Reproduction and verification steps are included.", signed_at, signature }, fetcher };
    },
  };
}

function seedPaidOrder(db, { orderId, txHash, amountAtomic }) {
  db.prepare("INSERT INTO service_orders(id,access_token_hash,service_id,buyer_name,buyer_email,buyer_agent_handle,objective,acceptance_criteria,target_scope,authorization_attested,execution_mode,quoted_atomic,max_budget_atomic,status,assigned_agent,payment_tx_hash,payment_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,'payment_review',NULL,?,'pending_verification',?,?)")
    .bind(orderId, "hash", "website-starter", "Buyer", "buyer@example.com", "", "Build a responsive product landing page with the supplied copy.", "The supplied fixture passes accessibility and responsive layout checks.", "The buyer-controlled example repository and staging site.", "pull_request", amountAtomic, amountAtomic, txHash, 1, 1).run();
  db.prepare("INSERT INTO payment_receipt_claims(tx_hash,purpose_type,purpose_id,created_at) VALUES(?,'service_order',?,1)").bind(txHash, orderId).run();
}

async function deliverPaidOrder(db, { orderId, txHash }) {
  const treasury = `0x${"a".repeat(40)}`;
  const amountAtomic = "99000000";
  seedPaidOrder(db, { orderId, txHash, amountAtomic });
  await processPendingOrders({ DB: db, TREASURY_WALLET_ADDRESS: treasury }, jsonRpcFetcher({ treasury, amountAtomic }));
  const taskId = db.prepare("SELECT published_task_id FROM service_orders WHERE id=?").bind(orderId).first().published_task_id;
  db.prepare("INSERT INTO guild_applications(id,handle,status,created_at,updated_at) VALUES(?,?,?,?,?)").bind(`member-${orderId}`, "agent-one", "active", 1, 1).run();
  const signer = await signingFixture();
  const claim = await signer.claim(taskId, "agent-one");
  await claimTask(db, taskId, claim.input, claim.fetcher);
  const artifact = `https://example.test/deliveries/${orderId}`;
  const submission = await signer.submission(taskId, "agent-one", artifact);
  const delivered = await submitWork(db, taskId, submission.input, submission.fetcher);
  return { amountAtomic, artifact, delivered, taskId };
}

test("an independently verified exact service payment publishes one open 85/15 task", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const treasury = `0x${"a".repeat(40)}`;
  const txHash = `0x${"1".repeat(64)}`;
  const amountAtomic = "99000000";
  seedPaidOrder(db, { orderId: "order-1", txHash, amountAtomic });

  const first = await processPendingOrders({ DB: db, TREASURY_WALLET_ADDRESS: treasury }, jsonRpcFetcher({ treasury, amountAtomic }));
  assert.deepEqual(first, { configured: true, checked: 1, verified: 1 });

  const order = db.prepare("SELECT status,payment_status,published_task_id,assigned_agent FROM service_orders WHERE id='order-1'").first();
  assert.equal(order.status, "open");
  assert.equal(order.payment_status, "verified");
  assert.equal(order.assigned_agent, null);
  assert.ok(order.published_task_id > 0);
  const task = db.prepare("SELECT status,reward_atomic,platform_fee_bps,fulfillment_mode FROM tasks WHERE id=?").bind(order.published_task_id).first();
  assert.deepEqual({ ...task }, { status: "open", reward_atomic: amountAtomic, platform_fee_bps: 1500, fulfillment_mode: "digital" });
  const published = db.prepare("SELECT details FROM order_events WHERE order_id='order-1' AND kind='payment_verified_and_task_published'").first();
  assert.deepEqual(JSON.parse(published.details).economics, {
    gross_atomic: amountAtomic,
    platform_fee_atomic: "14850000",
    worker_payout_atomic: "84150000",
    platform_fee_bps: 1500,
  });
  assert.equal(JSON.parse(published.details).payout_authority, "owner_signature_required");

  const second = await processPendingOrders({ DB: db, TREASURY_WALLET_ADDRESS: treasury }, jsonRpcFetcher({ treasury, amountAtomic }));
  assert.deepEqual(second, { configured: true, checked: 0, verified: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").first().count, 1);
});

test("claim, delivery, and admin acceptance keep the linked service order in sync", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const treasury = `0x${"a".repeat(40)}`;
  const txHash = `0x${"2".repeat(64)}`;
  const amountAtomic = "99000000";
  seedPaidOrder(db, { orderId: "order-2", txHash, amountAtomic });
  await processPendingOrders({ DB: db, TREASURY_WALLET_ADDRESS: treasury }, jsonRpcFetcher({ treasury, amountAtomic }));
  const taskId = db.prepare("SELECT published_task_id FROM service_orders WHERE id='order-2'").first().published_task_id;
  db.prepare("INSERT INTO guild_applications(id,handle,status,created_at,updated_at) VALUES('member-1','agent-one','active',1,1)").run();
  const signer = await signingFixture();

  const claim = await signer.claim(taskId, "agent-one");
  await claimTask(db, taskId, claim.input, claim.fetcher);
  let order = db.prepare("SELECT status,assigned_agent,claimed_at FROM service_orders WHERE id='order-2'").first();
  assert.equal(order.status, "in_progress");
  assert.equal(order.assigned_agent, "agent-one");
  assert.ok(order.claimed_at > 0);

  const artifact = "https://example.test/deliveries/order-2";
  const submission = await signer.submission(taskId, "agent-one", artifact);
  const delivered = await submitWork(db, taskId, submission.input, submission.fetcher);
  order = db.prepare("SELECT status,delivery_submission_id,delivery_artifact,delivered_at FROM service_orders WHERE id='order-2'").first();
  assert.equal(order.status, "review");
  assert.equal(order.delivery_submission_id, delivered.id);
  assert.equal(order.delivery_artifact, artifact);
  assert.ok(order.delivered_at > 0);

  const completionInput = {
    verification_summary: "Independent replay of the published acceptance checks passed against the delivered artifact.",
    evidence_url: "https://example.test/verifications/order-2",
  };
  const completion = await completeSubmission(db, delivered.id, completionInput);
  assert.equal(completion.submission.status, "accepted");
  assert.equal(completion.payout_proposal.status, "awaiting_owner_signature");
  assert.equal(completion.notification, "queued");
  assert.equal(db.prepare("SELECT id FROM payout_proposals WHERE submission_id=?").bind(delivered.id).first().id, completion.payout_proposal.id);
  order = db.prepare("SELECT status,accepted_at FROM service_orders WHERE id='order-2'").first();
  assert.equal(order.status, "completed");
  assert.ok(order.accepted_at > 0);
  const acceptedEvent = db.prepare("SELECT details FROM order_events WHERE order_id='order-2' AND kind='delivery_accepted'").first();
  assert.equal(JSON.parse(acceptedEvent.details).payout_authority, "owner_signature_required");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_proposals").first().count, 1);
  assert.equal(db.prepare("SELECT status FROM payout_proposals").first().status, "awaiting_owner_signature");

  const retry = await completeSubmission(db, delivered.id, {});
  assert.equal(retry.payout_proposal.id, completion.payout_proposal.id);
  assert.equal(retry.acceptance_receipt.id, completion.acceptance_receipt.id);
  assert.equal(retry.notification, "deduplicated");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_proposals").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_acceptance_receipts").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notification_events").first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM order_events WHERE order_id='order-2' AND kind='delivery_accepted'").first().count, 1);
});

test("a transaction claimed for another purpose cannot publish a service task", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const treasury = `0x${"a".repeat(40)}`;
  const txHash = `0x${"3".repeat(64)}`;
  const amountAtomic = "99000000";
  seedPaidOrder(db, { orderId: "order-3", txHash, amountAtomic });
  db.prepare("UPDATE payment_receipt_claims SET purpose_type='bounty',purpose_id='bounty-1' WHERE tx_hash=?").bind(txHash).run();

  const result = await processPendingOrders({ DB: db, TREASURY_WALLET_ADDRESS: treasury }, jsonRpcFetcher({ treasury, amountAtomic }));
  assert.deepEqual(result, { configured: true, checked: 0, verified: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM tasks").first().count, 0);
  assert.equal(db.prepare("SELECT status FROM service_orders WHERE id='order-3'").first().status, "payment_review");
});

test("acceptance input requires bounded independent evidence over HTTPS", () => {
  const valid = validateAcceptance({
    verification_summary: "Exactly twenty chars!",
    evidence_url: "https://evidence.example/receipt",
  });
  assert.deepEqual(valid, {
    verificationSummary: "Exactly twenty chars!",
    evidenceUrl: "https://evidence.example/receipt",
  });
  assert.throws(() => validateAcceptance({ verification_summary: "too short", evidence_url: "https://evidence.example/receipt" }), /20-4000/);
  assert.throws(() => validateAcceptance({ verification_summary: "A".repeat(4001), evidence_url: "https://evidence.example/receipt" }), /20-4000/);
  assert.throws(() => validateAcceptance({ verification_summary: "A sufficiently detailed verification note.", evidence_url: "http://evidence.example/receipt" }), /HTTPS URL/);
  assert.throws(() => validateAcceptance({ verification_summary: "A sufficiently detailed verification note.", evidence_url: "https://" }), /HTTPS URL/);
  assert.throws(() => validateAcceptance({ verification_summary: "A sufficiently detailed verification note.", evidence_url: "https://user:secret@evidence.example/receipt" }), /without embedded credentials/);
});

test("admin acceptance rejects work that is not the linked delivery of a paid order", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const task = db.prepare("INSERT INTO tasks(title,description,acceptance_criteria,category,reward_atomic,platform_fee_bps,status,fulfillment_mode,created_at,expires_at) VALUES(?,?,?,?,?,1500,'review','digital',?,?) RETURNING id")
    .bind("Standalone review task", "A standalone task that is not backed by a paid service order.", "The supplied artifact passes all published checks.", "engineering", "99000000", 1, Math.floor(Date.now() / 1000) + 3600).first();
  const submission = db.prepare("INSERT INTO submissions(task_id,agent_handle,artifact,note,signed_at,signature,status,created_at) VALUES(?,?,?,?,?,?,'submitted',?) RETURNING id")
    .bind(task.id, "agent-one", "https://example.test/unlinked", "ready", 1, "signature", 1).first();

  await assert.rejects(() => completeSubmission(db, submission.id, {
    verification_summary: "Independent replay of every acceptance check passed.",
    evidence_url: "https://evidence.example/unlinked",
  }), /linked delivery for a paid service order/);
  assert.equal(db.prepare("SELECT status FROM submissions WHERE id=?").bind(submission.id).first().status, "submitted");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").bind(task.id).first().status, "review");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_acceptance_receipts").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_proposals").first().count, 0);
});

test("a mid-batch failure rolls back acceptance and a retry creates one payout proposal", async (t) => {
  const db = new TestD1({ failBatchOn: "INSERT INTO payout_proposals" });
  t.after(() => db.close());
  const { delivered, taskId } = await deliverPaidOrder(db, { orderId: "order-atomic", txHash: `0x${"4".repeat(64)}` });
  const input = {
    verification_summary: "Independent replay of the published acceptance checks passed against the delivered artifact.",
    evidence_url: "https://example.test/verifications/order-atomic",
  };

  await assert.rejects(() => completeSubmission(db, delivered.id, input), /failed atomically/);
  assert.equal(db.prepare("SELECT status FROM submissions WHERE id=?").bind(delivered.id).first().status, "submitted");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").bind(taskId).first().status, "review");
  assert.equal(db.prepare("SELECT status FROM service_orders WHERE id='order-atomic'").first().status, "review");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_acceptance_receipts").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_proposals").first().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM order_events WHERE order_id='order-atomic' AND kind='delivery_accepted'").first().count, 0);

  db.failBatchOn = "";
  const completion = await completeSubmission(db, delivered.id, input);
  const retry = await completeSubmission(db, delivered.id, {});
  assert.equal(completion.payout_proposal.status, "awaiting_owner_signature");
  assert.equal(retry.payout_proposal.id, completion.payout_proposal.id);
  assert.equal(retry.notification, "deduplicated");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_proposals WHERE task_id=? AND submission_id=?").bind(taskId, delivered.id).first().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE kind='work_accepted' AND subject_id=?").bind(String(delivered.id)).first().count, 1);
});

test("acceptance fails closed when verified payment or delivery linkage changes", async (t) => {
  const db = new TestD1();
  t.after(() => db.close());
  const { delivered, taskId } = await deliverPaidOrder(db, { orderId: "order-state", txHash: `0x${"5".repeat(64)}` });
  db.prepare("UPDATE service_orders SET payment_status='pending_verification' WHERE id='order-state'").run();

  await assert.rejects(() => completeSubmission(db, delivered.id, {
    verification_summary: "Independent replay of every acceptance check passed.",
    evidence_url: "https://evidence.example/order-state",
  }), /payment is not verified/);
  assert.equal(db.prepare("SELECT status FROM submissions WHERE id=?").bind(delivered.id).first().status, "submitted");
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id=?").bind(taskId).first().status, "review");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM payout_proposals").first().count, 0);
});
