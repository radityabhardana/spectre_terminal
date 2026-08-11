import assert from "node:assert/strict";
import test from "node:test";

import { classifyOutcome, winningOutcomeForMarket } from "../src/resolution.js";

test("winning outcome requires a closed market with one unambiguous winner", () => {
  assert.equal(winningOutcomeForMarket({ closed: false, outcomes: ["Up", "Down"], outcomePrices: [1, 0] }), null);
  assert.equal(winningOutcomeForMarket({ closed: true, outcomes: ["Up", "Down"], outcomePrices: [0.8, 0.2] }), null);
  assert.equal(winningOutcomeForMarket({ closed: true, outcomes: ["Up", "Down"], outcomePrices: [0.99, 0.01] }), "Up");
});

test("current strategy uses exact outcome labels", () => {
  assert.equal(classifyOutcome({ prediction: "UP", strategy_version: "chainlink-terminal-value-v3" }, "Up"), "menang");
  assert.equal(classifyOutcome({ prediction: "YES", strategy_version: "chainlink-terminal-value-v3" }, "Up"), "kalah");
});

test("legacy strategies retain YES-UP and NO-DOWN aliases", () => {
  assert.equal(classifyOutcome({ prediction: "YES", strategy_version: "legacy-v1" }, "Up"), "menang");
  assert.equal(classifyOutcome({ prediction: "NO", strategy_version: "legacy-v1" }, "Down"), "menang");
});

test("neutral predictions resolve without affecting win-loss statistics", () => {
  for (const prediction of ["=", "SKIP", "NETRAL", "WATCHLIST"]) {
    assert.equal(classifyOutcome({ prediction, strategy_version: "chainlink-terminal-value-v3" }, "Up"), "netral");
  }
});
