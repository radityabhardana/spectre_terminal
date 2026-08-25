import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import WebSocket from "ws";

const tempDatabaseDir = mkdtempSync(path.join(tmpdir(), "razor-polymarket-policy-"));
process.env.RAZOR_DATABASE_PATH = path.join(tempDatabaseDir, "database.db");

const [, indexModule, polymarketModule] = await Promise.all([
  import("../src/config.js"),
  import("../src/index.js"),
  import("../src/polymarket.js"),
  import("../src/storage.js"),
]);
const { getFastShortEntrySnapshot, handleCommand } = indexModule;
const {
  getEventBySlug,
  getMarketById,
  getMarketBySlug,
  getMarketFromPolymarketLink,
  getMarketsFromPolymarketLink,
  getShortTermMarkets,
  listTopMarkets,
  searchMarkets,
} = polymarketModule;

function trackedCacheUrl(input) {
  return new URL(input);
}

after(() => {
  rmSync(tempDatabaseDir, { recursive: true, force: true });
});

function gammaMarket(overrides = {}) {
  return {
    id: "1001",
    conditionId: "condition-1001",
    question: "Will the boxing champion win?",
    slug: "boxing-champion-win",
    description: "A sanctioned boxing championship bout.",
    outcomes: ["Yes", "No"],
    outcomePrices: ["0.55", "0.45"],
    clobTokenIds: ["yes-token", "no-token"],
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    volume: 500,
    liquidity: 250,
    endDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assertUnsupportedUfc(error) {
  assert.equal(error?.code, "UNSUPPORTED_UFC");
  assert.equal(error?.status, 422);
  return true;
}

function mockShortRefreshNetwork(t, { marketId, refreshOverrides }) {
  const endDate = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const startDate = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const candles = Array.from({ length: 40 }, (_, index) => ({
    time: Math.floor((Date.now() - (80 - index) * 5 * 60 * 1000) / 1000),
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100.5 + index * 0.1,
  }));
  const state = { gammaRequests: 0, clobRequests: 0 };
  const baseMarket = gammaMarket({
    id: marketId,
    question: "Bitcoin Up or Down",
    slug: `bitcoin-updown-5m-${marketId}`,
    category: "Crypto",
    durationType: "5m",
    outcomes: ["Up", "Down"],
    outcomePrices: ["0.51", "0.49"],
    clobTokenIds: ["up-token", "down-token"],
    startDate,
    endDate,
    resolutionSource: "https://data.chain.link/streams/btc-usd",
  });

  const originalOn = WebSocket.prototype.on;
  t.mock.method(WebSocket.prototype, "on", function (event, listener) {
    if (event === "message") {
      queueMicrotask(() => listener(JSON.stringify({
        payload: { value: 104, timestamp: Date.now() },
      })));
      return this;
    }
    if (event === "error") return originalOn.call(this, event, listener);
    return this;
  });
  t.mock.method(WebSocket.prototype, "send", function () {});

  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.hostname === "gamma-api.polymarket.com") {
      state.gammaRequests += 1;
      if (state.gammaRequests > 1 && refreshOverrides === null) return jsonResponse(null);
      return jsonResponse(state.gammaRequests === 1 ? baseMarket : { ...baseMarket, ...refreshOverrides });
    }
    if (url.hostname === "clob.polymarket.com") {
      state.clobRequests += 1;
      return jsonResponse({
        bids: [{ price: "0.49", size: "100" }],
        asks: [{ price: "0.51", size: "100" }],
      });
    }
    if (url.pathname === "/api/crypto/crypto-price") return jsonResponse({ openPrice: 100 });
    if (url.pathname === "/api/chainlink-candles") return jsonResponse({ candles });
    throw new Error(`Unexpected test request: ${url}`);
  });

  return state;
}

