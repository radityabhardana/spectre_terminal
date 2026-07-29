import test from "node:test";
import assert from "node:assert/strict";

import { calculateKelly } from "../src/analytics.js";
import { entrySnapshotFromShortResult, qwenResultFromShortEvaluation, tradePricingForPrediction } from "../src/index.js";
import { formatAnalysis } from "../src/format.js";
import { normalizeShortAnalysis, parseOpenAiResponse, requestAiText } from "../src/qwen.js";
import {
  calculateTechnicalIndicators,
  chainlinkVariant,
  estimateTerminalUpProbability,
  evaluateDeterministicShortSnapshot,
  selectShortMarketSide,
  snapshotChanged,
} from "../src/short_condition.js";
import { ANALYSIS_STRATEGY_VERSION, summarizePlayStats } from "../src/storage.js";

test("terminal UP probability is symmetric and monotonic around Price to Beat", () => {
  const probability = (currentPrice) => estimateTerminalUpProbability({
    currentPrice,
    priceToBeat: 50_000,
    remainingMs: 300_000,
    atr: 500,
    atrIntervalMs: 300_000,
  });

  assert.ok(Math.abs(probability(50_000) - 50) < 0.001);
  for (const offset of [25, 100, 500, 1_000]) {
    assert.ok(Math.abs(probability(50_000 + offset) + probability(50_000 - offset) - 100) < 0.001);
  }
  const ordered = [49_500, 49_900, 50_000, 50_100, 50_500].map(probability);
  assert.deepEqual(ordered, [...ordered].sort((a, b) => a - b));
});

test("short side selection uses each executable ask and chooses the best qualifying EV", () => {
  const down = selectShortMarketSide({
    upProbability: 35,
    upAsk: 0.01,
    downAsk: 0.5,
    maxPrice: 0.7,
    feeBufferCents: 4,
  });
  assert.equal(down.direction, "DOWN");
  assert.equal(down.selected.ask, 0.5);
  assert.equal(down.selected.netEvCents, 11);

  const both = selectShortMarketSide({
    upProbability: 60,
    upAsk: 0.4,
    downAsk: 0.1,
    maxPrice: 0.7,
    feeBufferCents: 4,
    minDirectionalProbability: 0,
  });
  assert.equal(both.direction, "DOWN");
  assert.equal(both.selected.netEvCents, 26);
});

