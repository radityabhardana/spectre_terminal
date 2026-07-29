import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateTradeFill,
  deriveSnifferHealth,
  evaluateGeneralTrade,
  extractLivePriceUpdates,
  getSnifferState,
  getSnifferWsStatus,
} from "../src/sniffer.js";

test("importing the sniffer does not report it active", () => {
  assert.equal(getSnifferState(), false);
  assert.equal(getSnifferWsStatus().state, "OFFLINE");
});

test("general trade filter rejects extreme prices and markets near expiry", () => {
  const now = Date.UTC(2026, 6, 28, 12, 0, 0);
  assert.deepEqual(evaluateGeneralTrade({ price: 0.10, endDate: now + 120000, now }), {
    accepted: false,
    reason: "price",
  });
  assert.deepEqual(evaluateGeneralTrade({ price: 0.90, endDate: now + 120000, now }), {
    accepted: false,
    reason: "price",
  });
  assert.deepEqual(evaluateGeneralTrade({ price: 0.5, endDate: now + 59999, now }), {
    accepted: false,
    reason: "expiry",
  });
  assert.deepEqual(evaluateGeneralTrade({ price: 0.5, endDate: now + 60000, now }), {
    accepted: true,
    reason: null,
  });
});

test("split fills cross the threshold once within a rolling window", () => {
  const aggregations = new Map();
  const fill = { market: "market-1", outcome: "UP", side: "BUY", price: 0.5, transactionHash: "0xtrade" };
  const first = aggregateTradeFill(aggregations, { ...fill, fillId: "fill-1", sizeUsdc: 600 }, {
    now: 4999,
    windowMs: 5000,
    minUsd: 1000,
  });
  const second = aggregateTradeFill(aggregations, { ...fill, fillId: "fill-2", sizeUsdc: 500 }, {
    now: 5001,
    windowMs: 5000,
    minUsd: 1000,
  });
  const tail = aggregateTradeFill(aggregations, { ...fill, fillId: "fill-3", sizeUsdc: 50 }, {
    now: 5002,
    windowMs: 5000,
    minUsd: 1000,
  });

  assert.equal(first.status, "belowThreshold");
  assert.equal(second.status, "emitted");
  assert.equal(second.aggregation.sizeUsdc, 1100);
  assert.equal(second.aggregation.fillCount, 2);
  assert.equal(tail.status, "updated");
  assert.equal(tail.aggregation.sizeUsdc, 1150);
  assert.equal(tail.aggregation.deltaSizeUsdc, 50);

  const replay = aggregateTradeFill(aggregations, { ...fill, fillId: "fill-3", sizeUsdc: 50 }, {
    now: 5003,
    windowMs: 5000,
    minUsd: 1000,
  });
  assert.equal(replay.status, "duplicateSuppressed");
});

test("nested price_change updates are extracted", () => {
  assert.deepEqual(extractLivePriceUpdates({
    event_type: "price_change",
    price_changes: [
      { asset_id: "token-a", best_bid: "0.41", best_ask: "0.43" },
      { asset_id: "token-b", best_bid: 0.57, best_ask: 0.59 },
    ],
  }), [
    { assetId: "token-a", price: 0.42 },
    { assetId: "token-b", price: 0.58 },
  ]);
});

test("last trade updates the tracked token price", () => {
  assert.deepEqual(extractLivePriceUpdates({
    event_type: "last_trade_price",
    asset_id: "token-a",
    price: "0.54",
  }), [{ assetId: "token-a", price: 0.54 }]);
});

test("trade aggregation does not combine different transaction hashes", () => {
  const aggregations = new Map();
  const base = { market: "market-1", outcome: "UP", side: "BUY", price: 0.5 };
  const first = aggregateTradeFill(aggregations, { ...base, transactionHash: "0xa", sizeUsdc: 600 }, {
    now: 1000,
    windowMs: 5000,
    minUsd: 1000,
  });
  const second = aggregateTradeFill(aggregations, { ...base, transactionHash: "0xb", sizeUsdc: 600 }, {
    now: 1001,
    windowMs: 5000,
    minUsd: 1000,
  });
  assert.equal(first.status, "belowThreshold");
  assert.equal(second.status, "belowThreshold");
});

test("sniffer health is connected only with complete recent coverage", () => {
  const now = 100000;
  const base = {
    active: true,
    expectedShards: 2,
    expectedTokens: 20,
    reconnectCount: 1,
    errorCount: 2,
    shards: [
      { id: 1, state: "OPEN", expectedTokens: 10, subscribedTokens: 10, lastPongAt: now - 1000 },
      { id: 2, state: "OPEN", expectedTokens: 10, subscribedTokens: 10, lastMessageAt: now - 2000 },
    ],
  };
  const connected = deriveSnifferHealth(base, now, 35000);
  assert.equal(connected.state, "CONNECTED");
  assert.equal(connected.connectedShards, 2);
  assert.equal(connected.subscribedTokens, 20);
  assert.doesNotThrow(() => JSON.stringify(connected));

  const stale = deriveSnifferHealth({
    ...base,
    shards: [base.shards[0], { ...base.shards[1], lastMessageAt: now - 36000 }],
  }, now, 35000);
  assert.equal(stale.state, "DEGRADED");
  assert.equal(stale.staleShards, 1);

  assert.equal(deriveSnifferHealth({ ...base, active: false }, now).state, "OFFLINE");
});

test("sniffer health distinguishes initial connection from reconnect", () => {
  assert.equal(deriveSnifferHealth({
    active: true,
    isConnecting: true,
    expectedShards: 1,
    expectedTokens: 10,
    shards: [{ id: 1, state: "CONNECTING", expectedTokens: 10, subscribedTokens: 0 }],
  }).state, "CONNECTING");
  assert.equal(deriveSnifferHealth({
    active: true,
    expectedShards: 1,
    expectedTokens: 10,
    shards: [{ id: 1, state: "RECONNECTING", expectedTokens: 10, subscribedTokens: 0 }],
  }).state, "RECONNECTING");
});
