import test from "node:test";
import assert from "node:assert/strict";
import { TestD1 } from "./helpers/d1.js";
import { USDC, RPCS } from "../src/payment-intents.js";
import { DAY, AMOUNT, signingPayload, operateConnection, connectionState, processAgentConnections, handleAgentConnectionRoutes } from "../src/agent-connections.js";
import { runHostedAgentCycle } from "../src/hosted-agent.js";
const NOW = Date.parse("2026-08-30T22:30:00Z"), TREASURY = "0x" + "a".repeat(40);
const TX = "0x" + "b".repeat(64), BLOCK = "0x" + "c".repeat(64);
const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const b64 = bytes => Buffer.from(bytes).toString("base64url");

async function fixture(t) {
  const db = new TestD1(); t.after(() => db.close());
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const key = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  const env = { DB: db, MAG_AGENT_CONNECTIONS_ENABLED: "true", MAG_HOSTED_WORK_WATCH_ENABLED: "true", TREASURY_WALLET_ADDRESS: TREASURY };
  db.prepare("INSERT INTO guild_applications(id,handle,status,registry_verified_at,created_at,updated_at) VALUES(?,'citizen-test','active',?,?,?)").bind(crypto.randomUUID(), NOW, NOW, NOW).run();
  const keys = async url => {
    assert.equal(url, "https://1f916.ai/api/keys/citizen-test");
    return Response.json({ keys: [{ public_key: key, status: "active" }] });
  };
  async function signed(action, id, tx = "", now = NOW) {
    const payload = await signingPayload(env, { action, handle: "citizen-test", invoice_id: id, tx_hash: tx }, now);
    return { ...payload, signature: b64(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(payload.preimage))) };
  }
  async function invoice(now = NOW) {
    const id = crypto.randomUUID(), input = await signed("invoice", id, "", now);
    const result = await operateConnection(env, input, keys, now);
    return { ...result, input };
  }
  async function submit(id, tx = TX, now = NOW) {
    return operateConnection(env, await signed("receipt", id, tx, now), keys, now);
  }
  function rpc(id, tx = TX, mutate = () => {}) {
    const row = db.prepare("SELECT * FROM agent_connection_invoices WHERE id=?").bind(id).first();
    return async (url, init) => {
      const state = {
        chain: "0x2105",
        receipt: { status: "0x1", transactionHash: tx, blockHash: BLOCK, blockNumber: "0x100",
          logs: [{ address: USDC, topics: [transfer, "0x" + "0".repeat(64), "0x" + TREASURY.slice(2).padStart(64, "0")], data: "0xf4240" }] },
        transaction: { hash: tx, blockHash: BLOCK, to: USDC, input: row.calldata, value: "0x0" },
        finalized: { number: "0x101" }
      };
      mutate(state, RPCS.indexOf(url));
      const method = JSON.parse(init.body).method;
      return Response.json({ result: method === "eth_chainId" ? state.chain : method === "eth_getTransactionReceipt" ? state.receipt : method === "eth_getTransactionByHash" ? state.transaction : state.finalized });
    };
  }
  return { env, db, signed, keys, key, invoice, submit, rpc };
}
function count(db, table) { return db.prepare("SELECT COUNT(*) AS n FROM " + table).first().n; }

