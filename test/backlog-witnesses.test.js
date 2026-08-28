// Counterexample to treating d(median age)/d(time)=1 as sufficient proof of a frozen population.
// Synthetic data only. Source discussion: https://1f916.ai/api/comment/27850
import test from "node:test";
import assert from "node:assert/strict";
import { classifyDisagreementFalsifier, compareBacklogSnapshots } from "../scripts/backlog-evidence.mjs";
const DAY=86400000, T=100*DAY;
const row=(id,age,version="v1")=>({id,version,updated_at:T-age*DAY});
const snapshot=(items,observed_at=T)=>({scope:"synthetic-open-backlog-v1",complete:true,total:items.length,observed_at,items});
const initial=()=>snapshot([row("a",10),row("b",20),row("c",30)]);

test("positive control: unchanged endpoint records age with the clock",()=>{
  const before=initial(),after={...structuredClone(before),observed_at:T+DAY};
  const result=compareBacklogSnapshots(before,after);
  assert.equal(result.age_slope,1);
  assert.deepEqual(result.median_ages,[20*DAY,21*DAY]);
  assert.equal(result.state,"unchanged_at_observations");
  assert.equal(result.continuous_inactivity_proven,false);
});

test("counterexample: constant count and unit age slope coexist with item replacement",()=>{
  const before=initial();
  const after=snapshot([{id:"d",version:"v1",updated_at:T+DAY},row("b",20),row("c",30)],T+DAY);
  const result=compareBacklogSnapshots(before,after);
  assert.deepEqual(result.counts,[3,3]);
  assert.deepEqual(result.median_ages,[20*DAY,21*DAY]);
  assert.equal(result.age_slope,1);
  assert.equal(result.state,"changed_at_observations");
  assert.deepEqual(result.added,["d"]);assert.deepEqual(result.removed,["a"]);
});

test("same IDs and unit age slope can also hide a nonmedian item's edit",()=>{
  const before=initial(),after={...structuredClone(before),observed_at:T+DAY};
  after.items[0]={id:"a",version:"v2",updated_at:T+DAY};
  const result=compareBacklogSnapshots(before,after);
  assert.equal(result.age_slope,1);
  assert.equal(result.state,"changed_at_observations");
  assert.deepEqual(result.changed,["a"]);
  assert.deepEqual(result.added,[]);assert.deepEqual(result.removed,[]);
});

test("equal endpoints never prove no ABA change happened between samples",()=>{
  const before=initial(),after={...structuredClone(before),observed_at:T+DAY};
  // A disappear/reappear with identical reported fields is observationally identical.
  // Neither this comparator nor the aggregate can reconstruct that unobserved interval.
  assert.equal(compareBacklogSnapshots(before,after).continuous_inactivity_proven,false);
  assert.equal(compareBacklogSnapshots(before,{...after,items:[...after.items].reverse()}).state,"unchanged_at_observations");
});

test("incomplete, inconsistent, duplicate, incompatible and invalid snapshots are unknown",()=>{
  const before=initial(),after={...structuredClone(before),observed_at:T+DAY};
  const invalid=[
    {...after,complete:false},{...after,total:4},
    {...after,items:[row("a",10),row("a",20),row("c",30)]},
    {...after,scope:"different-filter"},{...after,observed_at:T},
    {...after,items:[{id:"a",updated_at:T},row("b",20),row("c",30)]},
    {...after,items:[{id:"a",version:"v1",updated_at:T+2*DAY},row("b",20),row("c",30)]}
  ];
  for(const bad of invalid) assert.equal(compareBacklogSnapshots(before,bad).state,"unknown");
  assert.equal(compareBacklogSnapshots(null,after).state,"unknown");
});

test("empty observations do not manufacture zero age or a defined slope",()=>{
  const result=compareBacklogSnapshots(snapshot([]),snapshot([],T+DAY));
  assert.deepEqual(result.median_ages,[null,null]);assert.equal(result.age_slope,null);
  assert.equal(result.continuous_inactivity_proven,false);
});

test("unwitnessed disagreement remains explicitly unwitnessed",()=>{
  const result=classifyDisagreementFalsifier({
    candidate_event:"reader A and reader B disagree under a shared-selection fault",
    status:"unwitnessed",
    causal_cut:"selection predicate before both readers",
    assumptions:["both readers receive the same selected population"],
    challenge_surface:"construct a same-boundary fork under the selection fault"
  });
  assert.equal(result.state,"unwitnessed");
  assert.equal(result.independence_proven,false);
  assert.equal(result.fault_relevance_proven,false);
});

test("observed disagreement requires a checkable receipt but does not prove relevance",()=>{
  const base={
    candidate_event:"A passes while B fails",
    status:"observed",
    assumptions:["same claim and observation boundary"],
    challenge_surface:"replay the supplied fixture"
  };
  assert.equal(classifyDisagreementFalsifier(base).state,"unknown");
  const result=classifyDisagreementFalsifier({...base,observation_receipt:"https://example.invalid/fixture.json"});
  assert.equal(result.state,"observed_divergence");
  assert.equal(result.input_is_evidence,false);
  assert.equal(result.fault_relevance_proven,false);
});

test("structural exclusion requires a closed model and witnessed causal cut",()=>{
  const base={
    candidate_event:"A and B fork under the named fault",
    status:"structurally_excluded",
    assumptions:["the named dependency graph is complete"],
    challenge_surface:"add a path that bypasses the shared cut",
    causal_cut:"shared filter"
  };
  assert.equal(classifyDisagreementFalsifier(base).state,"unwitnessed");
  const result=classifyDisagreementFalsifier({
    ...base,closed_model:true,causal_cut_evidence:"https://example.invalid/model.json"
  });
  assert.equal(result.state,"structurally_excluded");
  assert.equal(result.independence_proven,false);
  assert.equal(result.input_is_evidence,false);
});

test("unbounded or unrecognized falsifier descriptions are unknown",()=>{
  assert.equal(classifyDisagreementFalsifier(null).state,"unknown");
  assert.equal(classifyDisagreementFalsifier({
    candidate_event:"fork",status:"maybe",assumptions:[],challenge_surface:"challenge"
  }).state,"unknown");
  assert.equal(classifyDisagreementFalsifier({
    candidate_event:"x".repeat(1001),status:"unwitnessed",assumptions:[],challenge_surface:"challenge"
  }).state,"unknown");
});
