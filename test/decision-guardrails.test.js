import test from "node:test";
import assert from "node:assert/strict";

import { calculateKelly } from "../src/analytics.js";
import { tradePricingForPrediction } from "../src/index.js";
import { normalizeShortAnalysis, parseOpenAiResponse } from "../src/qwen.js";
import { chainlinkVariant } from "../src/short_condition.js";

test("short analysis converts primary probability for DOWN EV", () => {
  const result = normalizeShortAnalysis({
    condition: "TRENDING",
    recommendation: "PLAY",
    direction: "DOWN",
    confidence: 88,
    estimated_fair_probability: 30,
  }, 30);

  assert.equal(result.recommendation, "PLAY");
  assert.equal(result.direction, "DOWN");
  assert.equal(result.primary_outcome_probability, 30);
  assert.equal(result.estimated_fair_probability, 70);
});

test("short analysis clamps AI adjustment to fifteen points", () => {
  const result = normalizeShortAnalysis({
    condition: "TRENDING",
    recommendation: "PLAY",
    direction: "UP",
    confidence: 90,
    estimated_fair_probability: 99,
  }, 50);

  assert.equal(result.primary_outcome_probability, 65);
  assert.equal(result.estimated_fair_probability, 65);
});

test("short analysis rejects contradictory direction", () => {
  const result = normalizeShortAnalysis({
    condition: "TRENDING",
    recommendation: "PLAY",
    direction: "DOWN",
    confidence: 95,
    estimated_fair_probability: 75,
  }, 70);

  assert.equal(result.recommendation, "AVOID");
  assert.equal(result.direction, "NEUTRAL");
  assert.match(result.reason, /OUTPUT VALIDATION/);
});

test("short analysis rejects blank probability and unknown condition", () => {
  const blankProbability = normalizeShortAnalysis({
    condition: "TRENDING",
    recommendation: "PLAY",
    direction: "DOWN",
    confidence: 90,
    estimated_fair_probability: "",
  }, 40);
  assert.equal(blankProbability.recommendation, "AVOID");

  const unknownCondition = normalizeShortAnalysis({
    condition: "SIDEWAYSISH",
    recommendation: "PLAY",
    direction: "UP",
    confidence: 90,
    estimated_fair_probability: 65,
  }, 60);
  assert.equal(unknownCondition.recommendation, "AVOID");
  assert.equal(unknownCondition.direction, "NEUTRAL");
});

test("Kelly returns zero stake for zero edge and ignores neutral history", () => {
  const zeroEdge = calculateKelly({ edge: 0, confidence: 90, bankroll: 1000 });
  assert.equal(zeroEdge.kelly, 0);
  assert.equal(zeroEdge.positionSize, 0);

  const withNeutral = calculateKelly({
    edge: 0.1,
    confidence: 90,
    bankroll: 1000,
    recentTrades: [{ result: "netral", status: "selesai", created_at: new Date().toISOString() }],
  });
  assert.equal(withNeutral.risk.drawdown, 0);
  assert.deepEqual(withNeutral.risk.streak, { type: "none", count: 0 });
});

test("trade price cap preserves EV plus the configured fee buffer", () => {
  assert.deepEqual(
    tradePricingForPrediction({ estimatedFairProbability: 70 }, "UP"),
    { fairProbability: 70, maxEntryPrice: 0.61 }
  );
  assert.deepEqual(
    tradePricingForPrediction({ estimatedFairProbability: 90 }, "="),
    { fairProbability: null, maxEntryPrice: null }
  );
});

test("Chainlink variants cover every listed short-market duration", () => {
  assert.equal(chainlinkVariant("5m"), "fiveminute");
  assert.equal(chainlinkVariant("15m"), "fifteen");
  assert.equal(chainlinkVariant("1h"), "hourly");
  assert.equal(chainlinkVariant("4h"), "fourhour");
  assert.equal(chainlinkVariant("1d"), "daily");
});

test("9Router JSON response accepts a trailing SSE done marker", () => {
  const parsed = parseOpenAiResponse('{"choices":[{"message":{"content":"OK"}}]}\ndata: [DONE]');
  assert.equal(parsed.choices[0].message.content, "OK");
});
