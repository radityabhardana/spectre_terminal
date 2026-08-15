import assert from "node:assert/strict";
import test from "node:test";

import { getMarketById, getOrderBook } from "../src/polymarket.js";
import { fetchChainlinkTechData } from "../src/short_condition.js";
import { buildResearchContext } from "../src/research.js";

test("aborted Polymarket requests stop before network access", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error("network should not be reached");
  };
  const controller = new AbortController();
  controller.abort();
  try {
    for (const request of [
      () => getMarketById("123", true, controller.signal),
      () => getOrderBook("token", controller.signal),
      () => fetchChainlinkTechData("BTC", "5m", controller.signal),
      () => buildResearchContext({ market: { question: "Bitcoin" }, signal: controller.signal }),
    ]) {
      await assert.rejects(request, (error) => error?.name === "AbortError");
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
