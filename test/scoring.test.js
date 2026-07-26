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

  it("rejects crossed and out-of-range orderbook prices", () => {
    const market = {
      question: "Will the market be valid?",
      description: "Detailed rules. ".repeat(20),
      endDate: "2026-12-31T00:00:00Z",
      clobTokenIds: ["yes", "no"],
      liquidity: 10000,
      outcomePrices: [0.5, 0.5],
      closed: false,
      acceptingOrders: true,
      active: true,
    };

    const crossed = scoreMarket({
      market,
      yesBook: {
        bids: [{ price: "0.60", size: "10" }, { price: "1.2", size: "1000" }],
        asks: [{ price: "0.55", size: "10" }, { price: "-0.1", size: "1000" }],
      },
    });

    assert.equal(crossed.hasTwoSidedBook, false);
    assert.equal(crossed.verdict, "SKIP");
    assert.ok(crossed.blockers.includes("Orderbook is not two-sided"));
    assert.equal(crossed.totalBidVolume, 6);
    assert.equal(crossed.totalAskVolume, 5.5);
  });
});
