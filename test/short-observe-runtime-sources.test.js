import assert from "node:assert/strict";
import test from "node:test";

import {
  createClobMarketResolutionSource,
  createRtdsBoundarySource,
  discoverOfficialBtc15mMarkets,
  fetchOfficialClobBook,
  fetchOfficialGammaPage,
  fetchOfficialGammaTerminalMarket,
} from "../src/short-observe-runtime-sources.js";
import { buildGammaKeysetRequest } from "../src/short-market-sources.js";

const FINGERPRINT = Object.freeze({
  id: "btc-15m-twap-60",
  asset: "btc",
  duration: "15m",
  twapEnabled: true,
  twapLookbackSeconds: 60,
});
const NOW_MS = Date.parse("2026-08-25T12:15:00.000Z");
const LOOKAHEAD_MS = 900_000;
const START_TIME_MIN = "2026-08-25T12:00:00.000Z";
const START_TIME_MAX = "2026-08-25T12:30:00.000Z";
const BOUNDARY_MS = 1_787_659_200_000;

function market(id, startTime, question, outcomes = ["Up", "Down"]) {
  const tokens = outcomes.map((outcome) => `token-${id}-${outcome.toLowerCase()}`);
  return {
    id,
    conditionId: `condition-${id}`,
    question,
    eventStartTime: startTime,
    endDate: new Date(Date.parse(startTime) + 900_000).toISOString(),
    outcomes,
    clobTokenIds: tokens,
    volume: "999999",
  };
}

function gammaPages() {
  const firstStart = "2026-08-25T12:00:00.000Z";
  const secondStart = "2026-08-25T12:15:00.000Z";
  return [{
    data: [{
      id: "event-100",
      title: "not registration evidence",
      startTime: firstStart,
      series: [{ id: "10192" }],
      cryptoFingerprint: structuredClone(FINGERPRINT),
      markets: [
        market("market-100-a", firstStart, "BTC first A Up or Down"),
        market("market-100-b", firstStart, "BTC first B Up or Down", ["Down", "Up"]),
      ],
    }],
    next_cursor: "event-100",
  }, {
    data: [{
      id: "event-200",
      startTime: secondStart,
      series: [{ id: "10192" }],
      cryptoFingerprint: structuredClone(FINGERPRINT),
      markets: [market("market-200", secondStart, "BTC second Up or Down")],
    }],
    next_cursor: null,
  }];
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return structuredClone(payload); },
  };
}

function clobBook(tokenId = "token-market-100-a-up") {
  return {
    asset_id: tokenId,
    timestamp: "1787659200123",
    bids: [{ price: "0.45", size: "3" }, { price: "0.47", size: "2" }],
    asks: [{ price: "0.54", size: "4" }, { price: "0.51", size: "1" }],
  };
}

function resolutionIdentity(overrides = {}) {
  return {
    marketId: "market-100-a",
    conditionId: "condition-100-a",
    tokenIds: {
      UP: "token-100-a-up",
      DOWN: "token-100-a-down",
      ...(overrides.tokenIds || {}),
    },
    ...overrides,
  };
}

function gammaTerminalMarket(identity = resolutionIdentity(), overrides = {}) {
  return {
    id: identity.marketId,
    conditionId: identity.conditionId,
    closed: true,
    umaResolutionStatus: "resolved",
    outcomes: "[\"Up\",\"Down\"]",
    clobTokenIds: JSON.stringify([identity.tokenIds.UP, identity.tokenIds.DOWN]),
    outcomePrices: "[\"1\",\"0\"]",
    volume: "not terminal evidence",
    ...overrides,
  };
}

function clobResolutionMessage(identity = resolutionIdentity(), overrides = {}) {
  return {
    event_type: "market_resolved",
    market: identity.conditionId,
    assets_ids: [identity.tokenIds.UP, identity.tokenIds.DOWN],
    winning_asset_id: identity.tokenIds.UP,
    winning_outcome: "Up",
    event_message: null,
    timestamp: "1787660100000",
    ...overrides,
  };
}

