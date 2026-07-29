import WebSocket from 'ws';
import { getShortTermMarkets } from "./polymarket.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "..", "tracker_config.json");

// Simpan data paus di memori (RAM)
let recentWhales = [];
const MAX_WHALES_STORED = 200;

// Tracker for trending markets
const marketTrades = new Map(); // market_id -> [timestamp1, timestamp2, ...]
export let marketMap = {}; // Hoisted to module level
const notifiedHotNiches = new Set();

// State untuk ON/OFF Sniffer. Importing this module must not start the tracker.
let isSnifferActive = false;
let notifyCallback = null;
let snifferStartTime = 0; // Kapan sniffer dinyalakan (timestamp)

export let snifferMinUsd = 1000; // Default minimum whale size
export let trackedWallets = new Map([
  ["0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3".toLowerCase(), "Coinman2"]
]);

// Load config dari file (jika ada)
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    if (typeof data.minUsd === "number") snifferMinUsd = data.minUsd;
    if (Array.isArray(data.wallets)) {
      trackedWallets.clear();
      for (const w of data.wallets) {
        if (w && w.address) trackedWallets.set(w.address.toLowerCase(), w.nickname || "");
      }
    }
    console.log(`[Sniffer] Loaded config from file: minUsd=$${snifferMinUsd}, trackedWallets=${trackedWallets.size}`);
  } else {
    console.log(`[Sniffer] No tracker_config.json found. Using defaults.`);
  }
} catch (e) {
  console.error("[Sniffer] Error loading config:", e.message);
}

function saveConfigToFile() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      minUsd: snifferMinUsd,
      wallets: Array.from(trackedWallets.entries()).map(([address, nickname]) => ({ address, nickname }))
    }, null, 2));
  } catch (e) {
    console.error("[Sniffer] Error saving config:", e.message);
  }
}

export function getTrackerConfig() {
  return {
    minUsd: snifferMinUsd,
    wallets: Array.from(trackedWallets.entries()).map(([address, nickname]) => ({ address, nickname }))
  };
}

export function setTrackerConfig(minUsd, walletsArray) {
  if (typeof minUsd === 'number') snifferMinUsd = minUsd;
  if (Array.isArray(walletsArray)) {
    trackedWallets.clear();
    for (const w of walletsArray) {
      if (w && w.address) {
        trackedWallets.set(w.address.toLowerCase(), w.nickname || "");
      }
    }
  }
  saveConfigToFile();
}

export function setSnifferState(state) {
  if (!state) {
    stopSniffer();
    return Promise.resolve(false);
  }
  return startSniffer().then(() => getSnifferState());
}

export function getSnifferState() {
  return isSnifferActive;
}

export function getSnifferStartTime() {
  return snifferStartTime;
}

// Aggressive Mode (No NETRAL) — forces UP or DOWN, never =
let aggressiveModeEnabled = false;

export function setAggressiveMode(enabled) {
  aggressiveModeEnabled = !!enabled;
}

export function getAggressiveMode() {
  return aggressiveModeEnabled;
}

export function setNotificationCallback(fn) {
  notifyCallback = fn;
}

export function pushWhaleEvent(whaleObj) {
  recentWhales.unshift(whaleObj);
  if (recentWhales.length > MAX_WHALES_STORED) {
    recentWhales.pop();
  }
  notifySafely(whaleObj, "tracked-wallet-notify");
}

let currentTimeframeFilter = "all";
let globalAccumulatedWhaleVolume = {
  btc:  { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } },
  eth:  { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } },
  doge: { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } },
  all:  { "5m": { UP: 0, DOWN: 0 }, "15m": { UP: 0, DOWN: 0 }, "1h": { UP: 0, DOWN: 0 }, "4h": { UP: 0, DOWN: 0 }, "1d": { UP: 0, DOWN: 0 } }
};

export function setTimeframeFilter(tf) {
  // Hardcoded to "all", filter happens in frontend
  currentTimeframeFilter = "all";
  cacheTimestamp = 0; // Force refresh
}

export function getTimeframeFilter() {
  return currentTimeframeFilter;
}

export function getAccumulatedWhaleVolume() {
  return globalAccumulatedWhaleVolume;
}

const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MARKET_RETRY_MS = 15000;
const SHARD_SIZE = 500;
const SUBSCRIPTION_CHUNK_SIZE = 50;
const SUBSCRIPTION_CHUNK_DELAY_MS = 250;
const PING_INTERVAL_MS = 10000;
export const SNIFFER_STALE_AFTER_MS = 35000;
export const TRADE_AGGREGATION_WINDOW_MS = 5000;
export const GENERAL_ALERT_MIN_SECONDS_TO_END = 60;
const SNIFFER_MAX_RECONNECT_DELAY = 30000;
const LOG_RATE_LIMIT_MS = 60000;

