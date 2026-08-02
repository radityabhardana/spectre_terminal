import test from "node:test";
import assert from "node:assert/strict";

import { assertMarketAllowed, isBlockedUfcMarket } from "../src/market-policy.js";

test("blocks explicit UFC evidence across normalized market fields", () => {
  const cases = [
    { question: "Will Jones win at UFC 321?" },
    { title: "Ultimate Fighting Championship main event winner" },
    { eventTitle: "UFC: Saturday Fight Night" },
    { slug: "ufc-321-main-event" },
    { eventSlug: "sports-ufc-321" },
    { url: "https://polymarket.com/event/ufc-321?ref=sports" },
    { seriesSlug: "ufc-fight-night" },
    { sportsMarketType: "ufc_moneyline" },
    { resolutionSource: "https://ufc.com/event/321" },
    { resolutionSource: "https://stats.ufc.com/fight-details/123" },
    { tags: [{ label: " UFC " }] },
    { tags: [{ slug: "ufc" }] },
    { series: [{ slug: "sports-ufc" }] },
    { series: { ticker: "UFC" } },
    { series: { title: "Ultimate Fighting Championship" } },
  ];

  for (const market of cases) {
    assert.equal(isBlockedUfcMarket(market), true, JSON.stringify(market));
  }
});

test("blocks UFC evidence in a separate event and embedded raw event metadata", () => {
  const cases = [
    [{ question: "Who wins?" }, { title: "UFC 321" }],
    [{ raw: { event: { tags: [{ label: "UFC" }] } } }],
    [{ raw: { events: [{ series: [{ ticker: "UFC" }] }] } }],
    [{ raw: { tags: [{ slug: "ufc" }] } }],
    [{ raw: { series: { title: "Ultimate Fighting Championship" } } }],
    [{ raw: { raw: { event: { eventSlug: "ufc-embedded" } } } }],
  ];

  for (const [market, event] of cases) {
    assert.equal(isBlockedUfcMarket(market, event), true, JSON.stringify({ market, event }));
  }
});

test("traverses top-level arrays and nested markets arrays", () => {
  assert.equal(isBlockedUfcMarket([
    { question: "MMA championship winner" },
    { question: "UFC 321 winner" },
  ]), true);
  assert.equal(isBlockedUfcMarket({
    markets: [{ question: "Boxing winner" }, { description: "Ultimate Fighting Championship event" }],
  }), true);
});

test("terminates on cyclic graphs and finds reachable UFC evidence", () => {
  const selfReferential = [];
  selfReferential.push(selfReferential, { description: "UFC event winner" });
  assert.equal(isBlockedUfcMarket(selfReferential), true);

  const allowedCycle = { description: "Generic MMA and combat sports" };
  allowedCycle.markets = [allowedCycle];
  assert.equal(isBlockedUfcMarket(allowedCycle), false);

  const first = {};
  const second = {};
  first.markets = [second];
  second.events = [first, { eventTitle: "UFC Fight Night" }];
  assert.equal(isBlockedUfcMarket(first), true);
});

test("supports persisted and alert field aliases", () => {
  assert.equal(isBlockedUfcMarket({ market_question: "UFC 321 winner" }), true);
  assert.equal(isBlockedUfcMarket({ market_slug: "ufc-321-winner" }), true);
});

test("blocks explicit UFC evidence in descriptions without broad combat matching", () => {
  assert.equal(isBlockedUfcMarket({ description: "Official UFC rules apply" }), true);
  assert.equal(isBlockedUfcMarket({ raw: { description: "Ultimate Fighting Championship event" } }), true);
  assert.equal(isBlockedUfcMarket({ description: "MMA combat championship decided by submission" }), false);
  assert.equal(isBlockedUfcMarket({ description: "A notufc token is not evidence" }), false);
});

test("blocks full-name slugs and encoded UFC URL paths", () => {
  const cases = [
    { slug: "ultimate-fighting-championship-321" },
    { eventSlug: "sports-ultimate-fighting-championship-main-event" },
    { url: "https://polymarket.com/event/ultimate-fighting-championship-321" },
    { url: "https://polymarket.com/event/%55%46%43-321" },
    { url: "https://polymarket.com/event/ultimate%2Dfighting%2Dchampionship-321" },
  ];

  for (const market of cases) {
    assert.equal(isBlockedUfcMarket(market), true, JSON.stringify(market));
  }
});

test("decodes URL paths segment by segment and decodes urlPath", () => {
  const cases = [
    { url: "https://polymarket.com/event/bad%ZZ/%55%46%43-321" },
    { url: "https://polymarket.com/event/%E0%A4%A/%55%46%43-321" },
    { urlPath: "/event/bad%ZZ/%55%46%43-321" },
    { urlPath: "/event/ultimate%2Dfighting%2Dchampionship-321" },
  ];

  for (const market of cases) {
    assert.equal(isBlockedUfcMarket(market), true, JSON.stringify(market));
  }
});