function rtdsFrame(timestamp = BOUNDARY_MS, overrides = {}) {
  return {
    topic: "crypto_prices_twap_sixty",
    type: "update",
    payload: {
      symbol: "btc/usd",
      timestamp,
      value: 112345.67,
      full_accuracy_value: "112345.678901234567890123",
      ...overrides,
    },
  };
}

function fakeTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(fn, delay) {
      const id = nextId++;
      tasks.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) { tasks.delete(id); },
    idForDelay(delay) {
      return [...tasks].find(([, task]) => task.delay === delay)?.[0] ?? null;
    },
    async fire(id) {
      const task = tasks.get(id);
      assert.ok(task, `timer ${id} must exist`);
      tasks.delete(id);
      await task.fn();
    },
  };
}

function fakeWebSockets() {
  const instances = [];
  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closeCalls = 0;
      this.listeners = new Map();
      instances.push(this);
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }

    off(event, listener) {
      this.listeners.get(event)?.delete(listener);
    }

    emit(event, value) {
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener(value);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    }

    message(value) { this.emit("message", value); }

    send(value) {
      if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
      this.sent.push(value);
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { WebSocketImpl: FakeWebSocket, instances };
}

function connectingCloseWebSockets() {
  const instances = [];
  class ConnectingCloseWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = ConnectingCloseWebSocket.CONNECTING;
      this.listeners = new Map();
      this.closeCalls = 0;
      this.errorEmissions = 0;
      this.errorListenerCountsAtEmission = [];
      this.unhandledErrors = [];
      this.teardown = Promise.resolve();
      instances.push(this);
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
    }

    off(event, listener) {
      this.listeners.get(event)?.delete(listener);
    }

    emit(event, value) {
      const listeners = [...(this.listeners.get(event) ?? [])];
      if (event === "error") {
        this.errorEmissions += 1;
        this.errorListenerCountsAtEmission.push(listeners.length);
        if (listeners.length === 0) {
          this.unhandledErrors.push(value);
          throw value;
        }
      }
      for (const listener of listeners) listener(value);
    }

    listenerCount() {
      return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0);
    }

    close() {
      this.closeCalls += 1;
      this.teardown = Promise.resolve().then(() => {
        this.emit("error", new Error("WebSocket was closed before the connection was established"));
        this.readyState = ConnectingCloseWebSocket.CLOSED;
        this.emit("close");
      });
    }
  }
  return { WebSocketImpl: ConnectingCloseWebSocket, instances };
}

test("official discovery uses the exact strict window/cursors and preserves every nested market", async () => {
  const pages = gammaPages();
  const calls = [];
  const controller = new AbortController();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(pages.shift());
  };

  const result = await discoverOfficialBtc15mMarkets({
    nowMs: NOW_MS,
    lookaheadMs: LOOKAHEAD_MS,
    signal: controller.signal,
    fetchImpl,
  });

  const first = buildGammaKeysetRequest({ startTimeMin: START_TIME_MIN, startTimeMax: START_TIME_MAX });
  const second = buildGammaKeysetRequest({ startTimeMin: START_TIME_MIN, startTimeMax: START_TIME_MAX, cursor: "event-100" });
  assert.deepEqual(calls.map((call) => call.url), [first.url, second.url]);
  assert.deepEqual(calls.map((call) => Object.fromEntries(new URL(call.url).searchParams)), [first.query, second.query]);
  for (const call of calls) {
    assert.equal(call.options.method, "GET");
    assert.equal(call.options.cache, "no-store");
    assert.equal(call.options.signal, controller.signal);
  }
  assert.equal(result.status, "OK");
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.markets.map((item) => item.identity.marketId), ["market-100-a", "market-100-b", "market-200"]);
  assert.deepEqual(result.markets.map((item) => item.question), [
    "BTC first A Up or Down",
    "BTC first B Up or Down",
    "BTC second Up or Down",
  ]);
  assert.deepEqual(result.markets[1].identity.tokenIds, {
    UP: "token-market-100-b-up",
    DOWN: "token-market-100-b-down",
  });
  assert.deepEqual(Object.keys(result.markets[0].discoveryPayload.event), ["id", "startTime", "series", "cryptoFingerprint"]);
  assert.deepEqual(Object.keys(result.markets[0].discoveryPayload.market), [
    "id", "conditionId", "question", "eventStartTime", "endDate", "outcomes", "clobTokenIds",
  ]);
  assert.equal("title" in result.markets[0].discoveryPayload.event, false);
  assert.equal("volume" in result.markets[0].discoveryPayload.market, false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.markets));
  assert.ok(Object.isFrozen(result.markets[0].discoveryPayload.market.outcomes));
  assert.throws(() => { result.markets[0].discoveryPayload.market.id = "mutated"; }, TypeError);
});

