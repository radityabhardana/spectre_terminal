import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  appendShortEvaluationSnapshot, auditPayloadHash, canonicalAuditPayload, getShortEvaluationSnapshots,
} from "../src/storage.js";
import { evaluateShortMarketCondition, shortEvaluationAiAvailability } from "../src/short_condition.js";

function candlePage() {
  const intervalMs = 5 * 60 * 1000; const now = Date.now();
  return Array.from({ length: 40 }, (_, index) => { const close = 100 + index * 0.1; return { time: Math.floor((now - (40 - index) * intervalMs) / 1000), open: close - 0.05, high: close + 0.1, low: close - 0.1, close }; });
}

test("short evaluation snapshots are hashed, append-only, and immutable", (t) => {
  const errors = []; t.mock.method(console, "error", (...args) => errors.push(args));
  const payload = { z: 3, a: { second: true, first: "value" } };
  const id = appendShortEvaluationSnapshot({ marketId: "audit-test-market", marketQuestion: "Audit test", durationType: "5m", asset: "BTC", capturedAt: "2026-08-24T00:00:00.000Z", createdAt: "2026-08-24T00:00:01.000Z", auditPayload: payload });
  assert.ok(id > 0);
  const rows = getShortEvaluationSnapshots({ marketId: "audit-test-market" });
  assert.deepEqual(rows[0].payload, payload);
  assert.equal(rows[0].audit_payload_hash, auditPayloadHash(canonicalAuditPayload(payload)));
  assert.equal(rows[0].audit_payload_hash, createHash("sha256").update(canonicalAuditPayload(payload)).digest("hex"));
  assert.equal(appendShortEvaluationSnapshot({ capturedAt: "2026-08-24T00:00:02.000Z", auditPayload: null }), null);
  assert.equal(errors.length, 1);
});

test("5m and 15m evaluations audit without changing response shape or fabricating availability", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ candles: candlePage() }), { status: 200, headers: { "content-type": "application/json" } }));
  for (const item of [
    { asset: "BTC", durationType: "5m", marketId: "audit-5m-market", question: "BTC audit 5m Up or Down" },
    { asset: "ETH", durationType: "15m", marketId: "audit-15m-market", question: "ETH audit 15m Up or Down" },
  ]) {
    const response = await evaluateShortMarketCondition({ marketId: item.marketId, asset: item.asset, marketQuestion: item.question, durationType: item.durationType, upTokenAsk: 0.55, downTokenAsk: 0.45, upTokenMidpoint: 0.54, downTokenMidpoint: 0.44, resolutionSource: "", includeAiExplanation: false, refreshFinalSnapshot: false });
    assert.deepEqual(Object.keys(response).sort(), ["aiExplanationError", "aiExplanationStatus", "depth", "deterministicSnapshot", "durationType", "endDate", "evaluation", "fearGreed", "fallbackFrom", "liquidations", "longShort", "oraclePrice", "oraclePublishTime", "oracleSourceVerified", "providerModel", "startDate", "targetPrice", "techData", "tickerData", "usage"].sort());
    const rows = getShortEvaluationSnapshots({ marketQuestion: item.question });
    assert.equal(rows.length, 1); assert.equal(rows[0].market_id, item.marketId); assert.equal(rows[0].duration_type, item.durationType);
    assert.equal(rows[0].payload.final.deterministic.rawAsk.up, 0.55); assert.equal(rows[0].payload.final.deterministic.rawMidpoint.down, 0.44);
    assert.equal(rows[0].payload.market.id, item.marketId); assert.equal(rows[0].payload.providerDataAvailability.polymarketClob.available, true);
    assert.equal(rows[0].payload.providerDataAvailability.polymarketClob.rawBookAvailable, false); assert.equal(rows[0].payload.providerDataAvailability.chainlink.available, false); assert.equal(rows[0].payload.providerDataAvailability.aiExplanation.requested, false);
    assert.deepEqual(rows[0].payload.providerDataAvailability.aiExplanation, { requested: false, available: false, used: false, status: "not_requested" });
  }
  await evaluateShortMarketCondition({ marketId: "audit-ineligible-market", asset: "BTC", marketQuestion: "BTC audit ineligible", durationType: "5m", upTokenAsk: 0.55, downTokenAsk: 0.45, resolutionSource: "", includeAiExplanation: true, refreshFinalSnapshot: false });
  const ineligible = getShortEvaluationSnapshots({ marketId: "audit-ineligible-market" });
  assert.deepEqual(ineligible[0].payload.providerDataAvailability.aiExplanation, { requested: false, available: false, used: false, status: "not_requested" });
});

test("AI audit availability distinguishes request, valid response, and used explanation", () => {
  assert.deepEqual(shortEvaluationAiAvailability(), {
    requested: false, available: false, used: false, status: "not_requested",
  });
  assert.deepEqual(shortEvaluationAiAvailability({ requestStarted: false, status: "not_requested" }), {
    requested: false, available: false, used: false, status: "not_requested",
  });
  assert.deepEqual(shortEvaluationAiAvailability({
    requestStarted: true,
    response: { reason: "deterministic explanation" },
    used: true,
    status: "used",
  }), {
    requested: true, available: true, used: true, status: "used",
  });
  assert.deepEqual(shortEvaluationAiAvailability({
    requestStarted: true,
    response: { reason: "late explanation" },
    used: false,
    status: "discarded_stale",
  }), {
    requested: true, available: true, used: false, status: "discarded_stale",
  });
});
