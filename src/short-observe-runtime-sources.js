import {
  SHORT_OBSERVE_DURATION_MS,
  ShortObserveContractError,
} from "./short-observe-contract.js";
import {
  RTDS_BTC_SYMBOL,
  RTDS_TWAP_TOPIC,
  paginateGammaBtc15mMarkets,
  parseClobBook,
  parseRtdsBoundaryTwap,
} from "./short-market-sources.js";
import {
  parseClobMarketResolved,
  parseGammaResolvedMarket,
} from "./short-resolution-evaluator.js";

// These canonical official endpoints are deliberately not configurable here:
// strict adapters must not fall through to legacy, cached, or manual URLs.
const OFFICIAL_CLOB_BOOK_URL = "https://clob.polymarket.com/book";
const OFFICIAL_CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const OFFICIAL_GAMMA_MARKET_URL = "https://gamma-api.polymarket.com/markets/";
const OFFICIAL_RTDS_URL = "wss://ws-live-data.polymarket.com";
const RTDS_HEARTBEAT_MESSAGE = "PING";
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_BUFFERED_FRAMES = 256;
const DEFAULT_MAX_WATCHED_MARKETS = 256;

function runtimeError(code, message, details = null) {
  return new ShortObserveContractError(code, message, details);
}

function abortError(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal, message = "Official source request aborted") {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  throw signal.reason ?? abortError(message);
}

function exactFetch(fetchImpl) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  return fetchImpl;
}

async function fetchUncachedJson(url, { signal, fetchImpl, source, strictJson = false }) {
  const performFetch = exactFetch(fetchImpl);
  throwIfAborted(signal, `${source} request aborted`);
  const response = await performFetch(url, {
    method: "GET",
    cache: "no-store",
    signal,
  });
  throwIfAborted(signal, `${source} request aborted`);
  if (!response || typeof response !== "object" || response.ok !== true) {
    const status = Number.isInteger(response?.status) ? response.status : null;
    throw runtimeError(`${source}_HTTP_ERROR`, `${source} request failed${status === null ? "" : ` with HTTP ${status}`}`, Object.freeze({ status }));
  }
  if (typeof response.json !== "function") {
    throw runtimeError(`${source}_MALFORMED_RESPONSE`, `${source} response does not provide JSON`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throwIfAborted(signal, `${source} request aborted`);
    if (!strictJson) throw error;
    throw runtimeError(`${source}_MALFORMED_RESPONSE`, `${source} response is not valid JSON`);
  }
  throwIfAborted(signal, `${source} request aborted`);
  return payload;
}

function exactGammaPage(page) {
  if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.data)) {
    throw runtimeError("GAMMA_MALFORMED_RESPONSE", "Gamma response must contain a data array");
  }
  if (page.next_cursor !== null && (typeof page.next_cursor !== "string" || !page.next_cursor)) {
    throw runtimeError("GAMMA_MALFORMED_RESPONSE", "Gamma response must contain a null or non-empty next_cursor");
  }
  return page;
}

/**
 * Fetch one request produced by buildGammaKeysetRequest without adding a
 * cache-buster, retry, timeout, alternate host, or cache lookup.
 */
export async function fetchOfficialGammaPage(request, { signal = null, fetchImpl = globalThis.fetch } = {}) {
  if (!request || typeof request !== "object" || typeof request.url !== "string" || !request.url) {
    throw runtimeError("GAMMA_REQUEST_INVALID", "A generated Gamma request URL is required");
  }
  const page = await fetchUncachedJson(request.url, { signal, fetchImpl, source: "GAMMA" });
  return exactGammaPage(page);
}

function exactWindow(nowMs, lookaheadMs) {
  if (!Number.isSafeInteger(nowMs)) throw runtimeError("INVALID_WINDOW", "nowMs must be a safe integer timestamp");
  if (!Number.isSafeInteger(lookaheadMs) || lookaheadMs < 0) {
    throw runtimeError("INVALID_WINDOW", "lookaheadMs must be a non-negative safe integer");
  }
  const startMs = nowMs - SHORT_OBSERVE_DURATION_MS;
  const endMs = nowMs + lookaheadMs;
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    throw runtimeError("INVALID_WINDOW", "Discovery window exceeds the safe integer range");
  }
  const start = new Date(startMs);
  const end = new Date(endMs);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw runtimeError("INVALID_WINDOW", "Discovery window is outside the supported timestamp range");
  }
  return Object.freeze({ startTimeMin: start.toISOString(), startTimeMax: end.toISOString() });
}

function immutableJsonCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableJsonCopy));
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, immutableJsonCopy(item)])));
  }
  return value;
}

function rawEventSubset(event) {
  return Object.freeze({
    id: event.id,
    startTime: event.startTime,
    series: Object.freeze(event.series.map((series) => Object.freeze({ id: series.id }))),
    cryptoFingerprint: immutableJsonCopy(event.cryptoFingerprint),
  });
}

function rawMarketSubset(market) {
  return Object.freeze({
    id: market.id,
    conditionId: market.conditionId,
    question: typeof market.question === "string" ? market.question : null,
    eventStartTime: market.eventStartTime,
    endDate: market.endDate,
    outcomes: immutableJsonCopy(market.outcomes),
    clobTokenIds: immutableJsonCopy(market.clobTokenIds),
  });
}

function registrationCandidates(result) {
  const rawByIdentity = new Map();
  for (const event of result.events) {
    for (const market of event.markets) {
      const key = `${event.id}\u0000${market.id}`;
      if (!rawByIdentity.has(key)) rawByIdentity.set(key, { event, market });
    }
  }
  return Object.freeze(result.markets.map((identity) => {
    const raw = rawByIdentity.get(`${identity.eventId}\u0000${identity.marketId}`);
    if (!raw) throw runtimeError("GAMMA_EVIDENCE_MISSING", `Raw Gamma evidence is missing for market ${identity.marketId}`);
    const event = rawEventSubset(raw.event);
    const market = rawMarketSubset(raw.market);
    return Object.freeze({
      identity,
      question: market.question,
      discoveryPayload: Object.freeze({ event, market }),
    });
  }));
}

/**
 * Discover only canonical BTC 15m identities through the accepted strict
 * keyset paginator. The returned raw subset is sufficient registration
 * evidence but intentionally excludes the rest of each Gamma response.
 */
export async function discoverOfficialBtc15mMarkets({
  nowMs,
  lookaheadMs,
  signal = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  throwIfAborted(signal, "Gamma discovery aborted");
  const window = exactWindow(nowMs, lookaheadMs);
  const result = await paginateGammaBtc15mMarkets({
    ...window,
    signal,
    fetchPage: (request, options = {}) => fetchOfficialGammaPage(request, {
      signal: options.signal,
      fetchImpl,
    }),
  });
  throwIfAborted(signal, "Gamma discovery aborted");
  return Object.freeze({
    status: result.status,
    pageCount: result.pageCount,
    markets: registrationCandidates(result),
  });
}

function exactTokenId(tokenId) {
  if (typeof tokenId !== "string" || !tokenId || tokenId !== tokenId.trim() || /[\u0000-\u001f\u007f]/.test(tokenId)) {
    throw runtimeError("CLOB_TOKEN_INVALID", "tokenId must be a non-empty exact string");
  }
  return tokenId;
}

function exactResolutionText(value, field, code) {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw runtimeError(code, `${field} must be a non-empty exact string`);
  }
  return value;
}

function exactResolutionIdentity(identity, code) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw runtimeError(code, "A canonical market identity is required");
  }
  const marketId = exactResolutionText(identity.marketId, "identity.marketId", code);
  const conditionId = exactResolutionText(identity.conditionId, "identity.conditionId", code);
  const UP = exactResolutionText(identity.tokenIds?.UP, "identity.tokenIds.UP", code);
  const DOWN = exactResolutionText(identity.tokenIds?.DOWN, "identity.tokenIds.DOWN", code);
  if (UP === DOWN) throw runtimeError(code, "identity UP and DOWN token ids must be distinct");
  return Object.freeze({
    marketId,
    conditionId,
    tokenIds: Object.freeze({ UP, DOWN }),
  });
}