test("Gamma page fetch is uncached, propagates abort, and fails closed on HTTP or malformed responses", async () => {
  const request = buildGammaKeysetRequest({ startTimeMin: START_TIME_MIN, startTimeMax: START_TIME_MAX });
  const page = { data: [], next_cursor: null };
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return jsonResponse(page); };
  assert.deepEqual(await fetchOfficialGammaPage(request, { fetchImpl }), page);
  assert.deepEqual(await fetchOfficialGammaPage(request, { fetchImpl }), page);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url), [request.url, request.url]);
  assert.ok(calls.every((call) => call.options.cache === "no-store"));

  await assert.rejects(
    fetchOfficialGammaPage(request, { fetchImpl: async () => jsonResponse({ error: true }, 503) }),
    (error) => error.code === "GAMMA_HTTP_ERROR" && error.details.status === 503,
  );
  for (const malformed of [null, [], {}, { data: {}, next_cursor: null }, { data: [] }, { data: [], next_cursor: "" }]) {
    await assert.rejects(
      fetchOfficialGammaPage(request, { fetchImpl: async () => jsonResponse(malformed) }),
      (error) => error.code === "GAMMA_MALFORMED_RESPONSE",
    );
  }
  await assert.rejects(fetchOfficialGammaPage(request, {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError("bad JSON"); } }),
  }), SyntaxError);

  const preAborted = new AbortController();
  const preAbortReason = new Error("pre-aborted");
  preAborted.abort(preAbortReason);
  let fetched = false;
  await assert.rejects(fetchOfficialGammaPage(request, {
    signal: preAborted.signal,
    fetchImpl: async () => { fetched = true; return jsonResponse(page); },
  }), (error) => error === preAbortReason);
  assert.equal(fetched, false);

  const inFlight = new AbortController();
  const inFlightReason = new Error("caller deadline");
  let receivedSignal;
  const pending = fetchOfficialGammaPage(request, {
    signal: inFlight.signal,
    fetchImpl: async (_url, { signal }) => {
      receivedSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  inFlight.abort(inFlightReason);
  await assert.rejects(pending, (error) => error === inFlightReason);
  assert.equal(receivedSignal, inFlight.signal);
});

test("official CLOB fetch uses one exact uncached URL and the accepted strict parser", async () => {
  const tokenId = "token-market-100-a-up";
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, options }); return jsonResponse(clobBook(tokenId)); };
  const first = await fetchOfficialClobBook(tokenId, { fetchImpl });
  const second = await fetchOfficialClobBook(tokenId, { fetchImpl });
  assert.equal(first.status, "OK");
  assert.deepEqual(first.summary, {
    tokenId,
    bestBid: "0.47",
    bestAsk: "0.51",
    spread: "0.04",
    bidLevels: 2,
    askLevels: 2,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(calls.map((call) => call.url), [
    `https://clob.polymarket.com/book?token_id=${tokenId}`,
    `https://clob.polymarket.com/book?token_id=${tokenId}`,
  ]);
  assert.ok(calls.every((call) => call.options.method === "GET" && call.options.cache === "no-store"));

  assert.equal((await fetchOfficialClobBook(tokenId, {
    fetchImpl: async () => jsonResponse({ ...clobBook(tokenId), asset_id: "other-token" }),
  })).status, "DATA_GAP");
  assert.equal((await fetchOfficialClobBook(tokenId, {
    fetchImpl: async () => jsonResponse({ ...clobBook(tokenId), asks: [] }),
  })).status, "DATA_GAP");
  await assert.rejects(fetchOfficialClobBook(tokenId, {
    fetchImpl: async () => jsonResponse({}, 404),
  }), (error) => error.code === "CLOB_HTTP_ERROR" && error.details.status === 404);
  await assert.rejects(fetchOfficialClobBook(tokenId, {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError("bad JSON"); } }),
  }), SyntaxError);

  let invalidFetches = 0;
  for (const invalid of [null, 123, "", " token", "token ", "token\nvalue"]) {
    await assert.rejects(fetchOfficialClobBook(invalid, {
      fetchImpl: async () => { invalidFetches += 1; return jsonResponse(clobBook()); },
    }), (error) => error.code === "CLOB_TOKEN_INVALID");
  }
  assert.equal(invalidFetches, 0);

  const controller = new AbortController();
  const reason = new Error("book cancelled");
  controller.abort(reason);
  await assert.rejects(fetchOfficialClobBook(tokenId, {
    signal: controller.signal,
    fetchImpl: async () => jsonResponse(clobBook(tokenId)),
  }), (error) => error === reason);
});