test("verified receipt drives hosted execution and signed artifact retrieval end to end", async t => {
  const f=await fixture(t), a=await f.invoice();
  assert.equal((await runHostedAgentCycle(f.env, async()=>{throw Error("unpaid must not fetch");}, NOW, ()=>NOW)).claimed,0);
  await f.submit(a.invoice.id);
  assert.equal((await processAgentConnections(f.env,f.rpc(a.invoice.id),NOW)).credited,1);
  const publicRead=async url=>Response.json(url.endsWith("/guide")||url.endsWith("/security")
    ?{rules_version:"fixture-v1"}:{listings:[],has_more:false});
  assert.equal((await runHostedAgentCycle(f.env,publicRead,NOW,()=>NOW)).completed,1);
  const input=await f.signed("status",a.invoice.id);
  const response=await handleAgentConnectionRoutes(new Request("https://mag.test/api/agent-connections",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)
  }),f.env,f.keys,NOW);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.connection.connected,true);assert.equal(result.hosted_runs[0].status,"completed");
  assert.equal(result.hosted_runs[0].artifact.scan_complete,true);assert.equal(result.hosted_runs[0].artifact.listing_count,0);
  assert.equal(result.hosted_runs[0].artifact.external_activation,false);
  assert.equal(count(f.db,"notification_events"),2); // payment event plus first delivery event, not citizen activation
});

test("new checkout is refused while hosted execution is disabled", async t => {
  const f=await fixture(t);f.env.MAG_HOSTED_WORK_WATCH_ENABLED="false";
  await assert.rejects(()=>f.invoice(),/hosted work-watch unavailable/);
  assert.equal(count(f.db,"agent_connection_invoices"),0);
});