let cachedClobIds = [];
let cacheTimestamp = 0;
let snifferGeneration = 0;
let snifferIsConnecting = false;
let snifferConnectPromise = null;
let snifferPingInterval = null;
let snifferRefreshInterval = null;
let snifferMarketRetryTimer = null;
let snifferExpectedShards = 0;
let snifferExpectedTokens = 0;
let snifferReconnectCount = 0;
let snifferErrorCount = 0;
let snifferParserErrorCount = 0;
let snifferLastError = null;
const snifferShards = new Map();
const tradeAggregations = new Map();
const lastLogAt = new Map();
const snifferAuxTimers = new Set();

const EVENT_COUNTER_FIELDS = [
  "received",
  "filteredPrice",
  "filteredExpiry",
  "belowThreshold",
  "emitted",
  "updated",
  "duplicateSuppressed",
];

function emptyEventCounter() {
  return Object.fromEntries(EVENT_COUNTER_FIELDS.map((field) => [field, 0]));
}

const snifferEventCounters = { ...emptyEventCounter(), perAsset: {} };

function safeErrorMessage(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, "[redacted endpoint]")
    .slice(0, 300);
}

function logRateLimited(key, level, message) {
  const now = Date.now();
  if (now - (lastLogAt.get(key) || 0) < LOG_RATE_LIMIT_MS) return;
  lastLogAt.set(key, now);
  console[level](message);
}

function recordSnifferError(error, { shard = null, category = "general" } = {}) {
  const message = safeErrorMessage(error);
  snifferErrorCount += 1;
  snifferLastError = message;
  if (category === "parser") snifferParserErrorCount += 1;
  if (shard) {
    shard.errorCount += 1;
    shard.lastError = message;
  }
  logRateLimited(
    `${category}:${shard?.id || "global"}`,
    category === "parser" ? "warn" : "error",
    `[Sniffer${shard ? ` Shard ${shard.id}` : ""}] ${category} error (${snifferErrorCount} total): ${message}`,
  );
}

function incrementEventCounter(field, asset = "unknown") {
  snifferEventCounters[field] += 1;
  const key = String(asset || "unknown").toLowerCase();
  if (!snifferEventCounters.perAsset[key]) snifferEventCounters.perAsset[key] = emptyEventCounter();
  snifferEventCounters.perAsset[key][field] += 1;
}

export function getSnifferEventCounters() {
  return {
    ...Object.fromEntries(EVENT_COUNTER_FIELDS.map((field) => [field, snifferEventCounters[field]])),
    perAsset: Object.fromEntries(
      Object.entries(snifferEventCounters.perAsset).map(([asset, counters]) => [asset, { ...counters }]),
    ),
  };
}

export function evaluateGeneralTrade({ price, endDate, now = Date.now(), minSecondsToEnd = GENERAL_ALERT_MIN_SECONDS_TO_END }) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice <= 0.10 || numericPrice >= 0.90) {
    return { accepted: false, reason: "price" };
  }
  const endTime = new Date(endDate).getTime();
  if (!Number.isFinite(endTime) || endTime - now < minSecondsToEnd * 1000) {
    return { accepted: false, reason: "expiry" };
  }
  return { accepted: true, reason: null };
}

export function aggregateTradeFill(aggregationMap, fill, {
  now = Date.now(),
  windowMs = TRADE_AGGREGATION_WINDOW_MS,
  minUsd = 1000,
} = {}) {
  if (!(aggregationMap instanceof Map)) throw new TypeError("aggregationMap must be a Map");
  const aggregationId = fill.transactionHash || fill.fillId;
  const key = [aggregationId || `single:${now}`, fill.market, fill.outcome, fill.side]
    .map((value) => String(value || "UNKNOWN"))
    .join("|");
  const cutoff = now - windowMs;
  const previous = aggregationMap.get(key);
  const entry = previous || { fills: [], seenFillIds: new Set(), firstAt: now, lastEmittedAt: null, emittedSizeUsdc: 0 };
  if (!(entry.seenFillIds instanceof Set)) entry.seenFillIds = new Set();
  if (entry.lastEmittedAt !== null && now - entry.lastEmittedAt >= windowMs) {
    return {
      status: "duplicateSuppressed",
      aggregation: { key, sizeUsdc: 0, price: Number(fill.price), fillCount: 0, windowMs, timestamp: now },
    };
  }
  if (entry.lastEmittedAt === null && entry.firstAt < cutoff) {
    entry.fills = [];
    entry.seenFillIds.clear();
    entry.firstAt = now;
  }
  const fillId = String(fill.fillId || `${now}:${fill.sizeUsdc}:${fill.price}`);
  if (entry.seenFillIds.has(fillId)) {
    return {
      status: "duplicateSuppressed",
      aggregation: { key, sizeUsdc: entry.emittedSizeUsdc, price: Number(fill.price), fillCount: entry.fills.length, windowMs, timestamp: now },
    };
  }
  entry.seenFillIds.add(fillId);
  entry.fills.push({
    id: fillId,
    timestamp: now,
    sizeUsdc: Number(fill.sizeUsdc),
    price: Number(fill.price),
  });
  aggregationMap.set(key, entry);

  const sizeUsdc = entry.fills.reduce((sum, item) => sum + item.sizeUsdc, 0);
  const weightedPrice = sizeUsdc > 0
    ? entry.fills.reduce((sum, item) => sum + item.price * item.sizeUsdc, 0) / sizeUsdc
    : 0;
  const aggregation = {
    key,
    sizeUsdc,
    price: weightedPrice,
    fillCount: entry.fills.length,
    windowMs,
    timestamp: now,
    deltaSizeUsdc: entry.lastEmittedAt === null ? sizeUsdc : sizeUsdc - entry.emittedSizeUsdc,
  };

  if (entry.lastEmittedAt !== null) {
    entry.emittedSizeUsdc = sizeUsdc;
    return { status: "updated", aggregation };
  }
  if (!Number.isFinite(sizeUsdc) || sizeUsdc < minUsd) {
    return { status: "belowThreshold", aggregation };
  }
  entry.lastEmittedAt = now;
  entry.emittedSizeUsdc = sizeUsdc;
  return { status: "emitted", aggregation };
}