test("official Gamma terminal fetch is uncached, strictly evaluated, and retains only minimal raw evidence", async () => {
  const identity = resolutionIdentity();
  const calls = [];
  const payloads = [
    gammaTerminalMarket(identity, { closed: false, umaResolutionStatus: "proposed", outcomePrices: "[\"0.5\",\"0.5\"]" }),
    gammaTerminalMarket(identity),
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return jsonResponse(payloads.shift());
  };

  const unresolved = await fetchOfficialGammaTerminalMarket(identity, { fetchImpl });
  assert.equal(unresolved.source, "GAMMA");
  assert.equal(unresolved.parsed.status, "UNRESOLVED");
  assert.equal(unresolved.parsed.reason, "GAMMA_MARKET_MISMATCH");
  assert.deepEqual(Object.keys(unresolved.market), [
    "id", "conditionId", "closed", "umaResolutionStatus", "outcomes", "clobTokenIds", "outcomePrices",
  ]);
  assert.equal("volume" in unresolved.market, false);
  assert.ok(Object.isFrozen(unresolved));
  assert.ok(Object.isFrozen(unresolved.market));

  const resolved = await fetchOfficialGammaTerminalMarket(identity, { fetchImpl });
  assert.equal(resolved.parsed.status, "RESOLVED");
  assert.equal(resolved.parsed.source, "GAMMA");
  assert.equal(resolved.parsed.outcome, "UP");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://gamma-api.polymarket.com/markets/market-100-a",
    "https://gamma-api.polymarket.com/markets/market-100-a",
  ]);
  assert.ok(calls.every((call) => call.options.method === "GET" && call.options.cache === "no-store"));
});