test("mixed search omits UFC markets, keeps boxing, and preserves event classification metadata", async (t) => {
  const marker = `policy${process.pid}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    assert.equal(url.pathname, "/public-search");
    return jsonResponse({
      markets: [
        gammaMarket({ id: "1101", question: `${marker} UFC direct market`, tags: [{ label: "UFC" }] }),
        gammaMarket({ id: "1102", question: `${marker} MMA championship`, slug: `${marker}-mma-championship` }),
      ],
      events: [{
        id: "event-11",
        title: `${marker} boxing night`,
        slug: `${marker}-boxing-night`,
        tags: [{ label: "Sports" }],
        category: "Sports",
        seriesSlug: "world-boxing-series",
        series: [{ slug: "world-boxing-series", title: "World Boxing" }],
        sportsMarketType: "boxing_moneyline",
        markets: [
          gammaMarket({ id: "1103", question: `${marker} boxing winner`, slug: `${marker}-boxing-winner` }),
          gammaMarket({ id: "1104", question: `${marker} fight winner`, slug: `${marker}-fight-winner`, sportsMarketType: "ufc_moneyline" }),
        ],
      }],
    });
  });

  const markets = await searchMarkets(`${marker} championship boxing`, 10);

  assert.deepEqual(markets.map((market) => market.id).sort(), ["1102", "1103"]);
  const boxing = markets.find((market) => market.id === "1103");
  assert.deepEqual(boxing.tags, [{ label: "Sports" }]);
  assert.equal(boxing.category, "Sports");
  assert.equal(boxing.seriesSlug, "world-boxing-series");
  assert.deepEqual(boxing.series, [{ slug: "world-boxing-series", title: "World Boxing" }]);
  assert.equal(boxing.sportsMarketType, "boxing_moneyline");
  assert.equal(boxing.raw.id, "1103");
});

test("search applies parent event policy evidence to otherwise generic children", async (t) => {
  const marker = `parentpolicy${process.pid}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    trackedCacheUrl(input);
    return jsonResponse({
      markets: [],
      events: [{
        id: "event-parent-policy",
        title: `${marker} fight night`,
        slug: `${marker}-fight-night`,
        description: "Official UFC event rules apply.",
        markets: [gammaMarket({
          id: "1151",
          question: `${marker} winner`,
          slug: `${marker}-winner`,
          tags: [],
        })],
      }],
    });
  });

  const markets = await searchMarkets(`${marker} winner`, 10);

  assert.deepEqual(markets, []);
});

test("top event collection omits UFC while retaining an allowed sibling", async (t) => {
  const limit = 1000 + (process.pid % 1000);
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    assert.equal(url.pathname, "/events");
    return jsonResponse([{
      title: "Combat sports weekend",
      slug: "combat-sports-weekend",
      markets: [
        gammaMarket({ id: "1201", question: "UFC main event winner" }),
        gammaMarket({ id: "1202", question: "Boxing title fight winner", volume: 400 }),
      ],
    }]);
  });

  const result = await listTopMarkets({ mode: "liquidity", limit });

  assert.deepEqual(result.markets.map((market) => market.id), ["1202"]);
});

test("top collection falls back after blocked event rows and filters fallback market rows", async (t) => {
  const limit = 2000 + (process.pid % 1000);
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname === "/events") {
      return jsonResponse([{
        title: "UFC 400",
        slug: "ufc-400",
        markets: [gammaMarket({ id: "1301", question: "Main event winner" })],
      }]);
    }
    assert.equal(url.pathname, "/markets");
    return jsonResponse([
      gammaMarket({ id: "1302", question: "UFC fallback market" }),
      gammaMarket({ id: "1303", question: "Allowed boxing fallback", volume: 700 }),
    ]);
  });

  const result = await listTopMarkets({ mode: "new", limit });

  assert.deepEqual(result.markets.map((market) => market.id), ["1303"]);
});

