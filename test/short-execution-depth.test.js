import test from "node:test";
import assert from "node:assert/strict";

import { calculateExecutableOrderBook } from "../src/index.js";
import { selectShortMarketSide } from "../src/short_condition.js";

function closeTo(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

function book(overrides = {}) {
  return {
    asset_id: "up-token",
    bids: [{ price: "0.35", size: "20" }],
    asks: [
      { price: "0.40", size: "5" },
      { price: "0.50", size: "10" },
    ],
    ...overrides,
  };
}

test("calculates buy-side VWAP across multiple ask levels", () => {
  const execution = calculateExecutableOrderBook(book(), 6);

  assert.equal(execution.valid, true);
  assert.equal(execution.bestAsk, 0.4);
  assert.equal(execution.bestBid, 0.35);
  assert.equal(execution.targetNotional, 6);
  assert.equal(execution.availableAskDepth, 15);
  assert.equal(execution.availableAskNotional, 7);
  closeTo(execution.filledAskDepth, 13);
  closeTo(execution.filledAskNotional, 6);
  closeTo(execution.vwapAsk, 6 / 13);
  closeTo(execution.slippageFromBestAsk, 6 / 13 - 0.4);
});

test("rejects insufficient ask depth for the target notional", () => {
  const execution = calculateExecutableOrderBook(book(), 8);

  assert.equal(execution.valid, false);
  assert.equal(execution.reason, "INSUFFICIENT_ASK_DEPTH");
  assert.equal(execution.vwapAsk, null);
  assert.equal(execution.filledAskNotional, 7);
});

test("rejects crossed and malformed books", () => {
  const crossed = calculateExecutableOrderBook(book({
    bids: [{ price: "0.51", size: "20" }],
  }), 5);
  assert.equal(crossed.valid, false);
  assert.equal(crossed.reason, "CROSSED_BOOK");

  const malformed = calculateExecutableOrderBook(book({
    asks: [{ price: "0.40", size: "not-a-number" }],
  }), 5);
  assert.equal(malformed.valid, false);
  assert.equal(malformed.reason, "ASK_BOOK_LEVEL_INVALID");
});

test("short EV uses executable VWAP instead of top ask", () => {
  const execution = calculateExecutableOrderBook(book(), 6);
  const selection = selectShortMarketSide({
    upProbability: 70,
    upAsk: execution.vwapAsk,
    downAsk: null,
  });

  assert.equal(selection.selected.ask, execution.vwapAsk);
  closeTo(selection.selected.netEvCents, 70 - execution.vwapAsk * 100 - 4);
  assert.ok(selection.selected.ask > execution.bestAsk);
});