test("official Gamma terminal fetch propagates abort and fails closed on HTTP or malformed payloads", async () => {
  const identity = resolutionIdentity();
  await assert.rejects(fetchOfficialGammaTerminalMarket(identity, {
    fetchImpl: async () => jsonResponse({ error: true }, 502),
  }), (error) => error.code === "GAMMA_HTTP_ERROR" && error.details.status === 502);

  for (const malformed of [null, [], {}, { id: identity.marketId }]) {
    await assert.rejects(fetchOfficialGammaTerminalMarket(identity, {
      fetchImpl: async () => jsonResponse(malformed),
    }), (error) => error.code === "GAMMA_MALFORMED_RESPONSE");
  }
  await assert.rejects(fetchOfficialGammaTerminalMarket(identity, {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError("bad JSON"); } }),
  }), (error) => error.code === "GAMMA_MALFORMED_RESPONSE");

  const preAborted = new AbortController();
  const preReason = new Error("terminal lookup cancelled");
  preAborted.abort(preReason);
  let fetched = false;
  await assert.rejects(fetchOfficialGammaTerminalMarket(identity, {
    signal: preAborted.signal,
    fetchImpl: async () => { fetched = true; return jsonResponse(gammaTerminalMarket(identity)); },
  }), (error) => error === preReason);
  assert.equal(fetched, false);

  const inFlight = new AbortController();
  const inFlightReason = new Error("terminal deadline");
  let receivedSignal = null;
  const pending = fetchOfficialGammaTerminalMarket(identity, {
    signal: inFlight.signal,
    fetchImpl: async (_url, { signal }) => {
      receivedSignal = signal;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  inFlight.abort(inFlightReason);
  await assert.rejects(pending, (error) => error === inFlightReason);
  assert.equal(receivedSignal, inFlight.signal);
});

test("CLOB resolution source is inert until watched and sends the exact official subscription once", () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const identity = resolutionIdentity();
  const source = createClobMarketResolutionSource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    reconnectDelayMs: 9,
  });
  assert.equal(sockets.instances.length, 0);
  assert.equal(timers.tasks.size, 0);
  assert.equal(source.start(), true);
  assert.equal(source.start(), true);
  assert.equal(sockets.instances.length, 0);

  assert.equal(source.watchMarket(identity), true);
  assert.equal(source.watchMarket(structuredClone(identity)), true);
  assert.equal(sockets.instances.length, 1);
  const socket = sockets.instances[0];
  assert.equal(socket.url, "wss://ws-subscriptions-clob.polymarket.com/ws/market");
  socket.open();
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    assets_ids: [identity.tokenIds.UP, identity.tokenIds.DOWN],
    type: "market",
    custom_feature_enabled: true,
    initial_dump: false,
  });
  assert.deepEqual(source.getState().connectedMarketIds, [identity.marketId]);
  assert.equal(source.stop(), true);
  assert.equal(socket.closeCalls, 1);
  assert.equal(timers.tasks.size, 0);
});

test("CLOB resolution source ignores unrelated, malformed, and contradictory events then buffers one valid result", () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const identity = resolutionIdentity();
  const source = createClobMarketResolutionSource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    reconnectDelayMs: 4,
  });
  source.start();
  source.watchMarket(identity);
  const socket = sockets.instances[0];
  socket.open();

  socket.message("not-json");
  socket.message(JSON.stringify({ event_type: "price_change", market: identity.conditionId }));
  socket.message(JSON.stringify(clobResolutionMessage(identity, { market: "other-condition" })));
  socket.message(JSON.stringify(clobResolutionMessage(identity, { assets_ids: [identity.tokenIds.UP, "other-token"] })));
  socket.message(JSON.stringify(clobResolutionMessage(identity, { winning_outcome: "Down" })));
  socket.message(JSON.stringify(clobResolutionMessage(identity, { winning_asset_id: undefined })));
  assert.equal(source.getResolution(identity.marketId), null);
  assert.equal(socket.closeCalls, 0);

  const valid = clobResolutionMessage(identity);
  socket.message(JSON.stringify(valid));
  const buffered = source.getResolution(identity);
  assert.equal(buffered.source, "CLOB");
  assert.equal(buffered.marketId, identity.marketId);
  assert.equal(buffered.parsed.status, "RESOLVED");
  assert.equal(buffered.parsed.source, "CLOB_MARKET_RESOLVED");
  assert.equal(buffered.parsed.outcome, "UP");
  assert.deepEqual(buffered.message, {
    event_type: "market_resolved",
    market: identity.conditionId,
    assets_ids: [identity.tokenIds.UP, identity.tokenIds.DOWN],
    winning_asset_id: identity.tokenIds.UP,
    winning_outcome: "Up",
    timestamp: "1787660100000",
  });
  assert.equal("event_message" in buffered.message, false);
  assert.ok(Object.isFrozen(buffered));
  assert.ok(Object.isFrozen(buffered.message));
  assert.equal(socket.closeCalls, 1);
  assert.equal(timers.tasks.size, 0);

  socket.message(JSON.stringify(valid));
  assert.strictEqual(source.getResolution(identity.marketId), buffered);
  assert.equal(source.watchMarket(identity), true);
  assert.equal(sockets.instances.length, 1);
  assert.strictEqual(source.consumeResolution(identity.marketId), buffered);
  assert.equal(source.consumeResolution(identity.marketId), null);
  assert.equal(source.getResolution(identity.marketId), null);
  assert.deepEqual(source.getState().resolvedMarketIds, [identity.marketId]);
  assert.deepEqual(source.getState().reconnectScheduledMarketIds, []);
  assert.equal(source.stop(), true);
  assert.equal(timers.tasks.size, 0);
});