test("AI short normalization keeps explanation fields only", () => {
  const result = normalizeShortAnalysis({
    recommendation: "PLAY",
    direction: "DOWN",
    estimated_fair_probability: 99,
    reason: "Explanation",
    key_signals: { flow_verdict: "Context" },
  });
  assert.equal(result.reason, "Explanation");
  assert.equal(result.key_signals.flow_verdict, "Context");
  assert.equal("recommendation" in result, false);
  assert.equal("direction" in result, false);
  assert.equal("estimated_fair_probability" in result, false);
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

test("fast entry snapshot exposes deterministic executable pricing without AI metadata", () => {
  const result = entrySnapshotFromShortResult({
    oraclePublishTime: "2026-07-29T06:00:01.000Z",
    evaluation: {
      forecast_direction: "UP",
      primary_outcome_probability: 72,
      expected_value_cents: 13,
      oracle_age_ms: 2_000,
      remaining_ms: 210_000,
      guardrail_blockers: [],
      trade_pricing: {
        UP: { direction: "UP", fairProbability: 72, ask: 0.55, netEvCents: 13 },
        DOWN: { direction: "DOWN", fairProbability: 28, ask: 0.46, netEvCents: -22 },
      },
      deterministic_snapshot: { capturedAt: "2026-07-29T06:00:03.000Z", feeBufferCents: 4 },
    },
  }, {
    id: "market-1",
    question: "Bitcoin Up or Down",
    endDate: "2026-07-29T06:03:33.000Z",
    active: true,
    closed: false,
    acceptingOrders: true,
  });

  assert.equal(result.marketId, "market-1");
  assert.equal(result.remainingSeconds, 210);
  assert.equal(result.sides.UP.ask, 0.55);
  assert.equal(result.feeBufferCents, 4);
  assert.equal("usage" in result, false);
});

function shortEvaluationResult(overrides = {}) {
  const { evaluation: evaluationOverrides = {}, ...shortOverrides } = overrides;
  return qwenResultFromShortEvaluation({
    targetPrice: 63_776.63,
    oraclePrice: 63_753.48,
    oraclePublishTime: "2026-07-29T02:25:12.000Z",
    evaluation: {
      recommendation: "PLAY",
      confidence: 63,
      estimated_fair_probability: 63.38,
      primary_outcome_probability: 36.62,
      expected_value_cents: 9.38,
      technical_source: "chainlink",
      validation_issues: [],
      guardrail_blockers: [],
      raw_recommendation: "PLAY",
      raw_direction: "DOWN",
      raw_primary_probability: 36.62,
      direction: "DOWN",
      forecast_direction: "DOWN",
      deterministic_snapshot: { upAsk: 0.51, downAsk: 0.5, upMidpoint: 0.505, downMidpoint: 0.495 },
      trade_pricing: {},
      reason: "Deterministic fallback reason.",
      ...evaluationOverrides,
    },
    ...shortOverrides,
  });
}

function formatShortResult(qwenResult) {
  return formatAnalysis({
    market: {
      id: "3143210",
      question: "Bitcoin Up or Down - July 28, 10:25PM-10:30PM ET",
      outcomes: ["Up", "Down"],
      outcomePrices: [0.505, 0.495],
      liquidity: 17_793,
      volume: 31,
      active: true,
      closed: false,
      acceptingOrders: true,
      endDate: "2026-07-29T02:30:00.000Z",
    },
    score: {
      marketProbability: 50.5,
      primaryOutcomeLabel: "Up",
      secondaryOutcomeLabel: "Down",
      primaryTokenId: "up-token",
      secondaryTokenId: "down-token",
      bestBid: 0.49,
      bestAsk: 0.51,
      spreadPercent: 2,
      confidenceScore: 82,
      underdogScore: 3.1,
      liquidityRisk: "Low",
      spreadRisk: "Low",
      resolutionRisk: "Medium",
      dataWarnings: [],
      shortBookPrices: {
        up: { bestAsk: 0.51, midpoint: 0.505 },
        down: { bestAsk: 0.5, midpoint: 0.495 },
      },
    },
    qwenResult,
    finalPrediction: "DOWN",
    analysisTime: 9,
  });
}

test("short forecast direction stays visible when trade guardrails say AVOID", () => {
  const qwenResult = shortEvaluationResult({
    evaluation: {
      recommendation: "AVOID",
      direction: "NEUTRAL",
      forecast_direction: "DOWN",
      guardrail_blockers: ["[MAX ENTRY PRICE GUARDRAIL]"],
    },
  });

  assert.equal(qwenResult.analysis.scoutDirection, "DOWN");
  assert.equal(qwenResult.analysis.scoutRecommendation, "AVOID");
});

test("short AI timeout keeps deterministic PLAY but never fabricates zero token usage", () => {
  const qwenResult = shortEvaluationResult({
    aiExplanationStatus: "timeout",
    aiExplanationError: "The operation was aborted",
    evaluation: { ai_explanation_status: "timeout" },
  });
  const output = formatShortResult(qwenResult);

  assert.equal(qwenResult.usage, null);
  assert.match(qwenResult.model, /deepseek-v4-flash.*timeout/i);
  assert.match(output, /AI Tokens: unavailable \(timeout\)/);
  assert.match(output, /WARNING: AI explanation .*TIMEOUT; deterministic fallback used\./);
  assert.doesNotMatch(output, /Tokens: 0/);
});

test("successful short AI explanation reports real provider token usage", () => {
  const usage = { prompt_tokens: 240, completion_tokens: 60, total_tokens: 300 };
  const qwenResult = shortEvaluationResult({
    providerModel: "alims-intl/deepseek-v4-flash",
    aiExplanationStatus: "used",
    usage,
    evaluation: { ai_explanation_status: "used" },
  });
  const output = formatShortResult(qwenResult);

  assert.equal(qwenResult.usage, usage);
  assert.match(output, /AI Tokens: 300/);
  assert.match(output, /AI explanation \(alims-intl\/deepseek-v4-flash\): USED/);
  assert.doesNotMatch(output, /deterministic fallback used/);
});

test("short AI explanation is discarded only when the refreshed trade decision changes materially", () => {
  const initial = {
    currentPrice: 100,
    priceToBeat: 99,
    upAsk: 0.5,
    downAsk: 0.5,
    decision: {
      recommendation: "PLAY",
      direction: "UP",
      primary_outcome_probability: 60,
      selected_ask: 0.5,
      expected_value_cents: 6,
    },
  };
  const immaterialRefresh = {
    currentPrice: 100.1,
    priceToBeat: 99,
    upAsk: 0.505,
    downAsk: 0.495,
    decision: {
      recommendation: "PLAY",
      direction: "UP",
      primary_outcome_probability: 60.4,
      selected_ask: 0.505,
      expected_value_cents: 5.6,
    },
  };
  const changedDecision = {
    ...immaterialRefresh,
    decision: { ...immaterialRefresh.decision, recommendation: "AVOID", direction: "NEUTRAL" },
  };

  assert.equal(snapshotChanged(initial, immaterialRefresh), false);
  assert.equal(snapshotChanged(initial, changedDecision), true);
});

test("9Router JSON response accepts a trailing SSE done marker", () => {
  const parsed = parseOpenAiResponse('{"choices":[{"message":{"content":"OK"}}]}\ndata: [DONE]');
  assert.equal(parsed.choices[0].message.content, "OK");
});

test("plain-text AI requests do not require JSON output", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    model: "plain-model",
    choices: [{ message: { content: "Post-mortem text" } }],
  }), { status: 200, headers: { "content-type": "application/json" } }));

  const result = await requestAiText({
    model: "plain-model",
    messages: [{ role: "user", content: "Evaluate" }],
  });

  assert.equal(result.text, "Post-mortem text");
});