export function extractLivePriceUpdates(message) {
  if (!message || typeof message !== "object") return [];
  const updates = [];
  const add = (assetId, price) => {
    if (price == null || (typeof price === "string" && !price.trim())) return;
    const numericPrice = Number(price);
    if (assetId != null && Number.isFinite(numericPrice) && numericPrice > 0 && numericPrice <= 1) {
      updates.push({ assetId: String(assetId), price: numericPrice });
    }
  };

  const midpoint = (bid, ask) => {
    const numericBid = Number(bid);
    const numericAsk = Number(ask);
    if (Number.isFinite(numericBid) && Number.isFinite(numericAsk) && numericBid > 0 && numericAsk > numericBid) {
      return (numericBid + numericAsk) / 2;
    }
    return null;
  };
  if (message.event_type === "price_change") {
    if (Array.isArray(message.price_changes)) {
      for (const change of message.price_changes) {
        add(change?.asset_id, midpoint(change?.best_bid, change?.best_ask) ?? change?.last_trade_price);
      }
    }
    add(message.asset_id, midpoint(message.best_bid, message.best_ask) ?? message.last_trade_price);
  } else if (message.event_type === "book" && message.asset_id) {
    const bids = (Array.isArray(message.bids) ? message.bids : []).map((level) => Number(level?.price)).filter(Number.isFinite);
    const asks = (Array.isArray(message.asks) ? message.asks : []).map((level) => Number(level?.price)).filter(Number.isFinite);
    add(message.asset_id, midpoint(bids.length ? Math.max(...bids) : null, asks.length ? Math.min(...asks) : null));
  } else if (message.event_type === "last_trade_price") {
    add(message.asset_id, message.price);
  }
  return updates;
}