test("unresolved CLOB resolution sockets reconnect only while started", async () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const identity = resolutionIdentity();
  const source = createClobMarketResolutionSource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    reconnectDelayMs: 6,
  });
  source.start();
  source.watchMarket(identity);
  const first = sockets.instances[0];
  first.open();
  first.emit("close");
  assert.deepEqual(source.getState().reconnectScheduledMarketIds, [identity.marketId]);
  assert.equal(timers.tasks.size, 1);

  const reconnect = timers.idForDelay(6);
  await timers.fire(reconnect);
  assert.equal(sockets.instances.length, 2);
  const second = sockets.instances[1];
  second.open();
  assert.deepEqual(JSON.parse(second.sent[0]).assets_ids, [identity.tokenIds.UP, identity.tokenIds.DOWN]);
  assert.equal(source.stop(), true);
  assert.equal(second.closeCalls, 1);
  assert.equal(timers.tasks.size, 0);
  first.emit("close");
  second.emit("close");
  assert.equal(timers.tasks.size, 0);
  assert.equal(sockets.instances.length, 2);
});

test("stopping a CONNECTING CLOB resolution socket guards asynchronous close errors without reconnect", async () => {
  const timers = fakeTimers();
  const sockets = connectingCloseWebSockets();
  const source = createClobMarketResolutionSource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    reconnectDelayMs: 6,
  });
  source.start();
  source.watchMarket(resolutionIdentity());
  const socket = sockets.instances[0];
  assert.equal(socket.readyState, sockets.WebSocketImpl.CONNECTING);

  assert.equal(source.stop(), true);
  assert.equal(source.getState().started, false);
  assert.equal(source.getState().teardownSocketCount, 1);
  assert.equal(socket.closeCalls, 1);
  await assert.doesNotReject(socket.teardown);
  await Promise.resolve();
  assert.equal(socket.errorEmissions, 1);
  assert.ok(socket.errorListenerCountsAtEmission[0] >= 1);
  assert.deepEqual(socket.unhandledErrors, []);
  assert.equal(socket.listenerCount(), 0);
  assert.equal(source.getState().teardownSocketCount, 0);
  assert.deepEqual(source.getState().reconnectScheduledMarketIds, []);
  assert.equal(timers.tasks.size, 0);
  assert.equal(sockets.instances.length, 1);
  assert.equal(source.stop(), false);
});

test("RTDS construction is inert and exact boundary waiters never receive neighboring or malformed frames", async () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const source = createRtdsBoundarySource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    maxBufferedFrames: 4,
    heartbeatIntervalMs: 50,
    reconnectDelayMs: 5,
  });
  assert.equal(sockets.instances.length, 0);
  assert.equal(timers.tasks.size, 0);
  await assert.rejects(source.waitForBoundary(BOUNDARY_MS), (error) => error.code === "RTDS_NOT_STARTED");

  assert.equal(source.start(), true);
  assert.equal(source.start(), true);
  assert.equal(sockets.instances.length, 1);
  assert.equal(sockets.instances[0].url, "wss://ws-live-data.polymarket.com");
  const socket = sockets.instances[0];
  socket.open();
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    action: "subscribe",
    subscriptions: [{
      topic: "crypto_prices_twap_sixty",
      type: "update",
      filters: "{\"symbol\":\"btc/usd\"}",
    }],
  });

  let settled = false;
  const pending = source.waitForBoundary(BOUNDARY_MS).then((frame) => { settled = true; return frame; });
  socket.message(JSON.stringify(rtdsFrame(BOUNDARY_MS - 1)));
  socket.message(JSON.stringify(rtdsFrame(BOUNDARY_MS, { symbol: "eth/usd" })));
  socket.message("not-json");
  await Promise.resolve();
  assert.equal(settled, false);
  const expected = rtdsFrame();
  socket.message(JSON.stringify(expected));
  const exact = await pending;
  assert.deepEqual(exact, expected);
  assert.ok(Object.isFrozen(exact));
  assert.ok(Object.isFrozen(exact.payload));
  assert.equal(await source.waitForBoundary(BOUNDARY_MS), exact);
  assert.equal(source.stop(), true);
  assert.equal(socket.closeCalls, 1);
  assert.equal(timers.tasks.size, 0);
});

