import test from "node:test";
import assert from "node:assert/strict";

import { classifyMarketRegime, normalizeMarketPulseConfig } from "../src/market-pulse.js";

function candlesFromCloses(closes, { volume = 100, range = 0.6 } = {}) {
  return closes.map((close, index) => ({
    time: Date.UTC(2026, 0, 1, 0, index),
    open: index ? closes[index - 1] : close,
    high: close + range,
    low: close - range,
    close,
    volume: typeof volume === "function" ? volume(index) : volume,
  }));
}

test("market pulse detects a directional uptrend", () => {
  const closes = Array.from({ length: 90 }, (_, index) => 100 + index * 0.7 + Math.sin(index) * 0.08);
  const result = classifyMarketRegime(candlesFromCloses(closes), { asset: "BTC", timeframe: "5m" });
  assert.equal(result.regime.key, "TRENDING_UP");
  assert.equal(result.regime.direction, "UP");
  assert.ok(result.metrics.adx >= 24);
});

test("market pulse detects a choppy range", () => {
  const closes = Array.from({ length: 90 }, (_, index) => 100 + Math.sin(index * 1.9) * 1.4);
  const result = classifyMarketRegime(candlesFromCloses(closes, { range: 0.8 }), { asset: "ETH", timeframe: "15m" });
  assert.equal(result.regime.key, "CHOPPY_RANGE");
  assert.equal(result.regime.direction, "NEUTRAL");
});

test("market pulse detects a volume-backed breakout", () => {
  const closes = Array.from({ length: 90 }, (_, index) => index === 89 ? 106 : 100 + Math.sin(index) * 0.5);
  const result = classifyMarketRegime(candlesFromCloses(closes, { volume: (index) => index === 89 ? 260 : 100 }), { asset: "BTC", timeframe: "1m" });
  assert.equal(result.regime.key, "BREAKOUT");
  assert.ok(result.modifiers.includes("VOLUME SPIKE"));
});

test("market pulse detects volatility compression", () => {
  const closes = Array.from({ length: 90 }, (_, index) => index < 55
    ? 100 + Math.sin(index * 0.8) * 3
    : 100 + Math.sin(index * 0.8) * 0.04);
  const ranges = closes.map((close, index) => ({
    time: Date.UTC(2026, 0, 1, 0, index),
    open: index ? closes[index - 1] : close,
    high: close + (index < 55 ? 1 : 0.03),
    low: close - (index < 55 ? 1 : 0.03),
    close,
    volume: 100,
  }));
  const result = classifyMarketRegime(ranges, { asset: "BTC", timeframe: "5m" });
  assert.equal(result.regime.key, "LOW_VOL_SQUEEZE");
});

test("market pulse normalizes unsupported monitor settings", () => {
  assert.deepEqual(normalizeMarketPulseConfig({ asset: "SOL", timeframe: "2m", refreshSeconds: 2 }), {
    asset: "BTC",
    timeframe: "5m",
    refreshSeconds: 30,
  });
});