test("malformed JSON output falls back to the evaluator model", async (t) => {
  const responses = [
    { model: "short-model", content: '{"condition":' },
    { model: "evaluator-model", content: '{"condition":"CHOPPY"}' },
  ];
  t.mock.method(globalThis, "fetch", async () => {
    const response = responses.shift();
    return new Response(JSON.stringify({
      model: response.model,
      choices: [{ message: { content: response.content } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const result = await requestAiText({
    model: "short-model",
    messages: [{ role: "user", content: "Analyze" }],
    response_format: { type: "json_object" },
  }, { fallbackModel: "evaluator-model" });

  assert.equal(result.text, '{"condition":"CHOPPY"}');
  assert.equal(result.fallbackFrom, "short-model");
  assert.equal(responses.length, 0);
});

test("technical indicators work without fabricating unavailable volume", () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({
    time: Date.UTC(2026, 0, 1, 0, index * 5),
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: null,
  }));
  const result = calculateTechnicalIndicators(candles);
  assert.ok(result.atr14 > 0);
  assert.ok(Number.isFinite(result.intervalVolatility));
  assert.ok(Number.isFinite(result.rsi14));
  assert.ok(Number.isFinite(result.macd.histogram));
  assert.equal(result.volumeAvailable, false);
  assert.equal(result.volumeRatio, null);
  assert.equal(result.volumeSignal, "unavailable");
});

test("DOGE-scale ATR retains enough precision for terminal probability", () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({
    time: Date.UTC(2026, 0, 1, 0, index * 5),
    open: 0.2 + index * 0.0001,
    high: 0.201 + index * 0.0001,
    low: 0.199 + index * 0.0001,
    close: 0.2001 + index * 0.0001,
    volume: null,
  }));
  const result = calculateTechnicalIndicators(candles);
  assert.ok(result.atr14 > 0);
  assert.ok(result.atr14 < 0.01);
});

test("stale, missing-book, and overprice blockers neutralize short trades but retain forecast lean", () => {
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);
  const input = {
    currentPrice: 101,
    priceToBeat: 100,
    oraclePublishTime: new Date(nowMs - 1_000).toISOString(),
    oracleSourceVerified: true,
    startTimeMs: nowMs - 200_000,
    endTimeMs: nowMs + 100_000,
    nowMs,
    atr: 1,
    atrIntervalMs: 300_000,
    upAsk: 0.6,
    downAsk: 0.3,
    maxPrice: 0.7,
    feeBufferCents: 4,
    minSecondsToClose: 30,
  };
  const valid = evaluateDeterministicShortSnapshot(input);
  assert.equal(valid.recommendation, "PLAY");
  assert.equal(valid.direction, "UP");

  const stale = evaluateDeterministicShortSnapshot({
    ...input,
    oraclePublishTime: new Date(nowMs - 16_000).toISOString(),
  });
  assert.equal(stale.recommendation, "AVOID");
  assert.equal(stale.direction, "NEUTRAL");
  assert.equal(stale.forecast_direction, "UP");
  assert.ok(stale.guardrail_blockers.some((blocker) => blocker.includes("stale")));

  const missingDownBook = evaluateDeterministicShortSnapshot({
    ...input,
    currentPrice: 99,
    upAsk: 0.3,
    downAsk: null,
  });
  assert.equal(missingDownBook.direction, "NEUTRAL");
  assert.equal(missingDownBook.forecast_direction, "DOWN");
  assert.ok(missingDownBook.guardrail_blockers.some((blocker) => blocker.includes("DOWN ask")));

  const overpriced = evaluateDeterministicShortSnapshot({ ...input, upAsk: 0.8 });
  assert.equal(overpriced.direction, "NEUTRAL");
  assert.equal(overpriced.forecast_direction, "UP");
  assert.ok(overpriced.guardrail_blockers.some((blocker) => blocker.includes("MAX ENTRY")));

  const closed = evaluateDeterministicShortSnapshot({ ...input, marketClosed: true });
  assert.equal(closed.direction, "NEUTRAL");
  assert.ok(closed.guardrail_blockers.some((blocker) => blocker.includes("MARKET GUARDRAIL")));
});

test("PLAY statistics include all strategies but exclude non-actionable, neutral, and unresolved records", () => {
  const events = [
    { strategy_version: ANALYSIS_STRATEGY_VERSION, actionable: 1, status: "selesai", result: "menang" },
    { strategy_version: ANALYSIS_STRATEGY_VERSION, actionable: 1, status: "selesai", result: "kalah" },
    { strategy_version: ANALYSIS_STRATEGY_VERSION, actionable: 0, status: "selesai", result: "menang" },
    { strategy_version: ANALYSIS_STRATEGY_VERSION, actionable: 1, status: "selesai", result: "netral" },
    { strategy_version: ANALYSIS_STRATEGY_VERSION, actionable: 1, status: "belum selesai", result: "menang" },
    { strategy_version: "old", actionable: 1, status: "selesai", result: "menang" },
  ];
  assert.deepEqual(summarizePlayStats(events), {
    sampleSize: 3,
    wins: 2,
    losses: 1,
    winRate: 66.7,
  });
});

test("flat candles produce neutral RSI and MACD", () => {
  const candles = Array.from({ length: 40 }, (_, index) => ({
    time: Date.UTC(2026, 0, 1, 0, index * 5),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: null,
  }));
  const result = calculateTechnicalIndicators(candles);
  assert.equal(result.rsi14, 50);
  assert.equal(result.rsiSignal, "NEUTRAL");
  assert.equal(result.macd.histogram, 0);
  assert.equal(result.macd.trend, "NEUTRAL");
});