const GAMMA_TERMINAL_FIELDS = Object.freeze([
  "id",
  "conditionId",
  "closed",
  "umaResolutionStatus",
  "outcomes",
  "clobTokenIds",
  "outcomePrices",
]);

function gammaTerminalEvidence(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || GAMMA_TERMINAL_FIELDS.some((field) => !Object.hasOwn(payload, field))) {
    throw runtimeError("GAMMA_MALFORMED_RESPONSE", "Gamma terminal response is missing required market fields");
  }
  return immutableJsonCopy(Object.fromEntries(GAMMA_TERMINAL_FIELDS.map((field) => [field, payload[field]])));
}

/**
 * Fetch and evaluate one canonical market from Gamma's official direct-market
 * endpoint. The adapter never caches or retries and retains only the raw fields
 * consumed by the pure terminal evaluator.
 */
export async function fetchOfficialGammaTerminalMarket(identity, {
  signal = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const canonicalIdentity = exactResolutionIdentity(identity, "GAMMA_IDENTITY_INVALID");
  const url = `${OFFICIAL_GAMMA_MARKET_URL}${encodeURIComponent(canonicalIdentity.marketId)}`;
  const payload = await fetchUncachedJson(url, {
    signal,
    fetchImpl,
    source: "GAMMA",
    strictJson: true,
  });
  const market = gammaTerminalEvidence(payload);
  return Object.freeze({
    source: "GAMMA",
    market,
    parsed: parseGammaResolvedMarket(market, canonicalIdentity),
  });
}

/** Fetch and strictly parse one official, uncached CLOB book. */
export async function fetchOfficialClobBook(tokenId, { signal = null, fetchImpl = globalThis.fetch } = {}) {
  const exactToken = exactTokenId(tokenId);
  const url = new URL(OFFICIAL_CLOB_BOOK_URL);
  url.searchParams.set("token_id", exactToken);
  const book = await fetchUncachedJson(url.toString(), { signal, fetchImpl, source: "CLOB" });
  return parseClobBook(book, exactToken);
}

function exactPositiveInteger(value, field, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${field} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function timerApi(timers) {
  const source = timers ?? globalThis;
  if (typeof source?.setTimeout !== "function" || typeof source?.clearTimeout !== "function") {
    throw new TypeError("timers must provide setTimeout and clearTimeout");
  }
  return Object.freeze({
    setTimeout: source.setTimeout.bind(source),
    clearTimeout: source.clearTimeout.bind(source),
  });
}

function bindSocketEvent(socket, event, handler) {
  if (typeof socket?.addEventListener === "function") {
    socket.addEventListener(event, handler);
    return () => socket.removeEventListener?.(event, handler);
  }
  if (typeof socket?.on === "function") {
    socket.on(event, handler);
    return () => {
      if (typeof socket.off === "function") socket.off(event, handler);
      else socket.removeListener?.(event, handler);
    };
  }
  const property = `on${event}`;
  if (!socket || !(property in socket)) throw new TypeError("WebSocket implementation does not support event listeners");
  socket[property] = handler;
  return () => { if (socket[property] === handler) socket[property] = null; };
}

function socketMessageValue(value) {
  if (value && typeof value === "object" && Object.hasOwn(value, "data")) return value.data;
  return value;
}

function decodeRtdsFrame(value) {
  const raw = socketMessageValue(value);
  if (raw && typeof raw === "object" && !ArrayBuffer.isView(raw) && !(raw instanceof ArrayBuffer)) {
    return immutableJsonCopy(raw);
  }
  try {
    return immutableJsonCopy(JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

function stoppedError() {
  const error = abortError("RTDS boundary source stopped");
  error.code = "RTDS_SOURCE_STOPPED";
  return error;
}

function exactBoundaryTimestamp(value) {
  if (!Number.isSafeInteger(value)) throw new TypeError("boundaryTimestampMs must be a safe integer");
  return value;
}

function chainlinkInvoker(transport) {
  if (transport == null) return null;
  if (typeof transport === "function") return transport;
  if (typeof transport.fetchReport === "function") return transport.fetchReport.bind(transport);
  throw new TypeError("chainlinkReportTransport must be a function or provide fetchReport");
}

/**
 * Create an explicitly-started RTDS boundary source. Construction is inert:
 * no socket or timer is created until start() is called. Chainlink report
 * access remains unavailable unless a decoded-report transport is injected.
 */
export function createRtdsBoundarySource({
  WebSocketImpl = globalThis.WebSocket,
  timers = globalThis,
  maxBufferedFrames = DEFAULT_MAX_BUFFERED_FRAMES,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  chainlinkReportTransport = null,
} = {}) {
  const timer = timerApi(timers);
  const bufferLimit = exactPositiveInteger(maxBufferedFrames, "maxBufferedFrames");
  const heartbeatDelay = exactPositiveInteger(heartbeatIntervalMs, "heartbeatIntervalMs");
  const reconnectDelay = exactPositiveInteger(reconnectDelayMs, "reconnectDelayMs", { allowZero: true });
  const invokeChainlinkReport = chainlinkInvoker(chainlinkReportTransport);
  const subscriptionMessage = JSON.stringify({
    action: "subscribe",
    subscriptions: [{
      topic: RTDS_TWAP_TOPIC,
      type: "update",
      filters: JSON.stringify({ symbol: RTDS_BTC_SYMBOL }),
    }],
  });

  const frames = new Map();
  const waiters = new Map();
  const stoppedSocketTeardowns = new Set();
  let started = false;
  let connected = false;
  let socket = null;
  let unbindSocket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let lastError = null;

  function clearHeartbeat() {
    if (heartbeatTimer !== null) timer.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  }

  function clearReconnect() {
    if (reconnectTimer !== null) timer.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function safeClose(candidate) {
    try { candidate?.close?.(); } catch { /* Closing is best effort during teardown. */ }
  }

  function teardownStoppedSocket(candidate, cleanup) {
    if (!candidate) {
      cleanup?.();
      return;
    }

    const teardown = { candidate };
    stoppedSocketTeardowns.add(teardown);
    let finished = false;
    let removeErrorGuard = null;
    let removeCloseGuard = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      // Keep both the original error handler and this dedicated guard until
      // close confirms that ws has completed its asynchronous CONNECTING
      // teardown. Removing them before close() lets ws emit an unhandled
      // "closed before connection established" error on a later turn.
      cleanup?.();
      removeCloseGuard?.();
      removeErrorGuard?.();
      stoppedSocketTeardowns.delete(teardown);
    };

    try {
      removeErrorGuard = bindSocketEvent(candidate, "error", (error) => {
        if (error) lastError = error;
      });
      removeCloseGuard = bindSocketEvent(candidate, "close", finish);
      candidate.close?.();
    } catch (error) {
      lastError = error;
      finish();
    }
  }

  function scheduleReconnect() {
    if (!started || reconnectTimer !== null) return;
    reconnectTimer = timer.setTimeout(() => {
      reconnectTimer = null;
      if (started) connect();
    }, reconnectDelay);
  }

  function disconnect(candidate, error = null, close = false) {
    if (candidate !== socket) return;
    if (error) lastError = error;
    socket = null;
    connected = false;
    clearHeartbeat();
    const cleanup = unbindSocket;
    unbindSocket = null;
    cleanup?.();
    if (close) safeClose(candidate);
    scheduleReconnect();
  }

  function scheduleHeartbeat(candidate) {
    clearHeartbeat();
    if (!started || !connected || socket !== candidate) return;
    heartbeatTimer = timer.setTimeout(() => {
      heartbeatTimer = null;
      if (!started || !connected || socket !== candidate) return;
      try {
        candidate.send(RTDS_HEARTBEAT_MESSAGE);
      } catch (error) {
        disconnect(candidate, error, true);
        return;
      }
      scheduleHeartbeat(candidate);
    }, heartbeatDelay);
  }

  function removeWaiter(waiter) {
    const waiting = waiters.get(waiter.timestamp);
    waiting?.delete(waiter);
    if (waiting?.size === 0) waiters.delete(waiter.timestamp);
    waiter.signal?.removeEventListener?.("abort", waiter.onAbort);
  }

  function settleExactWaiters(timestamp, frame) {
    const waiting = waiters.get(timestamp);
    if (!waiting) return;
    for (const waiter of [...waiting]) {
      removeWaiter(waiter);
      waiter.resolve(frame);
    }
  }

  function acceptMessage(candidate, value) {
    if (!started || !connected || socket !== candidate) return;
    const frame = decodeRtdsFrame(value);
    const timestamp = frame?.payload?.timestamp;
    if (!Number.isSafeInteger(timestamp) || parseRtdsBoundaryTwap(frame, timestamp).status !== "OK") return;
    if (frames.has(timestamp)) frames.delete(timestamp);
    frames.set(timestamp, frame);
    while (frames.size > bufferLimit) frames.delete(frames.keys().next().value);
    settleExactWaiters(timestamp, frame);
  }

  function connect() {
    if (!started || socket !== null) return;
    if (typeof WebSocketImpl !== "function") {
      const error = new TypeError("WebSocketImpl must be provided before start");
      lastError = error;
      throw error;
    }
    let candidate;
    try {
      candidate = new WebSocketImpl(OFFICIAL_RTDS_URL);
    } catch (error) {
      lastError = error;
      scheduleReconnect();
      return;
    }
    socket = candidate;
    connected = false;

    const cleanups = [
      bindSocketEvent(candidate, "open", () => {
        if (!started || socket !== candidate || connected) return;
        connected = true;
        try {
          candidate.send(subscriptionMessage);
        } catch (error) {
          disconnect(candidate, error, true);
          return;
        }
        scheduleHeartbeat(candidate);
      }),
      bindSocketEvent(candidate, "message", (value) => acceptMessage(candidate, value)),
      bindSocketEvent(candidate, "close", () => disconnect(candidate)),
      bindSocketEvent(candidate, "error", (error) => disconnect(candidate, error, true)),
    ];
    unbindSocket = () => { for (const cleanup of cleanups) cleanup(); };
  }

  function start() {
    if (started) return true;
    if (typeof WebSocketImpl !== "function") throw new TypeError("WebSocketImpl must be provided before start");
    started = true;
    try {
      connect();
    } catch (error) {
      started = false;
      throw error;
    }
    return true;
  }

  function waitForBoundary(boundaryTimestampMs, signal = null) {
    const timestamp = exactBoundaryTimestamp(boundaryTimestampMs);
    return new Promise((resolve, reject) => {
      try { throwIfAborted(signal, "RTDS boundary wait aborted"); } catch (error) { reject(error); return; }
      if (!started) { reject(runtimeError("RTDS_NOT_STARTED", "RTDS boundary source is not started")); return; }
      const exact = frames.get(timestamp);
      if (exact) { resolve(exact); return; }

      const waiter = { timestamp, signal, resolve, reject, onAbort: null };
      waiter.onAbort = () => {
        removeWaiter(waiter);
        reject(signal.reason ?? abortError("RTDS boundary wait aborted"));
      };
      const waiting = waiters.get(timestamp) ?? new Set();
      waiting.add(waiter);
      waiters.set(timestamp, waiting);
      signal?.addEventListener?.("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  function getBoundary(boundaryTimestampMs) {
    if (!Number.isSafeInteger(boundaryTimestampMs)) return null;
    return frames.get(boundaryTimestampMs) ?? null;
  }

  async function fetchChainlinkReport(boundaryTimestampMs, signal = null) {
    const timestamp = exactBoundaryTimestamp(boundaryTimestampMs);
    throwIfAborted(signal, "Chainlink report request aborted");
    if (!invokeChainlinkReport) return null;
    const report = await invokeChainlinkReport(Object.freeze({ boundaryTimestampMs: timestamp, signal }));
    throwIfAborted(signal, "Chainlink report request aborted");
    return report ?? null;
  }

  function stop() {
    const hadWork = started || socket !== null || heartbeatTimer !== null || reconnectTimer !== null
      || waiters.size > 0 || frames.size > 0 || stoppedSocketTeardowns.size > 0;
    // The stopped state must be visible before close() can synchronously or
    // asynchronously emit error/close. Every reconnect path checks this flag.
    started = false;
    connected = false;
    clearHeartbeat();
    clearReconnect();
    const candidate = socket;
    socket = null;
    const cleanup = unbindSocket;
    unbindSocket = null;
    teardownStoppedSocket(candidate, cleanup);
    frames.clear();
    for (const waiting of [...waiters.values()]) {
      for (const waiter of [...waiting]) {
        removeWaiter(waiter);
        waiter.reject(stoppedError());
      }
    }
    return hadWork;
  }

  function getState() {
    let waiterCount = 0;
    for (const waiting of waiters.values()) waiterCount += waiting.size;
    return Object.freeze({
      started,
      connected,
      bufferedTimestamps: Object.freeze([...frames.keys()]),
      waiterCount,
      heartbeatScheduled: heartbeatTimer !== null,
      reconnectScheduled: reconnectTimer !== null,
      teardownSocketCount: stoppedSocketTeardowns.size,
      chainlinkReportAvailable: invokeChainlinkReport !== null,
      lastError,
    });
  }

  return Object.freeze({ start, stop, getBoundary, waitForBoundary, fetchChainlinkReport, getState });
}

function clobResolutionEvidence(message) {
  return Object.freeze({
    event_type: message.event_type,
    market: message.market,
    assets_ids: immutableJsonCopy(message.assets_ids),
    winning_asset_id: message.winning_asset_id,
    winning_outcome: message.winning_outcome,
    timestamp: message.timestamp ?? null,
  });
}

function sameResolutionIdentity(left, right) {
  return left.marketId === right.marketId
    && left.conditionId === right.conditionId
    && left.tokenIds.UP === right.tokenIds.UP
    && left.tokenIds.DOWN === right.tokenIds.DOWN;
}

function marketIdForRead(value) {
  const marketId = typeof value === "string" ? value : value?.marketId;
  return typeof marketId === "string" && marketId && marketId === marketId.trim()
    && !/[\u0000-\u001f\u007f]/.test(marketId)
    ? marketId
    : null;
}

/**
 * Create an injected, explicitly managed CLOB market-resolution source.
 * Construction and start are inert until a canonical identity is watched. A
 * watched unresolved market owns at most one active/connecting socket and one
 * reconnect timer.
 */
export function createClobMarketResolutionSource({
  WebSocketImpl = globalThis.WebSocket,
  timers = globalThis,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
  maxWatchedMarkets = DEFAULT_MAX_WATCHED_MARKETS,
} = {}) {
  const timer = timerApi(timers);
  const reconnectDelay = exactPositiveInteger(reconnectDelayMs, "reconnectDelayMs", { allowZero: true });
  const watchLimit = exactPositiveInteger(maxWatchedMarkets, "maxWatchedMarkets");
  const watchers = new Map();
  const closingSockets = new Set();
  let started = false;
  let lastError = null;

  function clearReconnect(watcher) {
    if (watcher.reconnectTimer !== null) timer.clearTimeout(watcher.reconnectTimer);
    watcher.reconnectTimer = null;
  }

  function isCurrent(watcher) {
    return watchers.get(watcher.identity.marketId) === watcher;
  }

  function scheduleReconnect(watcher) {
    if (!started || watcher.resolved || !isCurrent(watcher)
        || watcher.socket !== null || watcher.reconnectTimer !== null || watcher.teardownCount !== 0) return;
    watcher.reconnectTimer = timer.setTimeout(() => {
      watcher.reconnectTimer = null;
      if (started && !watcher.resolved && isCurrent(watcher) && watcher.socket === null) connect(watcher);
    }, reconnectDelay);
  }

  function guardedClose(candidate, cleanup, watcher, onClosed = null) {
    if (!candidate) {
      cleanup?.();
      onClosed?.();
      return;
    }

    const teardown = { candidate };
    closingSockets.add(teardown);
    watcher.teardownCount += 1;
    let finished = false;
    let removeErrorGuard = null;
    let removeCloseGuard = null;
    const recordTeardownError = (error) => {
      if (!error) return;
      watcher.lastError = error;
      lastError = error;
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      try { cleanup?.(); } catch (error) { recordTeardownError(error); }
      try { removeCloseGuard?.(); } catch (error) { recordTeardownError(error); }
      try { removeErrorGuard?.(); } catch (error) { recordTeardownError(error); }
      closingSockets.delete(teardown);
      watcher.teardownCount -= 1;
      try { onClosed?.(); } catch (error) { recordTeardownError(error); }
    };

    try {
      removeErrorGuard = bindSocketEvent(candidate, "error", (error) => {
        recordTeardownError(error);
      });
      removeCloseGuard = bindSocketEvent(candidate, "close", finish);
      const closedState = Number.isInteger(WebSocketImpl?.CLOSED) ? WebSocketImpl.CLOSED : 3;
      if (candidate.readyState === closedState || typeof candidate.close !== "function") {
        finish();
        return;
      }
      candidate.close();
    } catch (error) {
      recordTeardownError(error);
      finish();
    }
  }

  function disconnect(watcher, candidate, { error = null, close = false } = {}) {
    if (watcher.socket !== candidate) return;
    if (error) {
      watcher.lastError = error;
      lastError = error;
    }
    watcher.socket = null;
    watcher.connected = false;
    const cleanup = watcher.unbindSocket;
    watcher.unbindSocket = null;
    if (close) guardedClose(candidate, cleanup, watcher, () => scheduleReconnect(watcher));
    else {
      cleanup?.();
      scheduleReconnect(watcher);
    }
  }

  function closeResolvedSocket(watcher, candidate) {
    if (watcher.socket !== candidate) return;
    watcher.socket = null;
    watcher.connected = false;
    const cleanup = watcher.unbindSocket;
    watcher.unbindSocket = null;
    guardedClose(candidate, cleanup, watcher);
  }

  function acceptMessage(watcher, candidate, value) {
    if (!started || watcher.resolved || !isCurrent(watcher) || watcher.socket !== candidate) return;
    const message = decodeRtdsFrame(value);
    if (!message || typeof message !== "object" || Array.isArray(message)
        || message.event_type !== "market_resolved") return;

    const rawMessage = clobResolutionEvidence(message);
    let parsed;
    try {
      parsed = parseClobMarketResolved(rawMessage, watcher.identity);
    } catch (error) {
      watcher.lastError = error;
      lastError = error;
      return;
    }
    if (parsed.status !== "RESOLVED" || watcher.seenSignatures.has(parsed.signature)) return;

    watcher.seenSignatures.add(parsed.signature);
    watcher.resolved = true;
    watcher.buffered = Object.freeze({
      source: "CLOB",
      marketId: watcher.identity.marketId,
      message: rawMessage,
      parsed,
    });
    clearReconnect(watcher);
    closeResolvedSocket(watcher, candidate);
  }

  function connect(watcher) {
    if (!started || watcher.resolved || !isCurrent(watcher)
        || watcher.socket !== null || watcher.reconnectTimer !== null || watcher.teardownCount !== 0) return;
    let candidate;
    try {
      candidate = new WebSocketImpl(OFFICIAL_CLOB_MARKET_WS_URL);
    } catch (error) {
      watcher.lastError = error;
      lastError = error;
      scheduleReconnect(watcher);
      return;
    }

    watcher.socket = candidate;
    watcher.connected = false;
    const cleanups = [];
    try {
      cleanups.push(
        bindSocketEvent(candidate, "open", () => {
          if (!started || watcher.resolved || !isCurrent(watcher)
              || watcher.socket !== candidate || watcher.connected) return;
          watcher.connected = true;
          try {
            candidate.send(JSON.stringify({
              assets_ids: [watcher.identity.tokenIds.UP, watcher.identity.tokenIds.DOWN],
              type: "market",
              custom_feature_enabled: true,
              initial_dump: false,
            }));
          } catch (error) {
            disconnect(watcher, candidate, { error, close: true });
          }
        }),
        bindSocketEvent(candidate, "message", (value) => acceptMessage(watcher, candidate, value)),
        bindSocketEvent(candidate, "close", () => disconnect(watcher, candidate)),
        bindSocketEvent(candidate, "error", (error) => disconnect(watcher, candidate, { error, close: true })),
      );
      watcher.unbindSocket = () => { for (const cleanup of cleanups) cleanup(); };
    } catch (error) {
      watcher.socket = null;
      watcher.connected = false;
      const cleanup = () => { for (const remove of cleanups) remove(); };
      watcher.lastError = error;
      lastError = error;
      guardedClose(candidate, cleanup, watcher, () => scheduleReconnect(watcher));
    }
  }

  function start() {
    if (started) return true;
    if (typeof WebSocketImpl !== "function") throw new TypeError("WebSocketImpl must be provided before start");
    started = true;
    for (const watcher of watchers.values()) connect(watcher);
    return true;
  }

  function watchMarket(identity) {
    const canonicalIdentity = exactResolutionIdentity(identity, "CLOB_RESOLUTION_IDENTITY_INVALID");
    const existing = watchers.get(canonicalIdentity.marketId);
    if (existing) {
      if (!sameResolutionIdentity(existing.identity, canonicalIdentity)) {
        throw runtimeError("CLOB_RESOLUTION_IDENTITY_CONFLICT", `Conflicting identity for market ${canonicalIdentity.marketId}`);
      }
      if (started && !existing.resolved && existing.socket === null && existing.reconnectTimer === null) connect(existing);
      return true;
    }
    if (watchers.size >= watchLimit) {
      throw runtimeError("CLOB_WATCH_LIMIT", `Cannot watch more than ${watchLimit} CLOB resolution markets`);
    }
    const watcher = {
      identity: canonicalIdentity,
      socket: null,
      unbindSocket: null,
      connected: false,
      reconnectTimer: null,
      teardownCount: 0,
      resolved: false,
      buffered: null,
      seenSignatures: new Set(),
      lastError: null,
    };
    watchers.set(canonicalIdentity.marketId, watcher);
    if (started) connect(watcher);
    return true;
  }

  function getResolution(market) {
    const marketId = marketIdForRead(market);
    return marketId === null ? null : watchers.get(marketId)?.buffered ?? null;
  }

  function consumeResolution(market) {
    const marketId = marketIdForRead(market);
    if (marketId === null) return null;
    const watcher = watchers.get(marketId);
    if (!watcher?.buffered) return null;
    const buffered = watcher.buffered;
    watcher.buffered = null;
    return buffered;
  }

  function unwatchMarket(market) {
    const marketId = marketIdForRead(market);
    if (marketId === null) return false;
    const watcher = watchers.get(marketId);
    if (!watcher) return false;
    watchers.delete(marketId);
    clearReconnect(watcher);
    const candidate = watcher.socket;
    watcher.socket = null;
    watcher.connected = false;
    const cleanup = watcher.unbindSocket;
    watcher.unbindSocket = null;
    watcher.buffered = null;
    guardedClose(candidate, cleanup, watcher);
    return true;
  }

  function stop() {
    const hadWork = started || watchers.size > 0 || closingSockets.size > 0;
    started = false;
    const active = [...watchers.values()];
    watchers.clear();
    for (const watcher of active) {
      clearReconnect(watcher);
      const candidate = watcher.socket;
      watcher.socket = null;
      watcher.connected = false;
      const cleanup = watcher.unbindSocket;
      watcher.unbindSocket = null;
      watcher.buffered = null;
      guardedClose(candidate, cleanup, watcher);
    }
    return hadWork;
  }

  function getState() {
    const values = [...watchers.values()];
    return Object.freeze({
      started,
      watchedMarketIds: Object.freeze(values.map((watcher) => watcher.identity.marketId)),
      connectedMarketIds: Object.freeze(values.filter((watcher) => watcher.connected).map((watcher) => watcher.identity.marketId)),
      resolvedMarketIds: Object.freeze(values.filter((watcher) => watcher.resolved).map((watcher) => watcher.identity.marketId)),
      bufferedMarketIds: Object.freeze(values.filter((watcher) => watcher.buffered !== null).map((watcher) => watcher.identity.marketId)),
      reconnectScheduledMarketIds: Object.freeze(values.filter((watcher) => watcher.reconnectTimer !== null).map((watcher) => watcher.identity.marketId)),
      socketCount: values.filter((watcher) => watcher.socket !== null).length,
      teardownSocketCount: closingSockets.size,
      lastError,
    });
  }

  return Object.freeze({
    start,
    stop,
    watchMarket,
    unwatchMarket,
    getResolution,
    consumeResolution,
    getState,
  });
}