test("short-term collection omits UFC markets", async (t) => {
  const asset = `policyshort${process.pid}`;
  const blockedId = `1401${String(process.pid).slice(-5)}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    const events = url.searchParams.get("series_slug")?.endsWith("-5m")
      ? [{ title: "UFC short event", markets: [gammaMarket({ id: blockedId, question: "Fight winner" })] }]
      : [];
    return jsonResponse(events);
  });

  const markets = await getShortTermMarkets(asset);

  assert.deepEqual(markets, []);
});

test("short-term discovery windows by end date and keeps only CLOB-enabled markets", async (t) => {
  const asset = `shortdiscovery${process.pid}`;
  const seenUrls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    seenUrls.push(url);
    const events = url.searchParams.get("series_slug")?.endsWith("-5m")
      ? [
          { markets: [gammaMarket({ id: "stale", endDate: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() })] },
          { markets: [gammaMarket({ id: "current", endDate: new Date(Date.now() + 20 * 60 * 1000).toISOString() })] },
          { markets: [gammaMarket({ id: "no-book", enableOrderBook: false, endDate: new Date(Date.now() + 30 * 60 * 1000).toISOString() })] },
        ]
      : [];
    return jsonResponse(events);
  });

  const markets = await getShortTermMarkets(asset);

  assert.ok(seenUrls.filter((url) => url.pathname === "/events").every((url) => (
    url.searchParams.get("order") === "endDate"
    && url.searchParams.get("ascending") === "true"
    && url.searchParams.get("end_date_min")
    && url.searchParams.get("end_date_max")
  )));
  assert.deepEqual(markets.map((market) => market.id), ["current"]);
});

test("short-term discovery accepts durationTypes and an injected clock", async (t) => {
  const asset = `short15m${process.pid}`;
  const now = Date.parse("2026-08-24T12:00:00.000Z");
  const seenUrls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    seenUrls.push(url);
    return jsonResponse([]);
  });

  const markets = await getShortTermMarkets(asset, {
    durationTypes: ["15m"],
    clock: () => now,
  });

  assert.deepEqual(markets, []);
  assert.deepEqual(seenUrls.map((url) => url.searchParams.get("series_slug")), [`${asset}-up-or-down-15m`]);
  assert.equal(seenUrls[0].searchParams.get("end_date_min"), new Date(now - 60 * 60 * 1000).toISOString());
  assert.equal(seenUrls[0].searchParams.get("end_date_max"), new Date(now + 3 * 60 * 60 * 1000).toISOString());
});

test("short-term discovery rejects invalid durationTypes and propagates abort", async (t) => {
  for (const durationTypes of [["30m"], [], "15m"]) {
    await assert.rejects(
      getShortTermMarkets(`invalid-duration${process.pid}`, { durationTypes }),
      /durationTypes|Unsupported short market durationTypes/,
    );
  }

  let fetchCalls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetchCalls += 1;
    throw new Error("network should not be reached");
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    getShortTermMarkets(`aborted${process.pid}`, { durationTypes: ["15m"], signal: controller.signal }),
    (error) => error?.name === "AbortError",
  );
  assert.equal(fetchCalls, 0);
});

test("short-term collection does not cache a blocked market", async (t) => {
  const marker = String(process.pid).slice(-5);
  const blockedId = `14${marker}`;
  const asset = `policynocache${process.pid}`;
  let directFetches = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname === `/markets/${blockedId}`) {
      directFetches += 1;
      return jsonResponse(gammaMarket({ id: blockedId, question: "Allowed boxing direct response" }));
    }
    const events = url.searchParams.get("series_slug")?.endsWith("-5m")
      ? [{ title: "UFC short event", markets: [gammaMarket({ id: blockedId, question: "Fight winner" })] }]
      : [];
    return jsonResponse(events);
  });

  await getShortTermMarkets(asset);
  const market = await getMarketById(blockedId);

  assert.equal(market.question, "Allowed boxing direct response");
  assert.equal(directFetches, 1);
});

test("direct market ID, market slug, and event slug reject UFC with the policy error contract", async (t) => {
  const marker = `direct-policy-${process.pid}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname.startsWith("/events/slug/")) {
      return jsonResponse({ id: "event-15", title: "UFC 401", slug: marker, markets: [] });
    }
    return jsonResponse(gammaMarket({ id: "1501", question: "Fight winner", slug: marker, tags: [{ slug: "ufc" }] }));
  });

  await assert.rejects(getMarketById("1501", true), assertUnsupportedUfc);
  await assert.rejects(getMarketBySlug(marker), assertUnsupportedUfc);
  await assert.rejects(getEventBySlug(marker), assertUnsupportedUfc);
});

test("direct market and event category enforcement is token-safe", async (t) => {
  const marker = `category-policy-${process.pid}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname.startsWith("/events/slug/")) {
      return jsonResponse({ id: "event-category", title: "Fight night", slug: marker, category: "Sports / UFC", markets: [] });
    }
    return jsonResponse(gammaMarket({ id: "1551", question: "Fight winner", slug: marker, category: "UFC" }));
  });

  await assert.rejects(getMarketById("1551", true), assertUnsupportedUfc);
  await assert.rejects(getEventBySlug(marker), assertUnsupportedUfc);
});

test("neutral mixed event links omit UFC children and retain boxing siblings", async (t) => {
  const slug = `neutral-mixed-event-${process.pid}`;
  const event = {
    id: "event-mixed",
    title: "Combat sports weekend",
    slug,
    category: "Combat Sports",
    tags: [{ label: "Sports" }],
    markets: [
      gammaMarket({ id: "1571", question: "Main event winner", category: "UFC", tags: [{ label: "UFC" }] }),
      gammaMarket({ id: "1572", question: "Boxing title winner", category: "Boxing", tags: [{ label: "Boxing" }] }),
    ],
  };
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname.startsWith("/events/slug/")) return jsonResponse(event);
    return jsonResponse(gammaMarket({ id: "fallback", question: "Fallback market", slug }));
  });

  const rawEvent = await getEventBySlug(slug);
  const hub = await getMarketsFromPolymarketLink(`https://polymarket.com/event/${slug}`);
  const selected = await getMarketFromPolymarketLink(`https://polymarket.com/event/${slug}`);

  assert.equal(rawEvent.markets.length, 2);
  assert.deepEqual(hub.markets.map((market) => market.id), ["1572"]);
  assert.equal(selected.id, "1572");
});

