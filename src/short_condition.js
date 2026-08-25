import { askQwenShortCondition } from "./qwen.js";
import { getRecentLiquidations, getOrderbookImbalance } from "./binance_ws.js";
import { config } from "./config.js";
import WebSocket from "ws";
import { appendShortEvaluationSnapshot } from "./storage.js";

const BINANCE_FAPI_URLS = [...new Set([config.binanceFuturesBaseUrl, "https://fapi.binance.com"])];

const DURATION_MS = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

const CHAINLINK_MAX_AGE_MS = 15_000;
const MIN_DIRECTIONAL_PROBABILITY = 55;
const MIN_NET_EV_CENTS = 5;
const openingPriceCache = new Map();
const technicalDataCache = new Map();
// Brownian high-low range is about 1.596 standard deviations on average.
const ATR_TO_SIGMA = 1 / 1.5958;

function finiteNumber(value) {
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function standardNormalCdf(z) {
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + (z < 0 ? -erf : erf));
}

export function estimateTerminalUpProbability({
  currentPrice,
  priceToBeat,
  remainingMs,
  atr,
  intervalVolatility,
  atrIntervalMs,
}) {
  const current = finiteNumber(currentPrice);
  const opening = finiteNumber(priceToBeat);
  const remaining = finiteNumber(remainingMs);
  const measuredVolatility = finiteNumber(intervalVolatility);
  const fallbackAtr = finiteNumber(atr);
  const volatility = measuredVolatility != null && measuredVolatility > 0
    ? measuredVolatility
    : fallbackAtr != null && fallbackAtr > 0
      ? fallbackAtr * ATR_TO_SIGMA
      : null;
  const interval = finiteNumber(atrIntervalMs);
  if (current == null || current <= 0 || opening == null || opening <= 0 || remaining == null || remaining <= 0 || volatility == null || volatility <= 0 || interval == null || interval <= 0) {
    return null;
  }

  const terminalVolatility = volatility * Math.sqrt(remaining / interval);
  const probability = standardNormalCdf((current - opening) / terminalVolatility) * 100;
  return Math.max(0, Math.min(100, probability));
}

export function selectShortMarketSide({
  upProbability,
  upAsk,
  downAsk,
  maxPrice = config.entryMaxPrice,
  feeBufferCents = config.entryFeeBufferCents,
  minNetEvCents = MIN_NET_EV_CENTS,
  minDirectionalProbability = MIN_DIRECTIONAL_PROBABILITY,
}) {
  const upFair = finiteNumber(upProbability);
  const downFair = upFair == null ? null : 100 - upFair;
  const normalizedMaxPrice = finiteNumber(maxPrice);
  const normalizedFee = finiteNumber(feeBufferCents);
  const normalizedMinEv = finiteNumber(minNetEvCents);
  const normalizedMinFair = finiteNumber(minDirectionalProbability);
  const buildSide = (direction, fairProbability, rawAsk) => {
    const ask = finiteNumber(rawAsk);
    const validAsk = ask != null && ask > 0 && ask <= 1 ? ask : null;
    const netEvCents = fairProbability == null || validAsk == null || normalizedFee == null
      ? null
      : fairProbability - validAsk * 100 - normalizedFee;
    const qualifies = fairProbability != null
      && normalizedMinFair != null
      && fairProbability >= normalizedMinFair
      && validAsk != null
      && normalizedMaxPrice != null
      && validAsk <= normalizedMaxPrice
      && netEvCents != null
      && normalizedMinEv != null
      && netEvCents >= normalizedMinEv;
    return { direction, fairProbability, ask: validAsk, netEvCents, qualifies };
  };

  const sides = {
    UP: buildSide("UP", upFair, upAsk),
    DOWN: buildSide("DOWN", downFair, downAsk),
  };
  const selected = Object.values(sides)
    .filter((side) => side.qualifies)
    .sort((a, b) => b.netEvCents - a.netEvCents || b.fairProbability - a.fairProbability || a.ask - b.ask)[0] || null;

  return {
    recommendation: selected ? "PLAY" : "AVOID",
    direction: selected?.direction || "NEUTRAL",
    selected,
    sides,
  };
}