function latestTimestamp(values) {
  const timestamps = values.filter((value) => Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function deriveSnifferHealth(snapshot, now = Date.now(), staleAfterMs = SNIFFER_STALE_AFTER_MS) {
  const shards = (snapshot.shards || []).map((shard) => ({
    id: Number(shard.id),
    state: String(shard.state || "PENDING"),
    expectedTokens: Number(shard.expectedTokens || 0),
    subscribedTokens: Number(shard.subscribedTokens || 0),
    lastMessageAt: Number.isFinite(shard.lastMessageAt) ? shard.lastMessageAt : null,
    lastPongAt: Number.isFinite(shard.lastPongAt) ? shard.lastPongAt : null,
    lastTradeAt: Number.isFinite(shard.lastTradeAt) ? shard.lastTradeAt : null,
    reconnectCount: Number(shard.reconnectCount || 0),
    errorCount: Number(shard.errorCount || 0),
    lastError: shard.lastError ? String(shard.lastError) : null,
  }));
  const expectedShards = Number(snapshot.expectedShards || 0);
  const expectedTokens = Number(snapshot.expectedTokens || 0);
  const connectedShards = shards.filter((shard) => shard.state === "OPEN").length;
  const subscribedTokens = shards.reduce((sum, shard) => sum + shard.subscribedTokens, 0);
  const staleShards = shards.filter((shard) => {
    if (shard.state !== "OPEN") return false;
    const lastSeenAt = latestTimestamp([shard.lastMessageAt, shard.lastPongAt]);
    return lastSeenAt === null || now - lastSeenAt > staleAfterMs;
  }).length;
  const fullyCovered = expectedShards > 0
    && connectedShards === expectedShards
    && subscribedTokens === expectedTokens
    && shards.every((shard) => shard.expectedTokens === shard.subscribedTokens)
    && staleShards === 0;

  let state;
  if (!snapshot.active) state = "OFFLINE";
  else if (fullyCovered) state = "CONNECTED";
  else if (connectedShards > 0) state = "DEGRADED";
  else if (snapshot.isConnecting || shards.some((shard) => ["PENDING", "CONNECTING", "SUBSCRIBING"].includes(shard.state))) {
    state = "CONNECTING";
  } else {
    state = "RECONNECTING";
  }

  return {
    state,
    active: Boolean(snapshot.active),
    expectedShards,
    connectedShards,
    subscribedTokens,
    expectedTokens,
    staleShards,
    lastMessageAt: latestTimestamp(shards.map((shard) => shard.lastMessageAt)),
    lastPongAt: latestTimestamp(shards.map((shard) => shard.lastPongAt)),
    lastTradeAt: latestTimestamp(shards.map((shard) => shard.lastTradeAt)),
    reconnectCount: Number(snapshot.reconnectCount || 0),
    errorCount: Number(snapshot.errorCount || 0),
    parserErrorCount: Number(snapshot.parserErrorCount || 0),
    lastError: snapshot.lastError ? String(snapshot.lastError) : null,
    shards,
  };
}

async function fetchAndCacheMarkets(force = false, generation = snifferGeneration) {
  const now = Date.now();
  if (!force && cachedClobIds.length > 0 && now - cacheTimestamp < CACHE_TTL_MS) return true;
  try {
    const [btc, eth, doge] = await Promise.all([
      getShortTermMarkets("btc"),
      getShortTermMarkets("eth"),
      getShortTermMarkets("doge"),
    ]);
    const allShorts = [];
    const maxLen = Math.max(btc.length, eth.length, doge.length);
    for (let i = 0; i < maxLen; i++) {
      if (btc[i]) allShorts.push(btc[i]);
      if (eth[i]) allShorts.push(eth[i]);
      if (doge[i]) allShorts.push(doge[i]);
    }
    const filteredShorts = currentTimeframeFilter === "all"
      ? allShorts
      : allShorts.filter((market) => market.duration_type === currentTimeframeFilter);

    if (!isSnifferActive || generation !== snifferGeneration) return false;
    cachedClobIds = [...new Set(
      filteredShorts.flatMap((market) => market.clobTokenIds || []).filter(Boolean).map(String),
    )];
    marketMap = {};
    for (const market of filteredShorts) {
      if (!market.conditionId) continue;
      marketMap[market.conditionId] = {
        id: market.id,
        question: market.question,
        slug: market.eventSlug || market.slug || "",
        duration_type: market.duration_type || "",
        asset: market.asset || "unknown",
        endDate: market.endDate || "",
        clobTokenIds: (market.clobTokenIds || []).map(String),
      };
    }
    cacheTimestamp = now;
    if (!global.livePrices) global.livePrices = {};
    if (!global.livePriceTimestamps) global.livePriceTimestamps = {};
    const activeIds = new Set(cachedClobIds);
    for (const assetId of Object.keys(global.livePrices)) {
      if (!activeIds.has(assetId)) {
        delete global.livePrices[assetId];
        delete global.livePriceTimestamps[assetId];
      }
    }
    const aggregationCutoff = now - TRADE_AGGREGATION_WINDOW_MS;
    for (const [key, entry] of tradeAggregations) {
      const latestFillAt = Math.max(0, ...(entry.fills || []).map((fill) => fill.timestamp), entry.lastEmittedAt || 0);
      if (latestFillAt < aggregationCutoff) tradeAggregations.delete(key);
    }
    console.log(`[Sniffer] Market cache updated: ${allShorts.length} markets, ${cachedClobIds.length} tokens.`);
    return true;
  } catch (error) {
    recordSnifferError(error, { category: "market-fetch" });
    return cachedClobIds.length > 0;
  }
}

function clearShardTimers(shard) {
  for (const timer of shard.timers) clearTimeout(timer);
  shard.timers.clear();
}

function scheduleShardTask(shard, task, delay) {
  const timer = setTimeout(() => {
    shard.timers.delete(timer);
    if (!isSnifferActive || shard.generation !== snifferGeneration || snifferShards.get(shard.id) !== shard) return;
    task();
  }, delay);
  shard.timers.add(timer);
  return timer;
}

function closeShard(shard, reason = "Sniffer stopped") {
  clearShardTimers(shard);
  shard.intentionalClose = true;
  shard.state = "CLOSED";
  const ws = shard.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  try {
    ws.close(1000, reason);
  } catch {
    ws.terminate();
  }
}

function clearLifecycleTimers() {
  if (snifferPingInterval) clearInterval(snifferPingInterval);
  if (snifferRefreshInterval) clearInterval(snifferRefreshInterval);
  if (snifferMarketRetryTimer) clearTimeout(snifferMarketRetryTimer);
  snifferPingInterval = null;
  snifferRefreshInterval = null;
  snifferMarketRetryTimer = null;
  for (const timer of snifferAuxTimers) clearTimeout(timer);
  snifferAuxTimers.clear();
  notifiedHotNiches.clear();
}

function closeAllShards(reason) {
  for (const shard of snifferShards.values()) closeShard(shard, reason);
  snifferShards.clear();
}

function scheduleShardReconnect(shard) {
  if (!isSnifferActive || shard.generation !== snifferGeneration || shard.intentionalClose) return;
  clearShardTimers(shard);
  const delay = shard.reconnectDelay;
  shard.state = "RECONNECTING";
  shard.reconnectCount += 1;
  snifferReconnectCount += 1;
  console.warn(`[Sniffer Shard ${shard.id}] Reconnecting in ${delay / 1000}s.`);
  scheduleShardTask(shard, () => openSnifferShard(shard), delay);
  shard.reconnectDelay = Math.min(delay * 2, SNIFFER_MAX_RECONNECT_DELAY);
}

function sendSubscriptionChunks(shard, ws, offset = 0) {
  if (!isSnifferActive || shard.generation !== snifferGeneration || shard.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
  if (offset >= shard.ids.length) {
    shard.state = "OPEN";
    shard.reconnectDelay = 2000;
    console.log(`[Sniffer Shard ${shard.id}] Subscribed to ${shard.subscribedTokens}/${shard.expectedTokens} tokens.`);
    return;
  }

  const ids = shard.ids.slice(offset, offset + SUBSCRIPTION_CHUNK_SIZE);
  const frame = offset === 0
    ? { assets_ids: ids, type: "market" }
    : { assets_ids: ids, operation: "subscribe" };
  ws.send(JSON.stringify(frame), (error) => {
    if (error) {
      recordSnifferError(error, { shard, category: "subscription" });
      if (ws.readyState === WebSocket.OPEN) ws.close();
      return;
    }
    if (!isSnifferActive || shard.generation !== snifferGeneration || shard.ws !== ws) return;
    shard.subscribedTokens += ids.length;
    scheduleShardTask(
      shard,
      () => sendSubscriptionChunks(shard, ws, offset + SUBSCRIPTION_CHUNK_SIZE),
      SUBSCRIPTION_CHUNK_DELAY_MS,
    );
  });
}

function notifySafely(payload, category) {
  if (!notifyCallback) return;
  try {
    Promise.resolve(notifyCallback(payload)).catch((error) => recordSnifferError(error, { category }));
  } catch (error) {
    recordSnifferError(error, { category });
  }
}

function emitGeneralWhale(message) {
  const now = Date.now();
  const marketInfo = marketMap[message.market] || {
    id: "Unknown",
    question: "Unknown Market",
    slug: "",
    duration_type: "",
    asset: "unknown",
    endDate: "",
    clobTokenIds: [],
  };
  const asset = marketInfo.asset || "unknown";
  incrementEventCounter("received", asset);

  const price = Number(message.price);
  const shares = Number(message.size);
  const sizeUsdc = shares * price;
  const filter = evaluateGeneralTrade({ price, endDate: marketInfo.endDate, now });
  if (!filter.accepted) {
    incrementEventCounter(filter.reason === "price" ? "filteredPrice" : "filteredExpiry", asset);
    return;
  }
  if (!Number.isFinite(sizeUsdc) || sizeUsdc <= 0) {
    incrementEventCounter("belowThreshold", asset);
    return;
  }

  let outcome = "UNKNOWN";
  if (marketInfo.clobTokenIds.length >= 2) {
    if (String(message.asset_id) === marketInfo.clobTokenIds[0]) outcome = "UP";
    else if (String(message.asset_id) === marketInfo.clobTokenIds[1]) outcome = "DOWN";
  }
  const side = String(message.side || "UNKNOWN").toUpperCase();
  const flowDirection = (side === "BUY" && outcome === "UP") || (side === "SELL" && outcome === "DOWN")
    ? "UP"
    : (side === "BUY" && outcome === "DOWN") || (side === "SELL" && outcome === "UP")
      ? "DOWN"
      : null;
  const aggregateResult = aggregateTradeFill(tradeAggregations, {
    market: message.market,
    outcome,
    side,
    sizeUsdc,
    price,
    transactionHash: message.transaction_hash || message.transactionHash || null,
    fillId: message.trade_id || message.id || `${message.asset_id}:${message.timestamp || now}:${message.size}:${message.price}`,
  }, { now, minUsd: snifferMinUsd });
  if (aggregateResult.status === "updated") {
    incrementEventCounter("updated", asset);
    const existingWhale = recentWhales.find((whale) => whale.aggregationKey === aggregateResult.aggregation.key);
    if (existingWhale) {
      const delta = Math.max(0, aggregateResult.aggregation.deltaSizeUsdc || 0);
      existingWhale.sizeUsdc = aggregateResult.aggregation.sizeUsdc;
      existingWhale.price = aggregateResult.aggregation.price;
      existingWhale.fillCount = aggregateResult.aggregation.fillCount;
      existingWhale.timestamp = now;
      const duration = marketInfo.duration_type;
      if (delta > 0 && duration && flowDirection) {
        if (globalAccumulatedWhaleVolume.all[duration]) globalAccumulatedWhaleVolume.all[duration][flowDirection] += delta;
        if (globalAccumulatedWhaleVolume[asset]?.[duration]) globalAccumulatedWhaleVolume[asset][duration][flowDirection] += delta;
      }
    }
    return;
  }
  if (aggregateResult.status !== "emitted") {
    incrementEventCounter(aggregateResult.status, asset);
    return;
  }
  incrementEventCounter("emitted", asset);

  const maker = String(message.maker || message.makerAddress || "Hidden");
  const whaleObj = {
    market_id: marketInfo.id,
    market_question: marketInfo.question,
    market_slug: marketInfo.slug,
    duration_type: marketInfo.duration_type,
    asset,
    outcome,
    flowDirection,
    sizeUsdc: aggregateResult.aggregation.sizeUsdc,
    price: aggregateResult.aggregation.price,
    side,
    maker,
    timestamp: now,
    isTracked: false,
    wallet_nickname: "",
    fillCount: aggregateResult.aggregation.fillCount,
    aggregationWindowMs: aggregateResult.aggregation.windowMs,
    aggregationKey: aggregateResult.aggregation.key,
  };

  if (marketInfo.duration_type && outcome !== "UNKNOWN") {
    const duration = marketInfo.duration_type;
    const flowDirection = whaleObj.flowDirection;
    if (flowDirection && globalAccumulatedWhaleVolume.all[duration]) globalAccumulatedWhaleVolume.all[duration][flowDirection] += whaleObj.sizeUsdc;
    if (flowDirection && globalAccumulatedWhaleVolume[asset]?.[duration]) globalAccumulatedWhaleVolume[asset][duration][flowDirection] += whaleObj.sizeUsdc;
  }
  recentWhales.unshift(whaleObj);
  if (recentWhales.length > MAX_WHALES_STORED) recentWhales.length = MAX_WHALES_STORED;

  if (!marketTrades.has(message.market)) marketTrades.set(message.market, []);
  marketTrades.get(message.market).push(now);
  const cutoff = now - 15 * 60 * 1000;
  const recentTradesForMarket = marketTrades.get(message.market).filter((timestamp) => timestamp > cutoff);
  marketTrades.set(message.market, recentTradesForMarket);

  if (recentTradesForMarket.length >= 4 && !notifiedHotNiches.has(message.market)) {
    notifiedHotNiches.add(message.market);
    const timer = setTimeout(() => {
      snifferAuxTimers.delete(timer);
      notifiedHotNiches.delete(message.market);
    }, 60 * 60 * 1000);
    snifferAuxTimers.add(timer);
    timer.unref?.();
    notifySafely({
      type: "HOT_NICHE",
      marketInfo,
      recentTradesCount: recentTradesForMarket.length,
      triggerWhale: whaleObj,
    }, "hot-niche-notify");
  }

  const icon = side === "BUY" ? "🟢" : (side === "SELL" ? "🔴" : "🔵");
  const sizeStr = "$" + whaleObj.sizeUsdc.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const walletShort = maker === "Hidden" ? "Anonymous" : `${maker.slice(0, 6)}...${maker.slice(-4)}`;
  let text = `🚨 *LIVE WHALE ALERT* 🚨\n\n`;
  text += `${icon} *${sizeStr}* (${side} @ ${whaleObj.price.toFixed(3)})\n`;
  text += `📊 Market: ${whaleObj.market_question}\n`;
  text += `👤 Wallet: ${maker === "Hidden" ? "`Anonymous`" : `[${walletShort}](https://polymarket.com/profile/${maker})`}\n`;
  notifySafely(text, "whale-notify");
}

function handleShardMessage(shard, data) {
  const raw = data.toString();
  const now = Date.now();
  shard.lastMessageAt = now;
  if (raw.trim().toUpperCase() === "PONG") {
    shard.lastPongAt = now;
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    recordSnifferError(error, { shard, category: "parser" });
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (!global.livePrices) global.livePrices = {};
    if (!global.livePriceTimestamps) global.livePriceTimestamps = {};
  for (const message of messages) {
    try {
      for (const update of extractLivePriceUpdates(message)) {
        global.livePrices[update.assetId] = update.price;
        global.livePriceTimestamps[update.assetId] = now;
      }
      if (message?.event_type === "last_trade_price") {
        shard.lastTradeAt = now;
        if (isSnifferActive && message.asset_id && message.market) emitGeneralWhale(message);
      }
    } catch (error) {
      recordSnifferError(error, { shard, category: "parser" });
    }
  }
}

function openSnifferShard(shard) {
  if (!isSnifferActive || shard.generation !== snifferGeneration || snifferShards.get(shard.id) !== shard) return;
  if (shard.ws && [WebSocket.CONNECTING, WebSocket.OPEN].includes(shard.ws.readyState)) return;
  clearShardTimers(shard);
  shard.intentionalClose = false;
  shard.state = "CONNECTING";
  shard.subscribedTokens = 0;
  const ws = new WebSocket(CLOB_WS_URL, { handshakeTimeout: 15000 });
  shard.ws = ws;

  ws.on("open", () => {
    if (!isSnifferActive || shard.generation !== snifferGeneration || shard.ws !== ws) {
      ws.close(1000, "Stale sniffer generation");
      return;
    }
    shard.state = "SUBSCRIBING";
    shard.openedAt = Date.now();
    console.log(`[Sniffer Shard ${shard.id}] Connected; subscribing to ${shard.expectedTokens} tokens.`);
    sendSubscriptionChunks(shard, ws);
  });
  ws.on("message", (data) => {
    if (isSnifferActive && shard.generation === snifferGeneration && shard.ws === ws) {
      handleShardMessage(shard, data);
    }
  });
  ws.on("pong", () => {
    if (shard.generation === snifferGeneration && shard.ws === ws) shard.lastPongAt = Date.now();
  });
  ws.on("error", (error) => {
    if (!shard.intentionalClose) recordSnifferError(error, { shard, category: "websocket" });
  });
  ws.on("close", (code) => {
    if (shard.ws !== ws) return;
    shard.ws = null;
    shard.subscribedTokens = 0;
    if (!isSnifferActive || shard.intentionalClose || shard.generation !== snifferGeneration) {
      shard.state = "CLOSED";
      return;
    }
    console.warn(`[Sniffer Shard ${shard.id}] Closed with code ${code}.`);
    scheduleShardReconnect(shard);
  });
}

function heartbeatShards() {
  const now = Date.now();
  for (const shard of snifferShards.values()) {
    const ws = shard.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    const lastSeenAt = latestTimestamp([shard.lastMessageAt, shard.lastPongAt]);
    if (shard.openedAt && now - shard.openedAt > SNIFFER_STALE_AFTER_MS
      && (lastSeenAt === null || now - lastSeenAt > SNIFFER_STALE_AFTER_MS)) {
      recordSnifferError("CLOB shard heartbeat became stale", { shard, category: "stale" });
      ws.terminate();
      continue;
    }
    ws.send("PING", (error) => {
      if (error && !shard.intentionalClose) recordSnifferError(error, { shard, category: "heartbeat" });
    });
  }
}

async function refreshMarkets(generation) {
  const previousIds = cachedClobIds.join("|");
  const refreshed = await fetchAndCacheMarkets(true, generation);
  if (!refreshed || !isSnifferActive || generation !== snifferGeneration) return;
  if (cachedClobIds.join("|") !== previousIds) {
    console.log("[Sniffer] Market token set changed; rebuilding shard subscriptions.");
    await connectSnifferWs();
  }
}

function startLifecycleIntervals(generation) {
  snifferPingInterval = setInterval(() => {
    if (isSnifferActive && generation === snifferGeneration) heartbeatShards();
  }, PING_INTERVAL_MS);
  snifferRefreshInterval = setInterval(() => {
    if (isSnifferActive && generation === snifferGeneration) {
      refreshMarkets(generation).catch((error) => recordSnifferError(error, { category: "market-refresh" }));
    }
  }, CACHE_TTL_MS);
}

async function connectSnifferWs() {
  if (!isSnifferActive) return;
  if (snifferConnectPromise) {
    try {
      await snifferConnectPromise;
    } catch (error) {
      recordSnifferError(error, { category: "connect" });
    }
    return;
  }

  const generation = ++snifferGeneration;
  snifferIsConnecting = true;
  clearLifecycleTimers();
  closeAllShards("Refreshing sniffer subscriptions");
  snifferExpectedShards = 0;
  snifferExpectedTokens = 0;

  const connectionTask = (async () => {
    await fetchAndCacheMarkets(false, generation);
    if (!isSnifferActive || generation !== snifferGeneration) return;
    if (cachedClobIds.length === 0) {
      logRateLimited("no-market-ids", "warn", `[Sniffer] No market token IDs available; retrying in ${MARKET_RETRY_MS / 1000}s.`);
      snifferMarketRetryTimer = setTimeout(() => {
        snifferMarketRetryTimer = null;
        if (!isSnifferActive || generation !== snifferGeneration) return;
        snifferReconnectCount += 1;
        connectSnifferWs().catch((error) => recordSnifferError(error, { category: "market-retry" }));
      }, MARKET_RETRY_MS);
      return;
    }

    snifferExpectedTokens = cachedClobIds.length;
    snifferExpectedShards = Math.ceil(cachedClobIds.length / SHARD_SIZE);
    console.log(`[Sniffer] Connecting ${snifferExpectedShards} CLOB shard(s).`);
    for (let index = 0; index < snifferExpectedShards; index++) {
      const ids = cachedClobIds.slice(index * SHARD_SIZE, (index + 1) * SHARD_SIZE);
      const shard = {
        id: index + 1,
        generation,
        ids,
        expectedTokens: ids.length,
        subscribedTokens: 0,
        state: "PENDING",
        ws: null,
        timers: new Set(),
        intentionalClose: false,
        openedAt: null,
        lastMessageAt: null,
        lastPongAt: null,
        lastTradeAt: null,
        reconnectCount: 0,
        reconnectDelay: 2000,
        errorCount: 0,
        lastError: null,
      };
      snifferShards.set(shard.id, shard);
      scheduleShardTask(shard, () => openSnifferShard(shard), index * 1000);
    }
    startLifecycleIntervals(generation);
  })();
  snifferConnectPromise = connectionTask;

  try {
    await connectionTask;
  } catch (error) {
    recordSnifferError(error, { category: "connect" });
  } finally {
    if (generation === snifferGeneration) snifferIsConnecting = false;
    if (snifferConnectPromise === connectionTask) snifferConnectPromise = null;
  }
}

export async function startSniffer() {
  if (isSnifferActive) {
    if (snifferConnectPromise) await connectSnifferWs();
    else if (snifferExpectedShards === 0 && !snifferIsConnecting) await connectSnifferWs();
    return getSnifferWsStatus();
  }
  isSnifferActive = true;
  snifferStartTime = Date.now();
  console.log("[Sniffer] Starting live CLOB tracker.");
  await connectSnifferWs();
  return getSnifferWsStatus();
}

export function stopSniffer() {
  if (!isSnifferActive && snifferShards.size === 0) return getSnifferWsStatus();
  isSnifferActive = false;
  snifferStartTime = 0;
  snifferGeneration += 1;
  snifferIsConnecting = false;
  snifferConnectPromise = null;
  clearLifecycleTimers();
  closeAllShards("Sniffer disabled");
  tradeAggregations.clear();
  snifferExpectedShards = 0;
  snifferExpectedTokens = 0;
  return getSnifferWsStatus();
}

export function getRecentWhales(minSizeUsdc = 0) {
  // Return recentWhales without overriding the stored min limit, 
  // since we already filter them during capture. 
  // However, we still allow filtering them down further if requested.
  return recentWhales.filter(w => w.sizeUsdc >= minSizeUsdc || w.isTracked);
}

export function getTrendingMarkets(limit = 5, windowMinutes = 15) {
  const cutoff = Date.now() - (windowMinutes * 60 * 1000);
  const trending = [];
  
  for (const [marketId, timestamps] of marketTrades.entries()) {
    // Clean old timestamps to prevent memory leak and keep data fresh
    const recent = timestamps.filter(ts => ts > cutoff);
    if (recent.length > 0) {
      marketTrades.set(marketId, recent);
      const marketInfo = marketMap[marketId] || { question: "Unknown Market", slug: "" };
      trending.push({
        market_id: marketId,
        question: marketInfo.question,
        slug: marketInfo.slug,
        count: recent.length
      });
    } else {
      marketTrades.delete(marketId);
    }
  }
  
  return trending.sort((a, b) => b.count - a.count).slice(0, limit);
}

export function formatSnifferWhales(whales, minSizeUsdc) {
  if (!isSnifferActive) {
    return `⏸️ *SNIFFER SEDANG NONAKTIF*\n\n_Ketik /sniffer on untuk mengaktifkan pemantauan paus secara real-time._`;
  }

  if (!whales || whales.length === 0) {
    return `🐋 *[LIVE SNIFFER AKTIF]*\nTidak ada paus ≥ $${minSizeUsdc.toLocaleString()} tertangkap sejak fitur dinyalakan.\n\n_Bot terus memantau 50 market teratas secara real-time._`;
  }

  let text = `🐋 *LIVE WHALE TRACKER* (≥ $${minSizeUsdc.toLocaleString()})\n`;
  text += `_Disadap langsung dari Polymarket WebSocket_\n\n`;

  for (const w of whales.slice(0, 15)) {
    const size = w.sizeUsdc != null && Number.isFinite(Number(w.sizeUsdc))
      ? "$" + Number(w.sizeUsdc).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
      : "N/A";
    const walletShort = w.maker === "Hidden" ? "Anonymous" : `${w.maker.slice(0, 6)}...${w.maker.slice(-4)}`;
    const timeAgo = Math.round((Date.now() - w.timestamp) / 1000);
    const timeFmt = timeAgo < 60 ? `${timeAgo} detik lalu` : `${Math.floor(timeAgo/60)} menit lalu`;
    
    const icon = w.side === "BUY" ? "🟢" : (w.side === "SELL" ? "🔴" : "🔵");
    
    const price = w.price != null && Number.isFinite(Number(w.price)) ? `$${Number(w.price).toFixed(3)}` : "price unavailable";
    text += `${icon} *${size}* (${w.side} @ ${price})\n`;
    text += `  📊 Market: ${w.market_question.slice(0, 45)}...\n`;
    text += `  👤 Wallet: \`${walletShort}\` (${timeFmt})\n\n`;
  }

  return text.trim();
}

export function getSnifferWsStatus() {
  const shards = Array.from(snifferShards.values(), (shard) => ({
    id: shard.id,
    state: shard.ws?.readyState === WebSocket.OPEN
      ? shard.state === "SUBSCRIBING" ? "SUBSCRIBING" : "OPEN"
      : shard.ws?.readyState === WebSocket.CONNECTING
        ? "CONNECTING"
        : shard.state === "OPEN"
          ? "RECONNECTING"
          : shard.state,
    expectedTokens: shard.expectedTokens,
    subscribedTokens: shard.subscribedTokens,
    lastMessageAt: shard.lastMessageAt,
    lastPongAt: shard.lastPongAt,
    lastTradeAt: shard.lastTradeAt,
    reconnectCount: shard.reconnectCount,
    errorCount: shard.errorCount,
    lastError: shard.lastError,
  }));
  return deriveSnifferHealth({
    active: isSnifferActive,
    isConnecting: snifferIsConnecting,
    expectedShards: snifferExpectedShards,
    expectedTokens: snifferExpectedTokens,
    reconnectCount: snifferReconnectCount,
    errorCount: snifferErrorCount,
    parserErrorCount: snifferParserErrorCount,
    lastError: snifferLastError,
    shards,
  });
}