test("single-market event link resolver rethrows UFC policy errors instead of falling back", async (t) => {
  const slug = `blocked-event-link-${process.pid}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname.startsWith("/events/slug/")) {
      return jsonResponse({ id: "event-16", title: "UFC 402", slug, markets: [] });
    }
    return jsonResponse(gammaMarket({ id: "1601", question: "Allowed fallback boxing market", slug }));
  });

  await assert.rejects(
    getMarketFromPolymarketLink(`https://polymarket.com/event/${slug}`),
    assertUnsupportedUfc,
  );
});

test("multi-market event link resolver rethrows UFC policy errors instead of falling back", async (t) => {
  const slug = `blocked-event-hub-${process.pid}`;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.pathname.startsWith("/events/slug/")) {
      return jsonResponse({ id: "event-17", title: "UFC 403", slug, markets: [] });
    }
    return jsonResponse(gammaMarket({ id: "1701", question: "Allowed fallback boxing market", slug }));
  });

  await assert.rejects(
    getMarketsFromPolymarketLink(`https://polymarket.com/event/${slug}`),
    assertUnsupportedUfc,
  );
});

test("book rejects an unclassifiable raw token ID before any CLOB request", async (t) => {
  let clobRequests = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.hostname === "clob.polymarket.com") clobRequests += 1;
    return jsonResponse({ bids: [], asks: [] });
  });

  const answer = await handleCommand(
    "/book 123456789012345678901234567890",
    { chat: { id: `book-policy-${process.pid}` } },
    { chatId: `book-policy-${process.pid}` },
  );

  assert.match(answer.text, /\/book <marketId atau link Polymarket>/);
  assert.equal(clobRequests, 0);
});

test("blocked direct analysis rejects before requesting a CLOB orderbook", async (t) => {
  const marketId = `9${String(process.pid).slice(-6)}`;
  let clobRequests = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = trackedCacheUrl(input);
    if (url.hostname === "clob.polymarket.com") {
      clobRequests += 1;
      return jsonResponse({ bids: [], asks: [] }, 503);
    }
    return jsonResponse(gammaMarket({ id: marketId, question: "UFC final analysis winner" }));
  });
  const ctx = {
    chatId: `analysis-policy-${process.pid}`,
    sendMessage: async () => ({ message_id: 1 }),
    editMessageText: async () => {},
    deleteMessage: async () => {},
    sendChatAction: async () => {},
  };

  await assert.rejects(
    handleCommand(`/analyze ${marketId}`, { chat: { id: ctx.chatId } }, ctx),
    assertUnsupportedUfc,
  );
  assert.equal(clobRequests, 0);
});

test("short final refresh propagates UFC policy rejection without stale-token CLOB fallback", async (t) => {
  const marketId = `8${String(process.pid).slice(-6)}`;
  const state = mockShortRefreshNetwork(t, { marketId, refreshOverrides: { category: "UFC" } });

  await assert.rejects(getFastShortEntrySnapshot(marketId), assertUnsupportedUfc);
  assert.equal(state.gammaRequests, 2);
  assert.equal(state.clobRequests, 2);
});

test("non-policy short refresh failures remain fail-soft", async (t) => {
  const marketId = `7${String(process.pid).slice(-6)}`;
  const state = mockShortRefreshNetwork(t, { marketId, refreshOverrides: null });

  const snapshot = await getFastShortEntrySnapshot(marketId);

  assert.equal(snapshot.marketId, marketId);
  assert.equal(state.gammaRequests, 2);
  assert.equal(state.clobRequests, 4);
});

test("malformed final refresh metadata hard-fails before retaining original books", async (t) => {
  const marketId = `6${String(process.pid).slice(-6)}`;
  const state = mockShortRefreshNetwork(t, {
    marketId,
    refreshOverrides: { outcomes: ["Up", "Up"], clobTokenIds: ["up-a", "up-b"] },
  });

  await assert.rejects(
    getFastShortEntrySnapshot(marketId),
    (error) => error?.code === "TOKEN_MAPPING_INVALID",
  );
  assert.equal(state.clobRequests, 2, "invalid final metadata must not authorize another book fetch");
});