test("RTDS immediate close-boundary lookup returns only the exact buffered frame", () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const source = createRtdsBoundarySource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    heartbeatIntervalMs: 50,
    reconnectDelayMs: 5,
  });
  const closeBoundaryMs = BOUNDARY_MS + 900_000;
  assert.equal(source.getBoundary(closeBoundaryMs), null);
  assert.equal(source.getBoundary("1787659200000"), null);
  source.start();
  const socket = sockets.instances[0];
  socket.open();
  socket.message(JSON.stringify(rtdsFrame(closeBoundaryMs - 1)));
  const expected = rtdsFrame(closeBoundaryMs);
  socket.message(JSON.stringify(expected));

  assert.deepEqual(source.getBoundary(closeBoundaryMs), expected);
  assert.equal(source.getBoundary(closeBoundaryMs - 2), null);
  assert.equal(source.getBoundary(closeBoundaryMs + 1), null);
  assert.equal(source.stop(), true);
  assert.equal(source.getBoundary(closeBoundaryMs), null);
  assert.equal(timers.tasks.size, 0);
});

test("RTDS timestamp buffer is bounded and boundary waits propagate caller abort exactly", async () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const source = createRtdsBoundarySource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    maxBufferedFrames: 2,
    heartbeatIntervalMs: 100,
    reconnectDelayMs: 5,
  });
  source.start();
  const socket = sockets.instances[0];
  socket.open();
  socket.message(JSON.stringify(rtdsFrame(BOUNDARY_MS - 2)));
  socket.message(JSON.stringify(rtdsFrame(BOUNDARY_MS - 1)));
  socket.message(JSON.stringify(rtdsFrame(BOUNDARY_MS)));
  assert.deepEqual(source.getState().bufferedTimestamps, [BOUNDARY_MS - 1, BOUNDARY_MS]);
  assert.equal((await source.waitForBoundary(BOUNDARY_MS - 1)).payload.timestamp, BOUNDARY_MS - 1);

  const controller = new AbortController();
  const reason = new Error("boundary no longer needed");
  const evicted = source.waitForBoundary(BOUNDARY_MS - 2, controller.signal);
  const rejected = assert.rejects(evicted, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(source.getState().waiterCount, 0);

  const preAborted = new AbortController();
  const preReason = new Error("already aborted");
  preAborted.abort(preReason);
  await assert.rejects(source.waitForBoundary(BOUNDARY_MS, preAborted.signal), (error) => error === preReason);
  source.stop();
});