export function evaluateDeterministicShortSnapshot({
  currentPrice,
  priceToBeat,
  oraclePublishTime,
  oracleSourceVerified,
  startTimeMs,
  endTimeMs,
  nowMs,
  atr,
  intervalVolatility,
  atrIntervalMs,
  upAsk,
  downAsk,
  marketActive = true,
  marketClosed = false,
  acceptingOrders = true,
  maxPrice = config.entryMaxPrice,
  feeBufferCents = config.entryFeeBufferCents,
  minSecondsToClose = config.entryMinSecondsToClose,
}) {
  const now = finiteNumber(nowMs);
  const start = finiteNumber(startTimeMs);
  const end = finiteNumber(endTimeMs);
  const publishMs = parseTimestamp(oraclePublishTime);
  const remainingMs = now == null || end == null ? null : end - now;
  const probability = estimateTerminalUpProbability({
    currentPrice,
    priceToBeat,
    remainingMs,
    atr,
    intervalVolatility,
    atrIntervalMs,
  });
  const selection = selectShortMarketSide({
    upProbability: probability,
    upAsk,
    downAsk,
    maxPrice,
    feeBufferCents,
  });
  const blockers = [];

  if (!oracleSourceVerified) blockers.push("[ORACLE GUARDRAIL] Resolution source is not the official Chainlink stream for this asset.");
  if (!marketActive || marketClosed || !acceptingOrders) {
    blockers.push("[MARKET GUARDRAIL] Market is inactive, closed, or not accepting orders.");
  }
  if (start == null || end == null || now == null || start >= end || now < start || now >= end) {
    blockers.push("[TIME GUARDRAIL] Market start/end cannot be verified, has not started, or has already ended.");
  } else if (remainingMs < finiteNumber(minSecondsToClose) * 1000) {
    blockers.push(`[TIME GUARDRAIL] Less than ${minSecondsToClose} seconds remain before close.`);
  }
  const current = finiteNumber(currentPrice);
  const opening = finiteNumber(priceToBeat);
  if (current == null || current <= 0) blockers.push("[DATA GUARDRAIL] Fresh current Chainlink price is unavailable.");
  if (opening == null || opening <= 0) blockers.push("[DATA GUARDRAIL] Chainlink opening Price to Beat is unavailable.");
  const oracleAgeMs = now == null || publishMs == null ? null : now - publishMs;
  if (oracleAgeMs == null || oracleAgeMs < -2_000 || oracleAgeMs > CHAINLINK_MAX_AGE_MS) {
    blockers.push("[DATA GUARDRAIL] Chainlink live timestamp is missing or stale.");
  }
  const measuredVolatility = finiteNumber(intervalVolatility);
  const fallbackAtr = finiteNumber(atr);
  if (((measuredVolatility == null || measuredVolatility <= 0)
    && (fallbackAtr == null || fallbackAtr <= 0))
    || finiteNumber(atrIntervalMs) == null
    || Number(atrIntervalMs) <= 0) {
    blockers.push("[DATA GUARDRAIL] Interval volatility is unavailable or invalid.");
  }

  const upFair = probability;
  const downFair = probability == null ? null : 100 - probability;
  const forecastDirection = upFair == null
    ? "NEUTRAL"
    : upFair >= MIN_DIRECTIONAL_PROBABILITY
      ? "UP"
      : downFair >= MIN_DIRECTIONAL_PROBABILITY
        ? "DOWN"
        : "NEUTRAL";
  const forecastSide = forecastDirection === "NEUTRAL" ? null : selection.sides[forecastDirection];

  if (!selection.selected) {
    if (forecastDirection === "NEUTRAL") {
      blockers.push(`[DIRECTION GUARDRAIL] Terminal probability is not directional enough (UP ${upFair == null ? "n/a" : upFair.toFixed(2)}%).`);
    } else if (forecastSide.ask == null) {
      blockers.push(`[ORDERBOOK GUARDRAIL] Executable ${forecastDirection} ask is unavailable.`);
    } else if (forecastSide.ask > maxPrice) {
      blockers.push(`[MAX ENTRY PRICE GUARDRAIL] ${forecastDirection} ask $${forecastSide.ask.toFixed(4)} exceeds $${Number(maxPrice).toFixed(4)}.`);
    } else {
      blockers.push(`[EV GUARDRAIL] ${forecastDirection} net EV is ${forecastSide.netEvCents?.toFixed(2) ?? "n/a"}c after fees; at least ${MIN_NET_EV_CENTS}c is required.`);
    }
  }

  const totalDurationMs = start != null && end != null && end > start ? end - start : null;
  const elapsedMs = start != null && now != null ? Math.max(0, now - start) : null;
  const progressRatio = totalDurationMs && elapsedMs != null ? Math.min(1, elapsedMs / totalDurationMs) : null;

  const timingPhase = progressRatio == null
    ? "UNKNOWN"
    : progressRatio < 0.60
      ? "ACCUMULATION"
      : progressRatio < 0.90
        ? "SWEET_SPOT"
        : "FREEZE_ZONE";

  if (timingPhase === "FREEZE_ZONE") {
    blockers.push("[TIMING GUARDRAIL] Market is in FREEZE_ZONE (final 10%). Entry blocked to prevent chase.");
  }

  const actionable = blockers.length === 0 && selection.recommendation === "PLAY";
  const selectedOrLean = selection.selected || forecastSide;
  const leanFairProbability = probability == null ? null : Math.max(probability, 100 - probability);
  const selectedAsk = selection.selected?.ask ?? forecastSide?.ask ?? null;

  return {
    condition: forecastDirection === "NEUTRAL" ? "CHOPPY" : "TRENDING",
    recommendation: actionable ? "PLAY" : "AVOID",
    direction: actionable ? selection.direction : "NEUTRAL",
    actionable,
    confidence: leanFairProbability == null ? 0 : Math.round(leanFairProbability),
    forecast_direction: forecastDirection,
    primary_outcome_probability: probability == null ? null : Number(probability.toFixed(2)),
    estimated_fair_probability: selectedOrLean?.fairProbability == null ? leanFairProbability == null ? null : Number(leanFairProbability.toFixed(2)) : Number(selectedOrLean.fairProbability.toFixed(2)),
    expected_value_cents: selectedOrLean?.netEvCents == null ? null : Number(selectedOrLean.netEvCents.toFixed(2)),
    selected_ask: selectedAsk,
    timing_phase: timingPhase,
    guardrail_blockers: blockers,
    entry_pricing: selection.sides,
    oracle_age_ms: oracleAgeMs,
    remaining_ms: remainingMs,
  };
}

function normalizeDurationType(value, question = "") {
  const direct = String(value || "").trim().toLowerCase();
  if (DURATION_MS[direct]) return direct;
  const text = String(question).toLowerCase();
  if (/\b(?:daily|1d|24h)\b/.test(text)) return "1d";
  if (/\b4h\b|4 hours?/.test(text)) return "4h";
  if (/\b1h\b|1 hour/.test(text)) return "1h";
  if (/\b15m\b|15 min/.test(text)) return "15m";
  if (/\b5m\b|5 min/.test(text)) return "5m";
  return null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function chainlinkSourceSpec(value, asset) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "data.chain.link") return null;
    const expectedAsset = String(asset || "").trim().toLowerCase();
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    const base = `/streams/${expectedAsset}-usd`;
    if (path === base) {
      return { kind: "spot", windowSeconds: null, topic: "crypto_prices_chainlink", streamPath: path };
    }
    const twapMatch = path.match(new RegExp(`^/streams/${expectedAsset}-usd-twap-(30|60)s-streams$`));
    if (twapMatch) {
      const windowSeconds = Number(twapMatch[1]);
      return {
        kind: "twap",
        windowSeconds,
        topic: windowSeconds === 30 ? "crypto_prices_twap_thirty" : "crypto_prices_twap_sixty",
        streamPath: path,
      };
    }
    return null;
  } catch {
    return null;
  }
}