test("blocks double-encoded UFC URL and urlPath segments", () => {
  assert.equal(isBlockedUfcMarket({
    url: "https://polymarket.com/event/%2555%2546%2543-321",
  }), true);
  assert.equal(isBlockedUfcMarket({
    urlPath: "/event/%2555%2546%2543-321",
  }), true);
});

test("recognizes flexible full-name text and hyphenated series values", () => {
  const cases = [
    { description: "Official Ultimate   Fighting\nChampionship event" },
    { title: "Ultimate\tFighting  Championship winner" },
    { seriesSlug: "ultimate-fighting-championship-events" },
    { series: "ultimate-fighting-championship" },
    { series: { seriesSlug: "ultimate-fighting-championship-main" } },
  ];

  for (const market of cases) {
    assert.equal(isBlockedUfcMarket(market), true, JSON.stringify(market));
  }
});

test("checks root ticker with token-safe slug matching", () => {
  assert.equal(isBlockedUfcMarket({ ticker: "sports-ufc-321" }), true);
  assert.equal(isBlockedUfcMarket({ ticker: "notufc" }), false);
  assert.equal(isBlockedUfcMarket({ ticker: "UFCX" }), false);
});

test("blocks token-safe UFC categories on markets and parent events", () => {
  const blocked = [
    [{ category: "UFC" }],
    [{ category: "Sports / UFC" }],
    [{ category: { label: "UFC" } }],
    [{ category: { slug: "combat-ufc-events" } }],
    [{ question: "Who wins?" }, { category: "UFC Markets" }],
  ];

  for (const [market, event] of blocked) {
    assert.equal(isBlockedUfcMarket(market, event), true, JSON.stringify({ market, event }));
  }
});

test("retains MMA and non-token UFC category names", () => {
  const allowed = [
    { category: "MMA" },
    { category: "Combat Sports" },
    { category: "UFCX" },
    { category: "notufc" },
    { category: { label: "MMA", slug: "mixed-martial-arts" } },
  ];

  for (const market of allowed) {
    assert.equal(isBlockedUfcMarket(market), false, JSON.stringify(market));
  }
});

test("does not infer UFC from malformed URLs or spoofed resolution hostnames", () => {
  assert.equal(isBlockedUfcMarket({ url: "http://[::1/event/ufc-321" }), false);
  assert.equal(isBlockedUfcMarket({
    url: "http://[::1/event/ufc-321",
    question: "UFC 321 winner",
  }), true);
  assert.equal(isBlockedUfcMarket({ resolutionSource: "https://ufc.com@evil.example/rules" }), false);
  assert.equal(isBlockedUfcMarket({ resolutionSource: "https://ufc.com.evil/rules" }), false);
});

test("does not infer UFC from generic combat language or larger tokens", () => {
  const allowed = [
    { question: "Will the MMA fighter win by KO/TKO or submission in this championship bout?", tags: [{ label: "Sports" }] },
    { question: "Who wins the boxing championship fight?" },
    { title: "Street Fighter tournament winner" },
    { eventTitle: "Will new fighter jets enter service?" },
    { question: "Will NUFC win the league?" },
    { question: "Will UFC123 shares rise?" },
    { slug: "notufc-market" },
    { eventSlug: "ufchampion-event" },
    { sportsMarketType: "notufc_moneyline" },
    { seriesSlug: "superufcseries" },
    { series: { ticker: "UFCX", title: "Ultimate fighter championship" } },
    { tags: [{ label: "MMA" }, { slug: "sports" }] },
    { url: "https://notufc.com/event/boxing-championship" },
    { url: "https://polymarket.com/event/notufc-market?league=ufc" },
    { resolutionSource: "https://notufc.com/rules" },
    { resolutionSource: "https://ufc.com.evil.example/rules" },
    { description: "This generic MMA description has combat but no promotion evidence." },
    { metadata: { title: "UFC 321" } },
    { raw: { description: "A boxing title fight appears only in a raw description." } },
  ];

  for (const market of allowed) {
    assert.equal(isBlockedUfcMarket(market), false, JSON.stringify(market));
  }
});

test("handles absent and malformed input without blocking", () => {
  for (const market of [null, undefined, "UFC", 321, {}, { tags: null }, { raw: "not json" }]) {
    assert.equal(isBlockedUfcMarket(market), false, String(market));
  }
});

test("assertMarketAllowed throws the unsupported UFC error contract", () => {
  assert.throws(
    () => assertMarketAllowed({ question: "UFC 321 winner" }),
    (error) => {
      assert.equal(error instanceof Error, true);
      assert.equal(error.code, "UNSUPPORTED_UFC");
      assert.equal(error.status, 422);
      return true;
    },
  );

  assert.doesNotThrow(() => assertMarketAllowed({ question: "MMA championship winner" }));
});

test("assertMarketAllowed returns the allowed market and checks the separate event", () => {
  const market = { question: "MMA championship winner" };
  assert.equal(assertMarketAllowed(market), market);
  assert.throws(
    () => assertMarketAllowed(market, { description: "Official UFC event" }),
    { code: "UNSUPPORTED_UFC", status: 422 },
  );
});
