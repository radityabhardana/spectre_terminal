import assert from "node:assert/strict";
import test from "node:test";
import { pickShortUpDownTokens } from "../src/polymarket.js";
import { scoreOneMarket } from "../src/index.js";

function shortMarket(overrides = {}) {
  return {
    id: "short-map-1",
    conditionId: "condition-short-map-1",
    question: "Bitcoin Up or Down",
    description: "A fixed-window crypto market with explicit Up and Down outcomes.",
    outcomes: ["Up", "Down"],
    outcomePrices: ["0.52", "0.48"],
    clobTokenIds: ["up-token", "down-token"],
    durationType: "5m",
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    liquidity: 1000,
    volume: 1000,
    endDate: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("short token mapping follows exact normalized outcome labels in either order", () => {
  assert.deepEqual(
    pickShortUpDownTokens(shortMarket()),
    {
      yesTokenId: "up-token",
      noTokenId: "down-token",
      yesPrice: "0.52",
      noPrice: "0.48",
      yesLabel: "Up",
      noLabel: "Down",
      yesIndex: 0,
      noIndex: 1,
    },
  );
  assert.deepEqual(
    pickShortUpDownTokens(shortMarket({
      outcomes: ["Down", "Up"],
      outcomePrices: ["0.48", "0.52"],
      clobTokenIds: ["down-token", "up-token"],
    })),
    {
      yesTokenId: "up-token",
      noTokenId: "down-token",
      yesPrice: "0.52",
      noPrice: "0.48",
      yesLabel: "Up",
      noLabel: "Down",
      yesIndex: 1,
      noIndex: 0,
    },
  );
});

test("short mapping rejects duplicate, missing, mismatched, and malformed token arrays", async (t) => {
  const invalidMarkets = [
    shortMarket({ outcomes: ["Up", "UP"], clobTokenIds: ["up-a", "up-b"] }),
    shortMarket({ outcomes: ["Up", "Other"], clobTokenIds: ["up-token", "other-token"] }),
    shortMarket({ outcomes: ["Up", "Down"], clobTokenIds: ["up-token"] }),
    shortMarket({ outcomes: ["Up", "Down"], clobTokenIds: ["up-token", 42] }),
    shortMarket({ outcomes: "not-json", clobTokenIds: "not-json" }),
  ];

  for (const market of invalidMarkets) {
    assert.throws(
      () => pickShortUpDownTokens(market),
      (error) => error?.code === "TOKEN_MAPPING_INVALID",
    );
  }

  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ bids: [{ price: "0.4", size: "1" }], asks: [{ price: "0.6", size: "1" }] }));
  });
  await assert.rejects(
    () => scoreOneMarket(invalidMarkets[0]),
    (error) => error?.code === "TOKEN_MAPPING_INVALID",
  );
  assert.equal(calls.length, 0, "invalid short metadata must fail before any CLOB request");
});

test("reversed short outcomes send matching books into shortBookPrices.up and down", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    const tokenId = url.searchParams.get("token_id");
    calls.push(tokenId);
    const prices = tokenId === "up-token"
      ? { bid: "0.21", ask: "0.31" }
      : { bid: "0.71", ask: "0.81" };
    return new Response(JSON.stringify({
      bids: [{ price: prices.bid, size: "10" }],
      asks: [{ price: prices.ask, size: "10" }],
    }));
  });

  const result = await scoreOneMarket(shortMarket({
    outcomes: ["Down", "Up"],
    outcomePrices: ["0.48", "0.52"],
    clobTokenIds: ["down-token", "up-token"],
  }));

  assert.deepEqual(calls.sort(), ["down-token", "up-token"]);
  assert.equal(result.score.primaryOutcomeLabel, "Up");
  assert.equal(result.score.primaryTokenId, "up-token");
  assert.equal(result.score.shortBookPrices.up.bestAsk, 0.31);
  assert.equal(result.score.shortBookPrices.down.bestAsk, 0.81);
  assert.equal(result.score.shortBookPrices.up.midpoint, 0.26);
  assert.equal(result.score.shortBookPrices.down.midpoint, 0.76);
});

test("one-sided reversed short books use the canonical UP Gamma price", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const tokenId = new URL(String(input)).searchParams.get("token_id");
    return new Response(JSON.stringify({
      bids: [{ price: tokenId === "up-token" ? "0.21" : "0.71", size: "10" }],
      asks: [],
    }));
  });

  const result = await scoreOneMarket(shortMarket({
    outcomes: ["Down", "Up"],
    outcomePrices: ["0.48", "0.52"],
    clobTokenIds: ["down-token", "up-token"],
  }));

  assert.equal(result.score.marketProbability, 52);
  assert.equal(result.score.gammaPrimaryPrice, 0.52);
});
