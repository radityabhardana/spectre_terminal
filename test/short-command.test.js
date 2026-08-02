import test from "node:test";
import assert from "node:assert/strict";

test("manual short analysis accepts only one fixed-window crypto Up or Down market", async () => {
  const indexModule = await import("../src/index.js");
  const requireShortAnalysisMarket = indexModule.requireShortAnalysisMarket;

  assert.equal(typeof requireShortAnalysisMarket, "function");
  assert.throws(
    () => requireShortAnalysisMarket({ kind: "market", market: { question: "Will Team A win?" } }),
    /fixed-window crypto Up or Down/i,
  );
  assert.throws(
    () => requireShortAnalysisMarket({ kind: "event", markets: [{ question: "Bitcoin Up or Down" }] }),
    /single short market/i,
  );
  assert.throws(
    () => requireShortAnalysisMarket({ kind: "market", market: { question: "Bitcoin Up or Down" } }),
    /duration metadata/i,
  );
  assert.equal(
    requireShortAnalysisMarket({ kind: "market", market: { id: "btc-5m", question: "Bitcoin Up or Down", durationType: "5m" } }).id,
    "btc-5m",
  );
});