test("RTDS heartbeat, reconnect, and stop own all socket/timer/waiter cleanup", async () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const source = createRtdsBoundarySource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    heartbeatIntervalMs: 25,
    reconnectDelayMs: 7,
  });
  source.start();
  const first = sockets.instances[0];
  assert.equal(timers.tasks.size, 0);
  first.open();
  assert.equal(source.getState().heartbeatScheduled, true);
  const firstHeartbeat = timers.idForDelay(25);
  assert.notEqual(firstHeartbeat, null);
  await timers.fire(firstHeartbeat);
  assert.equal(first.sent.at(-1), "PING");
  assert.notEqual(timers.idForDelay(25), null);

  first.emit("close");
  assert.equal(source.getState().connected, false);
  assert.equal(source.getState().heartbeatScheduled, false);
  assert.equal(source.getState().reconnectScheduled, true);
  assert.equal(timers.tasks.size, 1);
  const reconnect = timers.idForDelay(7);
  await timers.fire(reconnect);
  assert.equal(sockets.instances.length, 2);
  const second = sockets.instances[1];
  second.open();
  assert.equal(JSON.parse(second.sent[0]).action, "subscribe");

  const waiting = source.waitForBoundary(BOUNDARY_MS + 10);
  const stopped = assert.rejects(waiting, (error) => error.name === "AbortError" && error.code === "RTDS_SOURCE_STOPPED");
  assert.equal(source.stop(), true);
  await stopped;
  assert.equal(second.closeCalls, 1);
  assert.equal(timers.tasks.size, 0);
  assert.deepEqual(source.getState().bufferedTimestamps, []);
  assert.equal(source.getState().waiterCount, 0);
  assert.equal(source.getState().started, false);
  second.emit("close");
  assert.equal(timers.tasks.size, 0);
  assert.equal(source.stop(), false);
});

test("stopping a CONNECTING ws absorbs its asynchronous error through close teardown", async () => {
  const timers = fakeTimers();
  const sockets = connectingCloseWebSockets();
  const source = createRtdsBoundarySource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    heartbeatIntervalMs: 25,
    reconnectDelayMs: 7,
  });
  source.start();
  const socket = sockets.instances[0];
  assert.equal(socket.readyState, sockets.WebSocketImpl.CONNECTING);

  const waiting = source.waitForBoundary(BOUNDARY_MS + 20);
  const stoppedWaiter = assert.rejects(
    waiting,
    (error) => error.name === "AbortError" && error.code === "RTDS_SOURCE_STOPPED",
  );
  assert.equal(source.stop(), true);
  assert.equal(source.getState().started, false);
  assert.equal(source.getState().teardownSocketCount, 1);
  assert.equal(source.getState().waiterCount, 0);
  assert.equal(socket.closeCalls, 1);
  await stoppedWaiter;

  await assert.doesNotReject(socket.teardown);
  await Promise.resolve();
  assert.equal(socket.errorEmissions, 1);
  assert.ok(socket.errorListenerCountsAtEmission[0] >= 1);
  assert.deepEqual(socket.unhandledErrors, []);
  assert.equal(socket.listenerCount(), 0);
  assert.equal(source.getState().teardownSocketCount, 0);
  assert.equal(source.getState().reconnectScheduled, false);
  assert.equal(timers.tasks.size, 0);
  assert.equal(sockets.instances.length, 1);
  assert.equal(source.stop(), false);
});

test("Chainlink report access has no implicit endpoint and is available only through injection", async () => {
  const timers = fakeTimers();
  const sockets = fakeWebSockets();
  const unavailable = createRtdsBoundarySource({ WebSocketImpl: sockets.WebSocketImpl, timers });
  assert.equal(await unavailable.fetchChainlinkReport(BOUNDARY_MS), null);
  assert.equal(unavailable.getState().chainlinkReportAvailable, false);
  assert.equal(sockets.instances.length, 0);

  const calls = [];
  const injected = createRtdsBoundarySource({
    WebSocketImpl: sockets.WebSocketImpl,
    timers,
    chainlinkReportTransport: async (request) => {
      calls.push(request);
      return { observationsTimestamp: request.boundaryTimestampMs / 1000, price: "112345.67" };
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await injected.fetchChainlinkReport(BOUNDARY_MS, controller.signal), {
    observationsTimestamp: BOUNDARY_MS / 1000,
    price: "112345.67",
  });
  assert.equal(calls[0].boundaryTimestampMs, BOUNDARY_MS);
  assert.equal(calls[0].signal, controller.signal);
  assert.equal(injected.getState().chainlinkReportAvailable, true);
  assert.equal(sockets.instances.length, 0);
});
