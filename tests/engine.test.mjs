// Core scoring-logic tests for DecisionMatrix.
// Run:  node --test tests/   (Node 18+, no dependencies beyond decimal.js)
import test from "node:test";
import assert from "node:assert/strict";
import {
  create_decision,
  score_options,
  compare_two,
  sensitivity_analysis,
  list_methods,
  health_check,
} from "../worker-src/engine.mjs";

// A simple, hand-verifiable fixture: laptops on price (cost) + battery + weight (cost).
const OPTIONS = ["Alpha", "Beta", "Gamma"];
const CRITERIA = [
  { name: "Price", weight: 3, direction: "cost" },
  { name: "Battery", weight: 2, direction: "benefit" },
  { name: "Weight", weight: 1, direction: "cost" },
];
const SCORES = {
  Alpha: { Price: 1000, Battery: 8, Weight: 1.5 },
  Beta: { Price: 1200, Battery: 12, Weight: 1.8 },
  Gamma: { Price: 900, Battery: 6, Weight: 1.2 },
};

test("create_decision returns a well-formed envelope", () => {
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  assert.equal(r.status, "success");
  assert.ok(r.winner && r.winner.option);
  assert.equal(r.ranking.length, 3);
  assert.equal(r.ranking[0].rank, 1);
  assert.equal(typeof r.explanation, "string");
  assert.ok(r.methodology && r.methodology.method === "weighted_sum");
  assert.equal(r.weights_used.length, 3);
  // Every ranking entry has a full per-criterion breakdown.
  for (const row of r.ranking) assert.equal(row.breakdown.length, 3);
});

test("weighted_sum math is exact and hand-verifiable", () => {
  // Min-max normalization (best=1):
  //   Price(cost): min900,max1200 -> Alpha (1200-1000)/300=0.6667, Beta 0, Gamma 1
  //   Battery(ben): min6,max12    -> Alpha (8-6)/6=0.3333, Beta 1, Gamma 0
  //   Weight(cost): min1.2,max1.8 -> Alpha (1.8-1.5)/.6=0.5, Beta 0, Gamma 1
  // Weights normalized: 3/6=.5, 2/6=.3333, 1/6=.1667
  //   Alpha = .5*.6667 + .3333*.3333 + .1667*.5 = .3333+.1111+.0833 = 0.527778
  //   Beta  = .5*0     + .3333*1     + .1667*0   = 0.333333
  //   Gamma = .5*1     + .3333*0     + .1667*1   = 0.666667
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  const byName = Object.fromEntries(r.ranking.map((x) => [x.option, x.score]));
  assert.equal(byName.Gamma, 0.666667);
  assert.equal(byName.Alpha, 0.527778);
  assert.equal(byName.Beta, 0.333333);
  assert.equal(r.winner.option, "Gamma");
});

test("determinism: identical inputs -> byte-identical output", () => {
  const a = JSON.stringify(create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES }));
  const b = JSON.stringify(create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES }));
  assert.equal(a, b);
});

test("weights are relative (scaling all weights does not change ranking)", () => {
  const scaled = CRITERIA.map((c) => ({ ...c, weight: c.weight * 10 }));
  const r1 = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  const r2 = create_decision({ options: OPTIONS, criteria: scaled, scores: SCORES });
  assert.deepEqual(r1.ranking.map((x) => x.option), r2.ranking.map((x) => x.option));
  assert.equal(r1.ranking[0].score, r2.ranking[0].score);
});

test("direction matters: flipping a cost to benefit changes the result", () => {
  const flipped = CRITERIA.map((c) => (c.name === "Price" ? { ...c, direction: "benefit" } : c));
  const r = create_decision({ options: OPTIONS, criteria: flipped, scores: SCORES });
  // Now expensive Beta gains on price; ensure output differs from baseline.
  const base = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  assert.notDeepEqual(r.ranking.map((x) => x.option), base.ranking.map((x) => x.option));
});

test("weighted_product rejects non-positive scores with an actionable error", () => {
  const bad = { Alpha: { Price: 0, Battery: 8, Weight: 1.5 }, Beta: { Price: 1200, Battery: 12, Weight: 1.8 } };
  const r = create_decision({ options: ["Alpha", "Beta"], criteria: CRITERIA, scores: bad, method: "weighted_product" });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "invalid_scores");
  assert.match(r.error.hint, /positive|weighted_sum|topsis/);
});

test("weighted_product ranks and stays in 0..1", () => {
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES, method: "weighted_product" });
  assert.equal(r.status, "success");
  for (const row of r.ranking) {
    assert.ok(row.score >= 0 && row.score <= 1, `score ${row.score} out of range`);
  }
});

test("topsis produces a 0..1 closeness score and a winner", () => {
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES, method: "topsis" });
  assert.equal(r.status, "success");
  assert.equal(r.method, "topsis");
  assert.ok(r.winner.score >= 0 && r.winner.score <= 1);
});

