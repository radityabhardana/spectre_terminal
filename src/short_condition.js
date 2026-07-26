import { askQwenShortCondition } from "./qwen.js";
import { getRecentLiquidations, getOrderbookImbalance } from "./binance_ws.js";
import { config } from "./config.js";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "../data");

const BINANCE_FAPI_URLS = [...new Set([config.binanceFuturesBaseUrl, "https://fapi.binance.com"])];

const DURATION_MS = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};

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
        if (Number.isFinite(price) && price > 0) return price;
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

function fetchChainlinkLivePrice(asset, signal) {
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
          topic: "crypto_prices_chainlink",
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
      // Continue to next
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

  const recentVolumes = valid.slice(-10).map((candle) => candle.volume);
  const volumeAvailable = recentVolumes.every((volume) => Number.isFinite(volume));
  let volumeRatio = null;
  if (volumeAvailable) {
    const previousAverage = recentVolumes.slice(0, -1).reduce((sum, value) => sum + value, 0) / 9;
    volumeRatio = previousAverage > 0 ? Number((recentVolumes.at(-1) / previousAverage).toFixed(2)) : null;
  }

  return {
    currentPrice: valid.at(-1).close,
    atr14: Number(atr14.toFixed(2)),
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
    return {
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
  } catch (error) {
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
    // Silent catch due to frequent ISP blocking
    // console.error("[Short Condition] fetchBinanceTechData error:", err.message);
    return null;
  }
}

function saveShortConditionHistory(result, marketQuestion) {
  try {
    const histPath = path.join(dataDir, "short_condition_history.json");
    let history = [];
    if (fs.existsSync(histPath)) history = JSON.parse(fs.readFileSync(histPath, "utf-8"));
    history.push({
      date: new Date().toISOString(),
      marketQuestion,
      condition: result.condition,
      recommendation: result.recommendation,
      direction: result.direction,
      confidence: result.confidence,
      primaryOutcomeProbability: result.primary_outcome_probability,
      selectedOutcomeProbability: result.estimated_fair_probability,
      expectedValueCents: result.expected_value_cents ?? null,
      validationIssues: result.validation_issues || [],
      guardrailBlockers: result.guardrail_blockers || [],
      rawRecommendation: result.raw_recommendation || null,
      rawDirection: result.raw_direction || null,
      rawPrimaryProbability: result.raw_primary_probability ?? null,
      rawModelOutput: result.rawText || null,
      technicalSource: result.technical_source || null,
      reason: result.reason,
    });
    fs.writeFileSync(histPath, JSON.stringify(history.slice(-50), null, 2));
  } catch (error) {
    console.error("[Short Condition] Gagal menyimpan history:", error.message);
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
    // Silent catch due to frequent ISP blocking in Indonesia, fallback handles this gracefully
    // console.error("[Short Condition] fetchLongShortRatio error:", err.message);
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
    console.error("[Short Condition] fetchFearGreed error:", err.message);
    return null;
  }
}

export async function evaluateShortMarketCondition({
  signal = null,
  currentPriceStr = "",
  asset = "BTC",
  marketQuestion = "",
  marketOutcomePrice = null,
  durationType = null,
  startDate = null,
  endDate = null,
  resolutionSource = "",
}) {
  const normalizedAsset = String(asset || "BTC").toUpperCase();
  const symbol = normalizedAsset === "ETH" ? "ETHUSDT" : normalizedAsset === "DOGE" ? "DOGEUSDT" : "BTCUSDT";
  const normalizedDuration = normalizeDurationType(durationType, marketQuestion);
  const durationMs = DURATION_MS[normalizedDuration] || null;
  const endTimeMs = parseTimestamp(endDate);
  const explicitStartMs = parseTimestamp(startDate);
  const derivedStartMs = endTimeMs != null && durationMs ? endTimeMs - durationMs : explicitStartMs;
  const expectedOraclePath = `${normalizedAsset.toLowerCase()}-usd`;
  const oracleSourceVerified = String(resolutionSource || "").toLowerCase().includes(`data.chain.link/streams/${expectedOraclePath}`);

  // Extract target price from market question
  let targetPrice = null;
  if (marketQuestion) {
    const match = marketQuestion.match(/\$([0-9,]+(\.[0-9]+)?)/);
    if (match) {
      targetPrice = parseFloat(match[1].replace(/,/g, ''));
    }
  }

  let oraclePrice = null;
  let oraclePublishTime = null;
  if (oracleSourceVerified) {
    const [openingPrice, livePrice] = await Promise.all([
      targetPrice ? Promise.resolve(targetPrice) : fetchChainlinkOpeningPrice(normalizedAsset, derivedStartMs, endTimeMs, normalizedDuration, signal).catch(() => null),
      fetchChainlinkLivePrice(normalizedAsset, signal).catch(() => null),
    ]);
    targetPrice = openingPrice;
    oraclePrice = livePrice?.price ?? null;
    oraclePublishTime = livePrice?.publishTime ?? null;
  }

  const intervalMinutes = durationMs ? durationMs / 60_000 : 5;

  let tickerData = await fetchChainlinkTechData(normalizedAsset, normalizedDuration, signal);
  if (!tickerData) tickerData = await fetchBinanceTechData(symbol, intervalMinutes, signal);
  
  if (!tickerData) {
    if (oraclePrice) {
      tickerData = {
        symbol,
        interval: 'n/a',
        source: 'chainlink-live-only',
        currentPrice: oraclePrice.toFixed(2),
        priceChange24h: null,
        high24h: null,
        low24h: null,
        volume24h: null,
        rsi14: null,
        rsiSignal: 'unavailable',
        macd: null,
        volumeRatio: null,
        volumeSignal: 'unavailable',
        volumeAvailable: false,
        recentCandles: null,
        fallback: true
      };
    } else {
      throw new Error("Gagal mengambil data ticker Binance maupun Oracle Chainlink. Periksa koneksi internet.");
    }
  }

  // Override price if live Polymarket WebSocket price provided
  if (currentPriceStr && !isNaN(parseFloat(currentPriceStr))) {
    tickerData.currentPrice = parseFloat(currentPriceStr).toFixed(2);
  }

  // Fetch remaining data sources in parallel (all gracefully fail to null)
  const [longShort, fearGreed] = await Promise.all([
    fetchLongShortRatio(symbol, signal),
    fetchFearGreed(signal),
  ]);

  // Liquidations (Websocket 15m)
  const liqData = getRecentLiquidations(symbol, 15);

  // Orderbook Depth (Websocket 100ms)
  const depthData = getOrderbookImbalance(symbol);

  // Calculate Base Probability mechanically
  let baseProbability = 50;
  if (targetPrice && tickerData && tickerData.atr14) {
    const currentP = oraclePrice || parseFloat(tickerData.currentPrice);
    const distance = targetPrice - currentP;
    const remainingRatio = endTimeMs != null && durationMs
      ? Math.max(0.02, Math.min(1, (endTimeMs - Date.now()) / durationMs))
      : 1;
    const horizonAtr = tickerData.atr14 * Math.sqrt(remainingRatio);
    const relDistance = Math.abs(distance) / horizonAtr;

    let isAboveMarket = /above|higher|>/i.test(marketQuestion);
    let isBelowMarket = /below|lower|</i.test(marketQuestion);
    
    // Jika tidak tertulis eksplisit "above" atau "below", tapi merupakan market "Up or Down"
    if (!isAboveMarket && !isBelowMarket) {
       if (/up or down/i.test(marketQuestion)) {
          isAboveMarket = true; // Di Polymarket, YES = UP pada market "Up or Down"
       } else if (/up/i.test(marketQuestion)) {
          isAboveMarket = true;
       } else if (/down/i.test(marketQuestion)) {
          isBelowMarket = true;
       } else {
          isAboveMarket = true; // Default
       }
    }

    // Probability of touching/crossing the target
    let targetProb = 50;
    if (relDistance <= 2.5) {
      targetProb = Math.max(10, Math.min(90, 50 - (relDistance * 16)));
    } else {
      targetProb = 10;
    }

    // If currently winning
    const isCurrentlyWinning = (isAboveMarket && currentP > targetPrice) || (isBelowMarket && currentP < targetPrice);
    if (isCurrentlyWinning) {
      targetProb = Math.max(50, Math.min(95, 50 + (relDistance * 16)));
    }

    // Adjust based on Trend indicators (RSI and MACD)
    let trendAdjustment = 0;
    if (tickerData.rsi14) {
      if (isAboveMarket) {
        if (tickerData.rsi14 > 55) trendAdjustment += 5;
        if (tickerData.rsi14 < 45) trendAdjustment -= 5;
      } else if (isBelowMarket) {
        if (tickerData.rsi14 < 45) trendAdjustment += 5;
        if (tickerData.rsi14 > 55) trendAdjustment -= 5;
      }
    }
    if (tickerData.macd) {
      const macdTrend = tickerData.macd.trend;
      if (macdTrend !== "NEUTRAL") {
        const isBullish = macdTrend === 'BULLISH';
        if (isAboveMarket) trendAdjustment += isBullish ? 5 : -5;
        else if (isBelowMarket) trendAdjustment += isBullish ? -5 : 5;
      }
    }

    // Adjust based on orderbook imbalance
    if (depthData) {
      const imbalance = depthData.imbalanceRatio;
      if (isAboveMarket) {
        if (imbalance > 1.5) trendAdjustment += 5;
        if (imbalance < 0.7) trendAdjustment -= 5;
      } else if (isBelowMarket) {
        if (imbalance < 0.7) trendAdjustment += 5;
        if (imbalance > 1.5) trendAdjustment -= 5;
      }
    }

    // Adjust for Liquidations (Squeeze Momentum)
    if (liqData) {
      const longsLiq = liqData.longsLiqValue || 0;
      const shortsLiq = liqData.shortsLiqValue || 0;
      if (shortsLiq > longsLiq * 1.5) {
        if (isAboveMarket) trendAdjustment += 5;
        if (isBelowMarket) trendAdjustment -= 5;
      } else if (longsLiq > shortsLiq * 1.5) {
        if (isBelowMarket) trendAdjustment += 5;
        if (isAboveMarket) trendAdjustment -= 5;
      }
    }

    baseProbability = Math.round(Math.max(5, Math.min(95, targetProb + trendAdjustment)));
  }

  // Ask Qwen
    const result = await askQwenShortCondition({ 
      tickerData, 
      longShort, 
      fearGreed, 
      signal, 
      liquidations: liqData, 
      orderbookDepth: depthData,
      targetPrice,
      oraclePrice,
      marketQuestion,
      marketOutcomePrice,
      baseProbability
    });

    // Deterministic guardrails: AI may explain a signal, but cannot bypass math/data checks.
    const MAX_ENTRY_PRICE = config.tradeMaxPrice;
    const MIN_EV_CENTS = 5;
    const upTokenPrice = Number.isFinite(Number(marketOutcomePrice))
      ? Math.max(0, Math.min(1, Number(marketOutcomePrice)))
      : null;
    const downTokenPrice = upTokenPrice == null ? null : Number((1 - upTokenPrice).toFixed(4));
    const selectedDirection = result.direction;
    const selectedFairProbability = Number(result.estimated_fair_probability);

    const guardrailBlockers = [];
    const addGuardrailBlocker = (condition, message) => {
      if (!condition) return;
      guardrailBlockers.push(message);
      if (result.recommendation === "PLAY") result.recommendation = "AVOID";
    };

    addGuardrailBlocker(
      !normalizedDuration || derivedStartMs == null || endTimeMs == null || endTimeMs <= Date.now(),
      "[TIME GUARDRAIL] Durasi serta waktu mulai/selesai market tidak dapat diverifikasi atau market sudah berakhir."
    );
    addGuardrailBlocker(
      !oracleSourceVerified,
      "[ORACLE GUARDRAIL] Resolution source market tidak cocok dengan Chainlink stream untuk aset ini."
    );
    addGuardrailBlocker(!targetPrice, "[DATA GUARDRAIL] Opening price/target Chainlink belum tersedia.");
    addGuardrailBlocker(!oraclePrice || !oraclePublishTime, "[DATA GUARDRAIL] Harga live Chainlink tidak tersedia atau stale.");
    addGuardrailBlocker(!tickerData?.atr14, "[DATA GUARDRAIL] ATR tidak tersedia; edge tidak dapat diverifikasi.");

    if (upTokenPrice == null || !Number.isFinite(selectedFairProbability)) {
      addGuardrailBlocker(true, "[EV GUARDRAIL] Harga token atau fair probability tidak valid; EV tidak dapat dihitung.");
    } else {
      const tokenPriceForDirection = selectedDirection === "DOWN" ? downTokenPrice : upTokenPrice;
      const ev = (selectedFairProbability / 100) - tokenPriceForDirection;
      result.expected_value_cents = Math.round(ev * 100);
      addGuardrailBlocker(
        ev < MIN_EV_CENTS / 100,
        `[EV GUARDRAIL] Expected Value terlalu kecil (${result.expected_value_cents}c < ${MIN_EV_CENTS}c).`
      );
    }

    // Guardrail 1: Max Entry Price Filter (Anti-Overpaying Rule)
    if (["UP", "DOWN"].includes(selectedDirection)) {
      const targetTokenPrice = selectedDirection === "DOWN" ? downTokenPrice : upTokenPrice;
      addGuardrailBlocker(
        targetTokenPrice !== null && targetTokenPrice > MAX_ENTRY_PRICE,
        targetTokenPrice !== null
          ? `[MAX ENTRY PRICE GUARDRAIL] Harga token ${selectedDirection} ($${targetTokenPrice.toFixed(2)}) melebihi batas $${MAX_ENTRY_PRICE.toFixed(2)}.`
          : ""
      );
    }

    // Guardrail 2: Confidence Threshold (<70% -> AVOID)
    addGuardrailBlocker(
      (result.confidence || 0) < 70,
      `[CONFIDENCE GUARDRAIL] Confidence AI terlalu rendah (${result.confidence}% < 70%).`
    );

    // Guardrail 3: Micro-Gap Noise Filter ($10 BTC / $0.75 ETH)
    const curPrice = oraclePrice || (tickerData ? parseFloat(tickerData.currentPrice) : null);
    if (curPrice && targetPrice) {
      const absGapUsd = Math.abs(curPrice - targetPrice);
      const minGapThreshold = normalizedAsset === "ETH" ? 0.75 : normalizedAsset === "DOGE" ? 0.0005 : 10.00;
      addGuardrailBlocker(
        absGapUsd < minGapThreshold && (result.confidence || 0) < 85,
        `[MICRO-GAP NOISE FILTER] Jarak ke target ($${absGapUsd.toFixed(2)} < $${minGapThreshold}) terlalu kecil dan rawan noise.`
      );
    }

    // Crowd data can confirm a PLAY, but can never revive an AI AVOID.
    const isExtremeSqueeze = tickerData?.volumeRatio > 2.0;
    if (["UP", "DOWN"].includes(selectedDirection) && upTokenPrice != null && !isExtremeSqueeze) {
      const crowdDirection = upTokenPrice >= 0.62 ? "UP" : downTokenPrice >= 0.62 ? "DOWN" : "NEUTRAL";
      addGuardrailBlocker(
        crowdDirection !== "NEUTRAL" && crowdDirection !== selectedDirection,
        `[CROWD CONFLICT] Harga CLOB dominan ${crowdDirection}, berlawanan dengan sinyal ${selectedDirection}.`
      );
    }

    result.guardrail_blockers = guardrailBlockers;
    result.technical_source = tickerData?.source || "unknown";
    if (guardrailBlockers.length) {
      result.reason = `${guardrailBlockers.join("\n")}\n${result.reason || ""}`.trim();
    }

    saveShortConditionHistory(result, marketQuestion);

    return {
      tickerData,
      liquidations: liqData,
      depth: depthData,
      oraclePrice,
      oraclePublishTime,
      targetPrice,
      durationType: normalizedDuration,
      startDate: derivedStartMs != null ? new Date(derivedStartMs).toISOString() : null,
      endDate: endTimeMs != null ? new Date(endTimeMs).toISOString() : null,
      oracleSourceVerified,
      evaluation: result,
      usage: result.usage,
      providerModel: result.providerModel,
      fallbackFrom: result.fallbackFrom,
    };
}