export function chainlinkVariant(durationType) {
  if (durationType === "5m") return "fiveminute";
  if (durationType === "15m") return "fifteen";
  if (durationType === "4h") return "fourhour";
  if (durationType === "1h") return "hourly";
  if (durationType === "1d") return "daily";
  return null;
}

async function fetchChainlinkOpeningPrice(asset, startTimeMs, endTimeMs, durationType, signal) {
  const variant = chainlinkVariant(durationType);
  if (!variant || startTimeMs == null || endTimeMs == null) return null;
  const cacheKey = `${asset}:${startTimeMs}:${endTimeMs}:${variant}`;
  if (openingPriceCache.has(cacheKey)) return openingPriceCache.get(cacheKey);
  const url = new URL("https://polymarket.com/api/crypto/crypto-price");
  url.searchParams.set("symbol", asset);
  url.searchParams.set("eventStartTime", new Date(startTimeMs).toISOString());
  url.searchParams.set("variant", variant);
  url.searchParams.set("endDate", new Date(endTimeMs).toISOString());
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const requestSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000);
      const response = await fetch(url, { signal: requestSignal });
      if (response.ok) {
        const payload = await response.json();
        const price = Number(payload?.openPrice);
        if (Number.isFinite(price) && price > 0) {
          openingPriceCache.set(cacheKey, price);
          if (openingPriceCache.size > 200) openingPriceCache.delete(openingPriceCache.keys().next().value);
          return price;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (attempt < 2) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          const error = new Error("Chainlink opening-price request aborted");
          error.name = "AbortError";
          reject(error);
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 2000);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  return null;
}

function fetchChainlinkLivePrice(asset, signal, sourceSpec = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("wss://ws-live-data.polymarket.com");
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      ws.close();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = new Error("Chainlink request aborted");
      error.name = "AbortError";
      finish(error);
    };
    const timeout = setTimeout(() => finish(new Error("Chainlink live price timeout")), 5000);
    signal?.addEventListener("abort", onAbort, { once: true });
    ws.on("open", () => {
      ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [{
          topic: sourceSpec?.topic || "crypto_prices_chainlink",
          type: "update",
          filters: JSON.stringify({ symbol: `${asset.toLowerCase()}/usd` }),
        }],
      }));
    });
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        const directValue = Number(message?.payload?.value);
        const points = Array.isArray(message?.payload?.data) ? message.payload.data : [];
        const latestPoint = points.at(-1);
        const value = Number.isFinite(directValue) ? directValue : Number(latestPoint?.value);
        const timestamp = Number(message?.payload?.timestamp ?? latestPoint?.timestamp);
        const ageMs = Date.now() - timestamp;
        if (Number.isFinite(value) && value > 0 && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 15_000) {
          finish(null, { price: value, publishTime: new Date(timestamp).toISOString() });
        }
      } catch {
        // Ignore heartbeat and unrelated topic messages.
      }
    });
    ws.on("error", (error) => finish(error));
  });
}

async function fetchWithFallback(endpoints, path, options = {}) {
  const { signal, ...fetchOptions } = options;
  for (const base of endpoints) {
    try {
      const attemptSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000);
      const res = await fetch(base + path, { ...fetchOptions, signal: attemptSignal });
      if (res.ok) return res;
    } catch (e) {
      if (signal?.aborted) throw e;
    }
  }
  throw new Error("All endpoints failed");
}

function emaSeries(data, period) {
  if (data.length < period) return [];
  const multiplier = 2 / (period + 1);
  let value = data.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  const result = [value];
  for (let index = period; index < data.length; index++) {
    value = data[index] * multiplier + value * (1 - multiplier);
    result.push(value);
  }
  return result;
}

