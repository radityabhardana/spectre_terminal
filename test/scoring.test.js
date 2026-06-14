import { describe, it } from "node:test";
import assert from "node:assert";
import { scoreMarket } from "../src/scoring.js";

describe("scoring.js", () => {
  it("should score a basic market correctly", () => {
    const market = {
      id: "1",
      question: "Will Bitcoin hit 100k?",
      description: "This is a detailed description of the rules...".repeat(5),
      endDate: "2026-12-31T00:00:00Z",
      clobTokenIds: ["yes-token", "no-token"],
      liquidity: 10000,
      outcomePrices: ["0.45", "0.55"],
      closed: false,
      acceptingOrders: true,
      active: true,
    };

    const yesBook = {
      bids: [{ price: "0.44" }],
      asks: [{ price: "0.46" }],
    };

    const result = scoreMarket({ market, yesBook });

    assert.strictEqual(result.hasTwoSidedBook, true);
    assert.strictEqual(result.bestBid, 0.44);
    assert.strictEqual(result.bestAsk, 0.46);
    assert.strictEqual(result.marketProbability, 45); // (0.44 + 0.46)/2 = 0.45 * 100
    assert.strictEqual(result.spreadRisk, "Low");
  });

  it("should mark skip if closed or missing two sided book", () => {
    const market = {
      id: "2",
      question: "Will test fail?",
      description: "Test.",
      endDate: null,
      clobTokenIds: ["yes-token"],
      liquidity: 0,
      outcomePrices: ["0.5"],
      closed: true,
      acceptingOrders: false,
      active: false,
    };

    const yesBook = {
      bids: [],
      asks: [],
    };

    const result = scoreMarket({ market, yesBook });
    assert.strictEqual(result.hasTwoSidedBook, false);
    assert.strictEqual(result.verdict, "SKIP");
    assert.ok(result.blockers.includes("Market closed"));
    assert.ok(result.blockers.includes("Orderbook is not two-sided"));
  });
});