test("daily connection manifest is explicit, fail-closed and performs no payment", async () => {
  const r = await handleAgentConnectionRoutes(new Request("https://mag.test/api/agent-connections"), {});
  const m = await r.json();
  assert.equal(m.amount_atomic, "1000000"); assert.equal(m.duration_ms, DAY);
  assert.equal(m.enabled, false); assert.equal(m.saturnshift_enabled, false); assert.equal(m.automatic_debit, false);
  const denied = await handleAgentConnectionRoutes(new Request("https://mag.test/api/agent-connections", { method: "POST" }), {});
  assert.equal(denied.status, 503);
  assert.deepEqual(await processAgentConnections({}), { enabled: false, checked: 0, credited: 0 });
});
test("signed invoice pins one USDC, member, recipient and reference; retry is idempotent", async t => {
  const f = await fixture(t), created = await f.invoice();
  assert.equal(created.invoice.amount_atomic, AMOUNT);
  assert.equal(created.payment_request.chainId, "0x2105");
  assert.ok(created.payment_request.data.startsWith("0xa9059cbb")); // transfer, not approval
  assert.equal(created.payment_request.value, "0x0");
  await operateConnection(f.env, { ...created.input, amount_atomic: "1", duration_ms: 999 }, f.keys, NOW);
  assert.equal(count(f.db, "agent_connection_invoices"), 1);
  assert.equal(created.connection.connected, false);
  assert.throws(() => f.db.prepare("UPDATE agent_connection_invoices SET amount_atomic='1'").run(), /immutable/);
  await assert.rejects(() => f.invoice(), /reuse.*invoice/);
});
test("forged, stale, wrong-subject and revoked-key requests cannot open invoices", async t => {
  const f = await fixture(t), id = crypto.randomUUID(), input = await f.signed("invoice", id);
  await assert.rejects(() => operateConnection(f.env, { ...input, signature: b64(new Uint8Array(64)) }, f.keys, NOW), /signature/);
  await assert.rejects(() => operateConnection(f.env, { ...input, invoice_id: crypto.randomUUID() }, f.keys, NOW), /signature/);
  await assert.rejects(() => operateConnection(f.env, input, f.keys, NOW + 300001), /expired/);
  await assert.rejects(() => operateConnection(f.env, input, async () => Response.json({ keys: [{ public_key: f.key, status: "revoked" }] }), NOW), /signature/);
  assert.equal(count(f.db, "agent_connection_invoices"), 0);
  f.db.prepare("UPDATE guild_applications SET status='pending'").run();
  await assert.rejects(() => f.invoice(), /approved/);
});
test("pending receipt grants nothing; finalized witnesses credit precisely one 24-hour day", async t => {
  const f = await fixture(t), a = await f.invoice();
  const pending = await f.submit(a.invoice.id);
  assert.equal(pending.payment_request, null);
  assert.equal(pending.invoice.status, "pending_verification"); assert.equal(pending.connection.connected, false);
  assert.equal(count(f.db, "payment_receipt_claims"), 0);
  const result = await processAgentConnections(f.env, f.rpc(a.invoice.id), NOW);
  assert.equal(result.credited, 1);
  const state = await connectionState(f.db, "citizen-test", NOW);
  assert.equal(state.connected, true); assert.equal(state.paid_through, NOW + DAY); assert.equal(state.contributor_activation, false);
  assert.equal(count(f.db, "notification_events"), 1);
  assert.equal(f.db.prepare("SELECT kind FROM notification_events").first().kind, "agent_connection_paid");
  assert.equal(f.db.prepare("SELECT status FROM guild_applications").first().status, "active");
});
test("wrong chain, asset, recipient, amount, reference, finality or disagreeing witness never credit", async t => {
  const mutations = [
    s => { s.chain = "0x1"; },
    s => { s.receipt.logs[0].address = TREASURY; },
    s => { s.receipt.logs[0].topics[2] = "0x" + "0".repeat(64); },
    s => { s.receipt.logs[0].data = "0xf4241"; },
    s => { s.transaction.input = "0x"; },
    s => { s.finalized.number = "0xff"; },
    s => { s.receipt.status = "0x0"; },
    s => { s.receipt.blockHash = "0x" + "d".repeat(64); s.transaction.blockHash = s.receipt.blockHash; }
  ];
  for (const mutation of mutations) {
    for (const witness of [0, 1]) {
      const f = await fixture(t), a = await f.invoice(); await f.submit(a.invoice.id);
      assert.equal((await processAgentConnections(f.env, f.rpc(a.invoice.id, TX, (s, w) => { if (w === witness) mutation(s); }), NOW)).credited, 0);
      assert.equal(count(f.db, "payment_receipt_claims"), 0); assert.equal(count(f.db, "notification_events"), 0);
    }
  }
});
test("provider outage keeps the receipt pending, without logging or granting access", async t => {
  const f = await fixture(t), a = await f.invoice(); await f.submit(a.invoice.id);
  assert.equal((await processAgentConnections(f.env, async () => new Response("", { status: 503 }), NOW)).credited, 0);
  assert.equal((await connectionState(f.db, "citizen-test", NOW)).connected, false);
});
test("duplicate submissions and overlapping workers produce one credit and notification", async t => {
  const f = await fixture(t), a = await f.invoice(); await f.submit(a.invoice.id); await f.submit(a.invoice.id);
  const results = await Promise.all([processAgentConnections(f.env, f.rpc(a.invoice.id), NOW), processAgentConnections(f.env, f.rpc(a.invoice.id), NOW)]);
  assert.equal(results.reduce((n, r) => n + r.credited, 0), 1);
  await f.submit(a.invoice.id);
  assert.equal(count(f.db, "notification_events"), 1); assert.equal(count(f.db, "payment_receipt_claims"), 1);
  assert.equal((await connectionState(f.db, "citizen-test", NOW)).paid_through, NOW + DAY);
});
test("cross-purpose transaction reuse rolls the entire credit transaction back", async t => {
  const f = await fixture(t), a = await f.invoice(); await f.submit(a.invoice.id);
  f.db.prepare("INSERT INTO payment_receipt_claims VALUES(?,'service_order',?,?)").bind(TX, crypto.randomUUID(), NOW).run();
  assert.equal((await processAgentConnections(f.env, f.rpc(a.invoice.id), NOW)).credited, 0);
  assert.equal(count(f.db, "notification_events"), 0);
  assert.equal((await connectionState(f.db, "citizen-test", NOW)).connected, false);
});
test("a changed pending hash during verification cannot get stale proof credited", async t => {
  const f = await fixture(t), a = await f.invoice(); await f.submit(a.invoice.id);
  const good = f.rpc(a.invoice.id); let changed = false;
  const fetcher = async (url, init) => {
    const r = await good(url, init);
    if (!changed && JSON.parse(init.body).method === "eth_getTransactionByHash") {
      changed = true;
      f.db.prepare("UPDATE agent_connection_invoices SET tx_hash=? WHERE id=?").bind("0x" + "e".repeat(64), a.invoice.id).run();
    }
    return r;
  };
  assert.equal((await processAgentConnections(f.env, fetcher, NOW)).credited, 0);
  assert.equal(count(f.db, "payment_receipt_claims"), 0); assert.equal(count(f.db, "notification_events"), 0);
});
test("early renewals stack, lapsed renewals restart now, and suspension still denies connection", async t => {
  const f = await fixture(t);
  for (const [time, hash, expected] of [[NOW, TX, NOW+DAY], [NOW+1000, "0x"+"d".repeat(64), NOW+2*DAY], [NOW+3*DAY, "0x"+"e".repeat(64), NOW+4*DAY]]) {
    const a = await f.invoice(time); await f.submit(a.invoice.id, hash, time);
    assert.equal((await processAgentConnections(f.env, f.rpc(a.invoice.id, hash), time)).credited, 1);
    assert.equal((await connectionState(f.db, "citizen-test", time)).paid_through, expected);
  }
  assert.equal((await connectionState(f.db, "citizen-test", NOW+4*DAY)).connected, false);
  f.db.prepare("UPDATE guild_applications SET status='suspended'").run();
  assert.equal((await connectionState(f.db, "citizen-test", NOW+3*DAY)).connected, false);
  assert.equal(count(f.db, "notification_events"), 3);
});
test("payment never auto-approves a citizen suspended while settlement was pending", async t => {
  const f = await fixture(t), a = await f.invoice(); await f.submit(a.invoice.id);
  f.db.prepare("UPDATE guild_applications SET status='suspended'").run();
  assert.equal((await processAgentConnections(f.env, f.rpc(a.invoice.id), NOW)).credited, 1);
  assert.equal((await connectionState(f.db, "citizen-test", NOW)).connected, false);
  assert.equal(f.db.prepare("SELECT status FROM guild_applications").first().status, "suspended");
});
test("API rejects unsigned actions, oversized bodies and cross-origin posts", async t => {
  const f = await fixture(t);
  const request = (body, headers = {}) => new Request("https://mag.test/api/agent-connections", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await handleAgentConnectionRoutes(request("{}"), f.env, f.keys, NOW)).status, 400);
  assert.equal((await handleAgentConnectionRoutes(request(JSON.stringify({ padding: "x".repeat(9000) })), f.env, f.keys, NOW)).status, 400);
  assert.equal((await handleAgentConnectionRoutes(request("{}", { origin: "https://evil.test" }), f.env, f.keys, NOW)).status, 403);
  assert.equal(count(f.db, "agent_connection_invoices"), 0);
});
test("slow or invalid pending receipts cannot permanently starve later invoices", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) {
    const handle = "pending-" + i;
    f.db.prepare("INSERT INTO guild_applications(id,handle,status,registry_verified_at,created_at,updated_at) VALUES(?,?,'active',?,?,?)").bind(crypto.randomUUID(), handle, NOW, NOW, NOW).run();
    f.db.prepare("INSERT INTO agent_connection_invoices(id,handle,amount_atomic,treasury_address,calldata,status,tx_hash,created_at) VALUES(?,?,?,? ,?,'pending_verification',?,?)")
      .bind(crypto.randomUUID(), handle, AMOUNT, TREASURY, "fixture-" + i, TX, NOW+i).run();
  }
  const unavailable = async () => new Response("", { status: 503 });
  assert.equal((await processAgentConnections(f.env, unavailable, NOW+100)).checked, 5);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM agent_connection_invoices WHERE last_checked_at IS NOT NULL").first().n, 5);
  await processAgentConnections(f.env, unavailable, NOW+200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM agent_connection_invoices WHERE last_checked_at IS NOT NULL").first().n, 6);
});