export function calculateTechnicalIndicators(candles) {
  const valid = (Array.isArray(candles) ? candles : [])
    .map((candle) => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: candle.volume == null ? null : Number(candle.volume),
    }))
    .filter((candle) => [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
  if (valid.length < 35) throw new Error("Not enough closed candles for technical indicators");

  const closes = valid.map((candle) => candle.close);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= 14; index++) {
    const difference = closes[index] - closes[index - 1];
    if (difference >= 0) gains += difference;
    else losses += Math.abs(difference);
  }
  let averageGain = gains / 14;
  let averageLoss = losses / 14;
  for (let index = 15; index < closes.length; index++) {
    const difference = closes[index] - closes[index - 1];
    const gain = Math.max(difference, 0);
    const loss = Math.max(-difference, 0);
    averageGain = ((averageGain * 13) + gain) / 14;
    averageLoss = ((averageLoss * 13) + loss) / 14;
  }
  const rsi = averageGain === 0 && averageLoss === 0
    ? 50
    : averageLoss === 0
      ? 100
      : Math.round(100 - (100 / (1 + averageGain / averageLoss)));

  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdValues = ema26.map((ema26Value, index) => ema12[index + 14] - ema26Value);
  const signalValues = emaSeries(macdValues, 9);
  const macdLine = Number(macdValues.at(-1).toFixed(2));
  const macdSignal = Number(signalValues.at(-1).toFixed(2));
  const macdHistogram = Number((macdLine - macdSignal).toFixed(2));

  const trueRanges = [];
  for (let index = valid.length - 14; index < valid.length; index++) {
    const candle = valid[index];
    const previousClose = valid[index - 1]?.close ?? candle.open;
    trueRanges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    ));
  }
  const atr14 = trueRanges.reduce((sum, value) => sum + value, 0) / trueRanges.length;
  const closeDeltas = valid.slice(-31).map((candle, index, window) => (
    index === 0 ? null : candle.close - window[index - 1].close
  )).filter(Number.isFinite);
  const deltaMean = closeDeltas.reduce((sum, value) => sum + value, 0) / closeDeltas.length;
  const intervalVolatility = closeDeltas.length > 1
    ? Math.sqrt(closeDeltas.reduce((sum, value) => sum + (value - deltaMean) ** 2, 0) / (closeDeltas.length - 1))
    : null;

  const recentVolumes = valid.slice(-10).map((candle) => candle.volume);
  const volumeAvailable = recentVolumes.every((volume) => Number.isFinite(volume));
  let volumeRatio = null;
  if (volumeAvailable) {
    const previousAverage = recentVolumes.slice(0, -1).reduce((sum, value) => sum + value, 0) / 9;
    volumeRatio = previousAverage > 0 ? Number((recentVolumes.at(-1) / previousAverage).toFixed(2)) : null;
  }

  return {
    currentPrice: valid.at(-1).close,
    atr14: Number(atr14.toPrecision(8)),
    intervalVolatility: intervalVolatility == null ? null : Number(intervalVolatility.toPrecision(8)),
    rsi14: rsi,
    rsiSignal: rsi > 70 ? "OVERBOUGHT" : rsi < 30 ? "OVERSOLD" : rsi > 55 ? "BULLISH ZONE" : rsi < 45 ? "BEARISH ZONE" : "NEUTRAL",
    macd: {
      line: macdLine,
      signal: macdSignal,
      histogram: macdHistogram,
      trend: macdHistogram > 0 ? "BULLISH" : macdHistogram < 0 ? "BEARISH" : "NEUTRAL",
    },
    volumeRatio,
    volumeSignal: volumeRatio == null ? "unavailable" : volumeRatio > 1.5 ? "HIGH (strong momentum)" : volumeRatio < 0.7 ? "LOW (weak)" : "NORMAL",
    volumeAvailable,
    recentCandles: valid.slice(-5).map((candle) => ({
      time: new Date(candle.time).toISOString().slice(11, 16),
      open: candle.open.toFixed(2),
      close: candle.close.toFixed(2),
      direction: candle.close >= candle.open ? "UP" : "DOWN",
      vol: candle.volume == null ? null : candle.volume.toFixed(1),
    })),
  };
}

