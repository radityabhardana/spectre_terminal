import test from "node:test";
import fs from "node:fs";
import path from "node:path";
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

test("analysis and sniffer command paths await and propagate request state", () => {
  const source = fs.readFileSync(path.resolve("src/index.js"), "utf8");
  assert.match(source, /const scored = await scoreOneMarket\(market, signal\);/);
  assert.match(source, /refreshMarketPrices: \(\) => refreshShortExecutionSnapshot\(scored\.market\.id, scored\.score, signal\)/);
  assert.match(source, /const active = await setSnifferState\(true\);/);
  assert.match(source, /const market = await getMarketById\(arg, true, requestSignal\);/);
  assert.match(source, /const scored = await scoreOneMarket\(market, requestSignal\);/);
  assert.match(source, /return getMarketsFromPolymarketLink\(raw, signal\);/);
  const resolutionSource = fs.readFileSync(path.resolve("src/resolution.js"), "utf8");
  assert.match(resolutionSource, /getMarketById\(event\.market_id, true, signal\)/);
});