test("ties share a rank and are reported", () => {
  const opts = ["X", "Y"];
  const crit = [{ name: "A", weight: 1, direction: "benefit" }];
  const scores = { X: { A: 5 }, Y: { A: 5 } };
  const r = create_decision({ options: opts, criteria: crit, scores });
  assert.equal(r.ranking[0].rank, 1);
  assert.equal(r.ranking[1].rank, 1);
  assert.equal(r.winner.tie, true);
});

test("compare_two picks a winner and counts per-criterion wins", () => {
  const r = compare_two({ option_a: "Alpha", option_b: "Beta", criteria: CRITERIA, scores: SCORES });
  assert.equal(r.status, "success");
  assert.ok(r.winner === "Alpha" || r.winner === "Beta");
  assert.equal(r.per_criterion.length, 3);
  const totalWins = Object.values(r.criteria_wins).reduce((a, b) => a + b, 0);
  assert.ok(totalWins <= 3);
});

test("compare_two rejects != 2 options", () => {
  const r = compare_two({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "wrong_option_count");
});

test("score_options returns the full scored matrix", () => {
  const r = score_options({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  assert.equal(r.status, "success");
  assert.equal(r.scored.length, 3);
  assert.equal(r.scored[0].criteria.length, 3);
});

test("sensitivity_analysis reports robustness and per-criterion flips", () => {
  const r = sensitivity_analysis({ options: OPTIONS, criteria: CRITERIA, scores: SCORES, variation: 0.3, steps: 6 });
  assert.equal(r.status, "success");
  assert.ok(r.robustness_score >= 0 && r.robustness_score <= 1);
  assert.equal(r.per_criterion.length, 3);
  assert.equal(r.baseline_winner, "Gamma");
});

// ---- error handling ---------------------------------------------------------

test("missing scores -> incomplete_scores error listing the gap", () => {
  const partial = { Alpha: { Price: 1000, Battery: 8, Weight: 1.5 }, Beta: { Price: 1200, Battery: 12 }, Gamma: { Price: 900, Battery: 6, Weight: 1.2 } };
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: partial });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "incomplete_scores");
  assert.match(r.error.hint, /Beta \/ Weight/);
});

test("non-numeric score -> actionable error", () => {
  const bad = { Alpha: { Price: "cheap", Battery: 8, Weight: 1.5 }, Beta: { Price: 1200, Battery: 12, Weight: 1.8 } };
  const r = create_decision({ options: ["Alpha", "Beta"], criteria: CRITERIA, scores: bad });
  assert.equal(r.status, "error");
  assert.match(r.error.message, /not a valid number/);
});

test("duplicate option names are rejected", () => {
  const r = create_decision({ options: ["A", "A"], criteria: CRITERIA, scores: { A: { Price: 1, Battery: 1, Weight: 1 } } });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "duplicate_option");
});

test("negative weight is rejected", () => {
  const crit = [{ name: "A", weight: -1, direction: "benefit" }];
  const r = create_decision({ options: ["X", "Y"], criteria: crit, scores: { X: { A: 1 }, Y: { A: 2 } } });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "invalid_weight");
});

test("unknown method -> unknown_method error", () => {
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES, method: "magic" });
  assert.equal(r.status, "error");
  assert.equal(r.error.type, "unknown_method");
});

test("method aliases resolve (saw -> weighted_sum)", () => {
  const r = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES, method: "saw" });
  assert.equal(r.status, "success");
  assert.equal(r.method, "weighted_sum");
});

test("array-form scores and inline option scores both work", () => {
  const arr = create_decision({
    options: OPTIONS, criteria: CRITERIA,
    scores: [
      { option: "Alpha", scores: { Price: 1000, Battery: 8, Weight: 1.5 } },
      { option: "Beta", scores: { Price: 1200, Battery: 12, Weight: 1.8 } },
      { option: "Gamma", scores: { Price: 900, Battery: 6, Weight: 1.2 } },
    ],
  });
  const inline = create_decision({
    options: [
      { name: "Alpha", scores: { Price: 1000, Battery: 8, Weight: 1.5 } },
      { name: "Beta", scores: { Price: 1200, Battery: 12, Weight: 1.8 } },
      { name: "Gamma", scores: { Price: 900, Battery: 6, Weight: 1.2 } },
    ],
    criteria: CRITERIA,
  });
  const obj = create_decision({ options: OPTIONS, criteria: CRITERIA, scores: SCORES });
  assert.equal(arr.winner.option, obj.winner.option);
  assert.equal(inline.winner.option, obj.winner.option);
  assert.equal(arr.ranking[0].score, obj.ranking[0].score);
});

test("list_methods + health_check discovery tools", () => {
  const m = list_methods();
  assert.equal(m.status, "success");
  assert.equal(m.default_method, "weighted_sum");
  assert.ok(m.methods.weighted_sum && m.methods.topsis && m.methods.weighted_product);
  const h = health_check();
  assert.equal(h.status, "ok");
  assert.equal(h.tools.length, 6);
});