async function fetchChainlinkCandlePage(asset, interval, endTime, signal) {
  const url = new URL("https://polymarket.com/api/chainlink-candles");
  url.searchParams.set("symbol", asset);
  url.searchParams.set("interval", interval);
  url.searchParams.set("limit", "30");
  if (endTime != null) url.searchParams.set("endTime", String(endTime));
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
    : AbortSignal.timeout(8000);
  const response = await fetch(url, { signal: requestSignal });
  if (!response.ok) throw new Error(`Chainlink candles HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload?.candles) ? payload.candles : [];
}

export async function fetchChainlinkTechData(asset, durationType, signal = null) {
  if (signal?.aborted) {
    const error = new Error("Chainlink request aborted");
    error.name = "AbortError";
    throw error;
  }
  const cacheKey = `${asset}:${durationType}`;
  const cached = technicalDataCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 30_000) return cached.value;
  try {
    const interval = DURATION_MS[durationType] ? durationType : "5m";
    const latest = await fetchChainlinkCandlePage(asset, interval, null, signal);
    if (!latest.length) throw new Error("No Chainlink candles");
    const earliestMs = Number(latest[0].time) * 1000;
    const previous = await fetchChainlinkCandlePage(asset, interval, earliestMs - 1, signal);
    const unique = new Map([...previous, ...latest].map((candle) => [Number(candle.time), candle]));
    const intervalMs = DURATION_MS[interval] || DURATION_MS["5m"];
    const closed = [...unique.values()].filter((candle) => Number(candle.time) * 1000 + intervalMs <= Date.now());
    const indicators = calculateTechnicalIndicators(closed.map((candle) => ({
      ...candle,
      time: Number(candle.time) * 1000,
      volume: null,
    })));
    const result = {
      symbol: `${asset}USD`,
      interval,
      source: "chainlink",
      currentPrice: indicators.currentPrice.toFixed(2),
      priceChange24h: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      ...indicators,
    };
    technicalDataCache.set(cacheKey, { savedAt: Date.now(), value: result });
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

// Fetch 24h ticker + klines + RSI/MACD dari Binance
async function fetchBinanceTechData(symbol = "BTCUSDT", intervalMinutes = 5, signal = null) {
  try {
    const interval = intervalMinutes <= 5 ? "5m" : intervalMinutes <= 15 ? "15m" : intervalMinutes <= 60 ? "1h" : intervalMinutes <= 240 ? "4h" : "1d";
    const klinePath = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=60`;
    const tickerPath = `/fapi/v1/ticker/24hr?symbol=${symbol}`;

    const [klineRes, tickerRes] = await Promise.all([
      fetchWithFallback(BINANCE_FAPI_URLS, klinePath, { headers: { 'Cache-Control': 'no-cache' }, signal }),
      fetchWithFallback(BINANCE_FAPI_URLS, tickerPath, { headers: { 'Cache-Control': 'no-cache' }, signal }),
    ]);

    if (!klineRes.ok || !tickerRes.ok) throw new Error("Binance kline/ticker error");
    const rawKlines = await klineRes.json();
    const ticker = await tickerRes.json();
    const klines = Array.isArray(rawKlines)
      ? rawKlines.filter((kline) => Number(kline?.[6]) <= Date.now())
      : [];
    if (klines.length < 35) throw new Error("Not enough closed Binance candles");

    const indicators = calculateTechnicalIndicators(klines.map((kline) => ({
      time: Number(kline[0]),
      open: Number(kline[1]),
      high: Number(kline[2]),
      low: Number(kline[3]),
      close: Number(kline[4]),
      volume: Number(kline[5]),
    })));

    return {
      symbol, interval, source: "binance",
      currentPrice:   parseFloat(ticker.lastPrice).toFixed(2),
      priceChange24h: parseFloat(ticker.priceChangePercent).toFixed(2),
      high24h:        parseFloat(ticker.highPrice).toFixed(2),
      low24h:         parseFloat(ticker.lowPrice).toFixed(2),
      volume24h:      parseFloat(ticker.volume).toFixed(2),
      ...indicators,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

let longShortRatioCache = {}; // Symbol-specific cache: { [symbol]: { data, timestamp } }
const CACHE_DURATION_MS = 30 * 1000; // 30 detik (agar selalu fresh tapi anti-spam)

// Fetch Binance Futures Long/Short ratio
async function fetchLongShortRatio(symbol = "BTCUSDT", signal = null) {
  const now = Date.now();
  if (longShortRatioCache[symbol] && (now - longShortRatioCache[symbol].timestamp < CACHE_DURATION_MS)) {
    return longShortRatioCache[symbol].data;
  }

  try {
    const path = `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`;
    const res = await fetchWithFallback(BINANCE_FAPI_URLS, path, {
      headers: { 'Cache-Control': 'no-cache' },
      signal
    });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const latest = data[data.length - 1];
    const ratio  = parseFloat(latest.longShortRatio).toFixed(3);
    const longPct = parseFloat(latest.longAccount * 100).toFixed(1);
    const shortPct = parseFloat(latest.shortAccount * 100).toFixed(1);

    const result = { ratio, longPct, shortPct, bias: parseFloat(ratio) >= 1 ? 'LONG_DOMINANT' : 'SHORT_DOMINANT' };

    // Save to cache
    longShortRatioCache[symbol] = { data: result, timestamp: now };

    return result;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}



// Fetch Fear & Greed Index (alternative.me)
async function fetchFearGreed(signal = null) {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      headers: { 'Cache-Control': 'no-cache' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error("FGI API error");
    const data = await res.json();
    const item = data?.data?.[0];
    if (!item) return null;
    return { value: parseInt(item.value), label: item.value_classification };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.error("[Short Condition] fetchFearGreed error:", err.message);
    return null;
  }
}

function deterministicExplanation(decision) {
  const upProbability = decision.primary_outcome_probability;
  const lean = decision.forecast_direction || "NEUTRAL";
  const summary = upProbability == null
    ? "Terminal Chainlink probability could not be calculated from the final verified snapshot."
    : `Terminal model estimates UP at ${upProbability.toFixed(2)}% and the diagnostic lean is ${lean}.`;
  const entry = decision.recommendation === "PLAY"
    ? ` ${decision.direction} qualifies at ask $${decision.selected_ask.toFixed(4)} with ${decision.expected_value_cents.toFixed(2)}c net EV after fees.`
    : ` No executable side qualifies: ${decision.guardrail_blockers.join(" ")}`;
  return {
    reason: `${summary}${entry}`,
    key_signals: {
      depth_verdict: "CONTEXT_ONLY",
      liquidation_verdict: "CONTEXT_ONLY",
      flow_verdict: lean === "NEUTRAL" ? "CHOPPY" : `TERMINAL_${lean}`,
    },
    risk_warning: decision.recommendation === "PLAY" ? "Revalidate the executable ask before placing an order." : "No deterministic entry is authorized.",
  };
}

export function snapshotChanged(initial, final) {
  if (initial.priceToBeat !== final.priceToBeat) return true;
  if (initial.decision.recommendation !== final.decision.recommendation || initial.decision.direction !== final.decision.direction) return true;
  const initialProbability = initial.decision.primary_outcome_probability;
  const finalProbability = final.decision.primary_outcome_probability;
  if (initialProbability == null || finalProbability == null) return initialProbability !== finalProbability;
  if (Math.abs(initialProbability - finalProbability) >= 1) return true;
  const initialAsk = initial.decision.selected_ask;
  const finalAsk = final.decision.selected_ask;
  if (initialAsk == null || finalAsk == null) {
    if (initialAsk !== finalAsk) return true;
  } else if (Math.abs(initialAsk - finalAsk) >= 0.01) {
    return true;
  }
  const initialEv = initial.decision.expected_value_cents;
  const finalEv = final.decision.expected_value_cents;
  if (initialEv == null || finalEv == null) return initialEv !== finalEv;
  return Math.abs(initialEv - finalEv) >= 1;
}

export function shortEvaluationAiAvailability({ requestStarted = false, response = null, used = false, status = "not_requested" } = {}) {
  const available = Boolean(response?.reason);
  return {
    requested: Boolean(requestStarted),
    available,
    used: Boolean(available && used),
    status,
  };
}

export function buildObserveOnlyCollectorAudit({
  market,
  tokenIds,
  books,
  evaluation = null,
  collectedData = null,
  capturedAt,
  scheduledAt,
  status,
  errorCode = null,
  sourceVerified = false,
} = {}) {
  // The collector is deliberately a different audit context from the Phase A
  // manual evaluator.  Keep this projection allow-listed: in particular, do
  // not persist the trading decision object returned by the evaluator.
  const safeProjection = (value) => {
    if (Array.isArray(value)) return value.map(safeProjection);
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && /\b(?:ENTRY|PLAY|PUBLIC|CANDIDATE)\b/i.test(value)) return null;
      return value;
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/(recommendation|actionable|selected|candidate|entry|play|public)/i.test(key))
      .map(([key, item]) => [key, safeProjection(item)]));
  };
  const bookProjection = (book) => ({
    available: Boolean(book),
    bids: Array.isArray(book?.bids) ? book.bids : [],
    asks: Array.isArray(book?.asks) ? book.asks : [],
  });
  const deterministic = evaluation?.deterministicSnapshot
    || evaluation?.deterministic_snapshot
    || evaluation?.evaluation?.deterministicSnapshot
    || evaluation?.evaluation?.deterministic_snapshot
    || null;
  const modelOutputs = deterministic ? safeProjection({
    currentPrice: deterministic.currentPrice,
    priceToBeat: deterministic.priceToBeat,
    oraclePublishTime: deterministic.oraclePublishTime,
    oracleSourceKind: deterministic.oracleSourceKind,
    oracleWindowSeconds: deterministic.oracleWindowSeconds,
    capturedAt: deterministic.capturedAt,
    startDate: deterministic.startDate,
    endDate: deterministic.endDate,
    remainingSeconds: deterministic.remainingSeconds,
    atr: deterministic.atr,
    intervalVolatility: deterministic.intervalVolatility,
    atrIntervalMs: deterministic.atrIntervalMs,
    upProbability: deterministic.upProbability,
    downProbability: deterministic.downProbability,
    upAsk: deterministic.upAsk,
    downAsk: deterministic.downAsk,
    upMidpoint: deterministic.upMidpoint,
    downMidpoint: deterministic.downMidpoint,
    marketActive: deterministic.marketActive,
    marketClosed: deterministic.marketClosed,
    acceptingOrders: deterministic.acceptingOrders,
  }) : null;
  return {
    collector: "observe_only",
    status,
    errorCode,
    capturedAt,
    scheduledAt,
    market: {
      id: market?.id == null ? null : String(market.id),
      question: market?.question || null,
      asset: "BTC",
      durationType: "15m",
      startDate: market?.startDate || null,
      endDate: market?.endDate || null,
    },
    resolution: {
      source: market?.resolutionSource || null,
      verified: Boolean(sourceVerified),
    },
    tokens: {
      UP: tokenIds?.UP == null ? null : String(tokenIds.UP),
      DOWN: tokenIds?.DOWN == null ? null : String(tokenIds.DOWN),
    },
    provenance: {
      context: "btc15m_observe_collector",
      evaluator: "evaluateShortMarketCondition",
      deterministic: true,
      ai: { requested: false, used: false, status: "disabled" },
    },
    modelOutputs,
    data: safeProjection(collectedData),
    books: {
      UP: bookProjection(books?.UP),
      DOWN: bookProjection(books?.DOWN),
    },
  };
}

export async function evaluateShortMarketCondition({
  signal = null,
  marketId = null,
  asset = "BTC",
  marketQuestion = "",
  upTokenAsk = null,
  downTokenAsk = null,
  upTokenMidpoint = null,
  downTokenMidpoint = null,
  refreshMarketPrices = null,
  marketActive = true,
  marketClosed = false,
  acceptingOrders = true,
  durationType = null,
  startDate = null,
  endDate = null,
  resolutionSource = "",
  includeAiExplanation = true,
  refreshFinalSnapshot = true,
  collectorContext = null,
  nowMs = null,
}) {
  const normalizedAsset = String(asset || "BTC").toUpperCase();
  const symbol = normalizedAsset === "ETH" ? "ETHUSDT" : normalizedAsset === "DOGE" ? "DOGEUSDT" : "BTCUSDT";
  const normalizedDuration = normalizeDurationType(durationType, marketQuestion);
  const durationMs = DURATION_MS[normalizedDuration] || null;
  const endTimeMs = parseTimestamp(endDate);
  const explicitStartMs = parseTimestamp(startDate);
  const derivedStartMs = endTimeMs != null && durationMs ? endTimeMs - durationMs : explicitStartMs;
  const oracleSource = chainlinkSourceSpec(resolutionSource, normalizedAsset);
  const oracleSourceVerified = Boolean(oracleSource);

  let initialOpeningPrice = null;
  let initialLivePrice = null;
  const technicalDataPromise = fetchChainlinkTechData(normalizedAsset, normalizedDuration, signal);
  if (oracleSourceVerified) {
    [initialOpeningPrice, initialLivePrice] = await Promise.all([
      fetchChainlinkOpeningPrice(normalizedAsset, derivedStartMs, endTimeMs, normalizedDuration, signal).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      }),
      fetchChainlinkLivePrice(normalizedAsset, signal, oracleSource).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      }),
    ]);
  }

  const intervalMinutes = durationMs ? durationMs / 60_000 : 5;
  let tickerData = await technicalDataPromise;
  if (!tickerData) tickerData = await fetchBinanceTechData(symbol, intervalMinutes, signal);
  if (!tickerData) {
    tickerData = {
      symbol,
      interval: normalizedDuration || "n/a",
      source: initialLivePrice ? "chainlink-live-only" : "unavailable",
      currentPrice: initialLivePrice?.price?.toFixed?.(2) ?? null,
      priceChange24h: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      atr14: null,
      rsi14: null,
      rsiSignal: "unavailable",
      macd: null,
      volumeRatio: null,
      volumeSignal: "unavailable",
      volumeAvailable: false,
      recentCandles: null,
      fallback: true,
    };
  }

  const [longShort, fearGreed] = includeAiExplanation
    ? await Promise.all([
        fetchLongShortRatio(symbol, signal),
        fetchFearGreed(signal),
      ])
    : [null, null];
  const liqData = getRecentLiquidations(symbol, 15);
  const depthData = getOrderbookImbalance(symbol);
  const initialMarketPrices = {
    upAsk: finiteNumber(upTokenAsk),
    downAsk: finiteNumber(downTokenAsk),
    upMidpoint: finiteNumber(upTokenMidpoint),
    downMidpoint: finiteNumber(downTokenMidpoint),
  };
  const evaluateSnapshot = (openingPrice, livePrice, marketPrices, nowMs) => evaluateDeterministicShortSnapshot({
    currentPrice: livePrice?.price ?? null,
    priceToBeat: openingPrice,
    oraclePublishTime: livePrice?.publishTime ?? null,
    oracleSourceVerified,
    startTimeMs: derivedStartMs,
    endTimeMs,
    nowMs,
    atr: tickerData?.atr14,
    intervalVolatility: tickerData?.intervalVolatility,
    atrIntervalMs: durationMs,
    upAsk: marketPrices?.upAsk,
    downAsk: marketPrices?.downAsk,
    marketActive: marketPrices?.marketActive ?? marketActive,
    marketClosed: marketPrices?.marketClosed ?? marketClosed,
    acceptingOrders: marketPrices?.acceptingOrders ?? acceptingOrders,
  });

  const initialDecision = evaluateSnapshot(initialOpeningPrice, initialLivePrice, initialMarketPrices, nowMs ?? Date.now());
  const initialSnapshot = {
    currentPrice: initialLivePrice?.price ?? null,
    priceToBeat: initialOpeningPrice,
    upAsk: initialMarketPrices.upAsk,
    downAsk: initialMarketPrices.downAsk,
    decision: initialDecision,
  };
  let aiExplanation = null;
  let aiExplanationStatus = "not_requested";
  let aiExplanationError = null;
  let aiMetadata = {};
  let aiRequestStarted = false;
  if (includeAiExplanation && initialDecision.primary_outcome_probability != null) {
    aiExplanationStatus = "pending";
    const aiSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(config.shortAiTimeoutMs)])
      : AbortSignal.timeout(config.shortAiTimeoutMs);
    try {
      aiRequestStarted = true;
      const aiResult = await askQwenShortCondition({
        tickerData,
        longShort,
        fearGreed,
        signal: aiSignal,
        liquidations: liqData,
        orderbookDepth: depthData,
        targetPrice: initialOpeningPrice,
        oraclePrice: initialLivePrice?.price ?? null,
        marketQuestion,
        deterministic: initialDecision,
        marketPrices: initialMarketPrices,
      });
      aiExplanation = aiResult;
      aiExplanationStatus = aiResult?.reason ? "received" : "invalid";
      aiMetadata = {
        rawText: aiResult.rawText,
        usage: aiResult.usage,
        providerModel: aiResult.providerModel,
        fallbackFrom: aiResult.fallbackFrom,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      aiExplanationStatus = error?.name === "TimeoutError" || aiSignal.aborted ? "timeout" : "error";
      aiExplanationError = String(error?.message || error || "Unknown AI provider error").slice(0, 300);
      console.warn(`[Short Condition] ${config.qwenShortModel} explanation ${aiExplanationStatus}: ${aiExplanationError}`);
    }
  }

  let finalOpeningPrice = initialOpeningPrice;
  let finalLivePrice = initialLivePrice;
  let finalMarketPrices = initialMarketPrices;
  let finalRefreshError = null;
  if (oracleSourceVerified && refreshFinalSnapshot) {
    try {
      const [openingPrice, livePrice, refreshedPrices] = await Promise.all([
        initialOpeningPrice
          ? Promise.resolve(initialOpeningPrice)
          : fetchChainlinkOpeningPrice(normalizedAsset, derivedStartMs, endTimeMs, normalizedDuration, signal).catch((error) => {
            if (signal?.aborted) throw error;
            throw Object.assign(new Error("Final Chainlink opening price is unavailable."), { code: "FINAL_CHAINLINK_REFRESH_FAILED" });
          }),
        fetchChainlinkLivePrice(normalizedAsset, signal, oracleSource).catch((error) => {
          if (signal?.aborted) throw error;
          throw Object.assign(new Error("Final Chainlink live price is unavailable."), { code: "FINAL_CHAINLINK_REFRESH_FAILED" });
        }),
        typeof refreshMarketPrices === "function"
            ? Promise.resolve(refreshMarketPrices())
          : Promise.resolve(null),
      ]);
      if (!livePrice || !Number.isFinite(Number(livePrice.price)) || Number(livePrice.price) <= 0) {
        throw Object.assign(new Error("Final Chainlink live price is unavailable."), { code: "FINAL_CHAINLINK_REFRESH_FAILED" });
      }
      if (!refreshedPrices || finiteNumber(refreshedPrices.upAsk) == null || finiteNumber(refreshedPrices.downAsk) == null) {
        throw Object.assign(new Error("Final UP/DOWN CLOB prices are unavailable."), { code: "FINAL_CLOB_REFRESH_FAILED" });
      }
      finalOpeningPrice = openingPrice;
      finalLivePrice = livePrice;
      finalMarketPrices = {
        upAsk: finiteNumber(refreshedPrices.upAsk),
        downAsk: finiteNumber(refreshedPrices.downAsk),
        upMidpoint: finiteNumber(refreshedPrices.upMidpoint),
        downMidpoint: finiteNumber(refreshedPrices.downMidpoint),
        marketActive: refreshedPrices.marketActive === true,
        marketClosed: refreshedPrices.marketClosed !== false,
        acceptingOrders: refreshedPrices.acceptingOrders === true,
      };
    } catch (error) {
      if (signal?.aborted || error?.code === "UNSUPPORTED_UFC" || error?.code === "TOKEN_MAPPING_INVALID") throw error;
      finalRefreshError = error?.code === "FINAL_CHAINLINK_REFRESH_FAILED"
        ? "FINAL_CHAINLINK_REFRESH_FAILED"
        : "FINAL_CLOB_REFRESH_FAILED";
      finalLivePrice = null;
      finalMarketPrices = {
        upAsk: null,
        downAsk: null,
        upMidpoint: null,
        downMidpoint: null,
        marketActive: false,
        marketClosed: true,
        acceptingOrders: false,
      };
    }
  }

  const finalCapturedAt = nowMs ?? Date.now();
  const finalDecision = evaluateSnapshot(finalOpeningPrice, finalLivePrice, finalMarketPrices, finalCapturedAt);
  const finalSnapshot = {
    source: "chainlink",
    sourceVerified: oracleSourceVerified,
    currentPrice: finalLivePrice?.price ?? null,
    priceToBeat: finalOpeningPrice,
    oraclePublishTime: finalLivePrice?.publishTime ?? null,
    oracleSourceKind: oracleSource?.kind || null,
    oracleWindowSeconds: oracleSource?.windowSeconds || null,
    capturedAt: new Date(finalCapturedAt).toISOString(),
    startDate: derivedStartMs == null ? null : new Date(derivedStartMs).toISOString(),
    endDate: endTimeMs == null ? null : new Date(endTimeMs).toISOString(),
    remainingSeconds: finalDecision.remaining_ms == null ? null : Number((finalDecision.remaining_ms / 1000).toFixed(3)),
    atr: finiteNumber(tickerData?.atr14),
    intervalVolatility: finiteNumber(tickerData?.intervalVolatility),
    atrIntervalMs: durationMs,
    upProbability: finalDecision.primary_outcome_probability,
    downProbability: finalDecision.primary_outcome_probability == null ? null : Number((100 - finalDecision.primary_outcome_probability).toFixed(2)),
    upAsk: finalMarketPrices.upAsk,
    downAsk: finalMarketPrices.downAsk,
    upMidpoint: finalMarketPrices.upMidpoint,
    downMidpoint: finalMarketPrices.downMidpoint,
    feeBufferCents: config.entryFeeBufferCents,
    maxEntryPrice: config.entryMaxPrice,
    marketActive: finalMarketPrices.marketActive ?? marketActive,
    marketClosed: finalMarketPrices.marketClosed ?? marketClosed,
    acceptingOrders: finalMarketPrices.acceptingOrders ?? acceptingOrders,
  };
  const changed = snapshotChanged(initialSnapshot, {
    currentPrice: finalSnapshot.currentPrice,
    priceToBeat: finalSnapshot.priceToBeat,
    upAsk: finalSnapshot.upAsk,
    downAsk: finalSnapshot.downAsk,
    decision: finalDecision,
  });
  const aiExplanationAvailable = Boolean(aiExplanation?.reason);
  const aiExplanationUsed = Boolean(aiExplanationAvailable && !changed);
  if (aiExplanationAvailable) aiExplanationStatus = changed ? "discarded_stale" : "used";
  const aiAvailability = shortEvaluationAiAvailability({
    requestStarted: aiRequestStarted,
    response: aiExplanation,
    used: aiExplanationUsed,
    status: aiExplanationStatus,
  });
  const explanation = aiExplanationUsed
    ? {
        reason: aiExplanation.reason,
        key_signals: aiExplanation.key_signals,
        risk_warning: aiExplanation.risk_warning,
      }
    : deterministicExplanation(finalDecision);
  const result = {
    ...finalDecision,
    ...explanation,
    validation_issues: finalRefreshError ? [finalRefreshError] : [],
    final_refresh_error: finalRefreshError,
    raw_recommendation: finalDecision.recommendation,
    raw_direction: finalDecision.forecast_direction,
    raw_primary_probability: finalDecision.primary_outcome_probability,
    technical_source: tickerData?.source || "unknown",
    deterministic_snapshot: finalSnapshot,
    ai_explanation_used: aiExplanationUsed,
    ai_explanation_status: aiExplanationStatus,
    ai_explanation_error: aiExplanationError,
    ...aiMetadata,
  };

  // Audit only the final deterministic snapshot. This side effect is
  // deliberately outside the response object so callers retain the Phase A
  // response contract, while availability flags reflect actual observations.
  if (!collectorContext) {
    appendShortEvaluationSnapshot({
      marketId,
      marketQuestion,
      durationType: normalizedDuration,
      asset: normalizedAsset,
      capturedAt: finalSnapshot.capturedAt,
      auditPayload: {
        market: { id: marketId == null ? null : String(marketId), question: marketQuestion, asset: normalizedAsset, durationType: normalizedDuration },
        final: {
          deterministic: {
            rawAsk: { up: finalMarketPrices.upAsk, down: finalMarketPrices.downAsk },
            rawMidpoint: { up: finalMarketPrices.upMidpoint, down: finalMarketPrices.downMidpoint },
            decision: finalDecision,
          },
          snapshot: finalSnapshot,
        },
        providerDataAvailability: {
          polymarketClob: {
            available: [finalMarketPrices.upAsk, finalMarketPrices.downAsk, finalMarketPrices.upMidpoint, finalMarketPrices.downMidpoint].some((value) => value != null),
            asksAvailable: finalMarketPrices.upAsk != null || finalMarketPrices.downAsk != null,
            midpointsAvailable: finalMarketPrices.upMidpoint != null || finalMarketPrices.downMidpoint != null,
            rawBookAvailable: false,
          },
          chainlink: {
            available: oracleSourceVerified && finalLivePrice?.price != null,
            sourceVerified: oracleSourceVerified,
            livePriceAvailable: finalLivePrice?.price != null,
          },
          aiExplanation: {
            ...aiAvailability,
          },
        },
      },
    });
  }

  return {
    tickerData,
    techData: tickerData,
    longShort,
    fearGreed,
    liquidations: liqData,
    depth: depthData,
    oraclePrice: finalSnapshot.currentPrice,
    oraclePublishTime: finalSnapshot.oraclePublishTime,
    targetPrice: finalSnapshot.priceToBeat,
    durationType: normalizedDuration,
    startDate: finalSnapshot.startDate,
    endDate: finalSnapshot.endDate,
    oracleSourceVerified,
    deterministicSnapshot: finalSnapshot,
    evaluation: result,
    usage: result.usage,
    providerModel: result.providerModel,
    fallbackFrom: result.fallbackFrom,
    aiExplanationStatus: result.ai_explanation_status,
    aiExplanationError: result.ai_explanation_error,
  };
}
