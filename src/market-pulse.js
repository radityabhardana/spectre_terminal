import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const ASSETS = new Set(["BTC", "ETH", "DOGE"]);
const TIMEFRAMES = new Set(["1m", "5m", "15m", "1h", "4h"]);
const REFRESH_SECONDS = new Set([15, 30, 60, 300]);
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const statePath = path.join(dataDir, "market_pulse_monitor.json");
const listeners = new Set();

let timer = null;
let scanning = false;
let initialized = false;
let state = {
  active: false,
  config: { asset: "BTC", timeframe: "5m", refreshSeconds: 30 },
  reading: null,
  error: null,
  scanning: false,
  lastScanAt: null,
  nextScanAt: null,
};

function round(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ema(values, period) {
  if (values.length < period) return [];
  const multiplier = 2 / (period + 1);
  let current = average(values.slice(0, period));
  const output = [current];
  for (let index = period; index < values.length; index++) {
    current = values[index] * multiplier + current * (1 - multiplier);
    output.push(current);
  }
  return output;
}

function percentileRank(values, target) {
  if (!values.length || !Number.isFinite(target)) return 50;
  const belowOrEqual = values.filter((value) => value <= target).length;
  return Math.round((belowOrEqual / values.length) * 100);
}

function trueRange(candle, previousClose) {
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
}

function calculateRsi(closes, period = 14) {
  let gains = 0;
  let losses = 0;
  for (let index = closes.length - period; index < closes.length; index++) {
    const difference = closes[index] - closes[index - 1];
    gains += Math.max(difference, 0);
    losses += Math.max(-difference, 0);
  }
  if (gains === 0 && losses === 0) return 50;
  if (losses === 0) return 100;
  return 100 - (100 / (1 + gains / losses));
}

function calculateAdx(candles, period = 14) {
  const plusDm = [];
  const minusDm = [];
  const ranges = [];
  for (let index = 1; index < candles.length; index++) {
    const upMove = candles[index].high - candles[index - 1].high;
    const downMove = candles[index - 1].low - candles[index].low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    ranges.push(trueRange(candles[index], candles[index - 1].close));
  }

  const dx = [];
  for (let index = period - 1; index < ranges.length; index++) {
    const tr = ranges.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0);
    if (!tr) continue;
    const plusDi = 100 * plusDm.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0) / tr;
    const minusDi = 100 * minusDm.slice(index - period + 1, index + 1).reduce((sum, value) => sum + value, 0) / tr;
    const denominator = plusDi + minusDi;
    dx.push(denominator ? 100 * Math.abs(plusDi - minusDi) / denominator : 0);
  }
  return dx.length ? average(dx.slice(-period)) : 0;
}

function bollingerWidths(closes, period = 20) {
  const widths = [];
  for (let index = period - 1; index < closes.length; index++) {
    const window = closes.slice(index - period + 1, index + 1);
    const mean = average(window);
    const deviation = Math.sqrt(average(window.map((value) => (value - mean) ** 2)));
    widths.push(mean ? (deviation * 4 / mean) * 100 : 0);
  }
  return widths;
}

function normalizeCandles(input) {
  return (Array.isArray(input) ? input : [])
    .map((candle) => ({
      time: Number(candle.time),
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume),
    }))
    .filter((candle) => Object.values(candle).every(Number.isFinite))
    .sort((a, b) => a.time - b.time);
}

export function classifyMarketRegime(input, { asset = "BTC", timeframe = "5m" } = {}) {
  const candles = normalizeCandles(input);
  if (candles.length < 60) throw new Error("Market Pulse requires at least 60 closed candles");

  const closes = candles.map((candle) => candle.close);
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const currentEma20 = ema20.at(-1);
  const currentEma50 = ema50.at(-1);
  const ema20Slope = (currentEma20 - ema20.at(-6)) / currentEma20 * 100;
  const emaSpread = (currentEma20 - currentEma50) / currentEma50 * 100;
  const adx = calculateAdx(candles);
  const rsi = calculateRsi(closes);

  const ranges = candles.slice(1).map((candle, index) => trueRange(candle, candles[index].close));
  const atrSeries = [];
  for (let index = 13; index < ranges.length; index++) {
    atrSeries.push(average(ranges.slice(index - 13, index + 1)));
  }
  const atr = atrSeries.at(-1);
  const atrPercent = current.close ? atr / current.close * 100 : 0;
  const atrPercentile = percentileRank(atrSeries.slice(-50), atr);

  const chopWindow = candles.slice(-14);
  const chopRange = Math.max(...chopWindow.map((candle) => candle.high)) - Math.min(...chopWindow.map((candle) => candle.low));
  const chopTr = ranges.slice(-14).reduce((sum, value) => sum + value, 0);
  const choppiness = chopRange > 0 ? 100 * Math.log10(chopTr / chopRange) / Math.log10(14) : 100;

  const widths = bollingerWidths(closes);
  const bbWidth = widths.at(-1);
  const bbWidthPercentile = percentileRank(widths.slice(-50), bbWidth);
  const volumeAverage = average(candles.slice(-21, -1).map((candle) => candle.volume));
  const volumeRatio = volumeAverage > 0 ? current.volume / volumeAverage : 1;
  const rangeCandles = candles.slice(-21, -1);
  const previousHigh = Math.max(...rangeCandles.map((candle) => candle.high));
  const previousLow = Math.min(...rangeCandles.map((candle) => candle.low));
  const rangePosition = previousHigh === previousLow ? 0.5 : (current.close - previousLow) / (previousHigh - previousLow);
  const change5 = (current.close - candles.at(-6).close) / candles.at(-6).close * 100;

  const isBreakout = current.close > previousHigh && volumeRatio >= 1.15;
  const isBreakdown = current.close < previousLow && volumeRatio >= 1.15;
  const isSqueeze = (bbWidthPercentile <= 25 && atrPercentile <= 35) || (bbWidth <= 0.8 && atrPercent <= 0.35);
  const isTrendUp = adx >= 24 && emaSpread > 0.08 && ema20Slope > 0;
  const isTrendDown = adx >= 24 && emaSpread < -0.08 && ema20Slope < 0;
  const isChoppy = choppiness >= 61.8 || (adx < 19 && Math.abs(emaSpread) < 0.18);
  const isHighVolatility = atrPercentile >= 80 || bbWidthPercentile >= 85;

  let regime;
  if (isBreakout) {
    regime = { key: "BREAKOUT", label: "BREAKOUT", direction: "UP", description: "Harga menembus batas atas range dengan dukungan volume." };
  } else if (isBreakdown) {
    regime = { key: "BREAKDOWN", label: "BREAKDOWN", direction: "DOWN", description: "Harga menembus batas bawah range dengan dukungan volume." };
  } else if (isSqueeze) {
    regime = { key: "LOW_VOL_SQUEEZE", label: "SQUEEZE", direction: "NEUTRAL", description: "Volatilitas terkompresi. Market berpotensi memasuki fase ekspansi." };
  } else if (isTrendUp) {
    regime = { key: "TRENDING_UP", label: "TREND UP", direction: "UP", description: "Struktur harga dan momentum menunjukkan tren naik yang aktif." };
  } else if (isTrendDown) {
    regime = { key: "TRENDING_DOWN", label: "TREND DOWN", direction: "DOWN", description: "Struktur harga dan momentum menunjukkan tren turun yang aktif." };
  } else if (isChoppy) {
    regime = { key: "CHOPPY_RANGE", label: "CHOPPY", direction: "NEUTRAL", description: "Harga bergerak bolak-balik tanpa arah dominan yang konsisten." };
  } else if (isHighVolatility) {
    regime = { key: "VOLATILITY_EXPANSION", label: "HIGH VOL", direction: "NEUTRAL", description: "Range pergerakan melebar dan volatilitas berada di level tinggi." };
  } else {
    regime = { key: "TRANSITION", label: "TRANSITION", direction: "NEUTRAL", description: "Market sedang berpindah regime dan belum memiliki struktur yang bersih." };
  }

  const modifiers = [];
  if (isHighVolatility && regime.key !== "VOLATILITY_EXPANSION") modifiers.push("HIGH VOLATILITY");
  if (volumeRatio >= 1.5) modifiers.push("VOLUME SPIKE");
  if (volumeRatio < 0.7) modifiers.push("LOW VOLUME");
  if (!isBreakout && rangePosition >= 0.88) modifiers.push("UPPER RANGE PRESSURE");
  if (!isBreakdown && rangePosition <= 0.12) modifiers.push("LOWER RANGE PRESSURE");
  if (rsi >= 70) modifiers.push("OVERBOUGHT");
  if (rsi <= 30) modifiers.push("OVERSOLD");
  if ((isTrendUp && rsi >= 72) || (isTrendDown && rsi <= 28)) modifiers.push("REVERSAL RISK");
  if (!modifiers.length) modifiers.push("NO EXTREME CONDITION");

  let confidence = 58;
  if (regime.key === "CHOPPY_RANGE") confidence += Math.min(24, Math.max(0, choppiness - 55));
  if (regime.key.startsWith("TRENDING")) confidence += Math.min(24, Math.max(0, adx - 20));
  if (regime.key === "LOW_VOL_SQUEEZE") confidence += Math.round((50 - Math.max(atrPercentile, bbWidthPercentile)) / 2);
  if (regime.key === "BREAKOUT" || regime.key === "BREAKDOWN") confidence += Math.min(25, Math.round((volumeRatio - 1) * 20));
  if (regime.key === "VOLATILITY_EXPANSION") confidence += Math.round((Math.max(atrPercentile, bbWidthPercentile) - 70) / 2);
  confidence = Math.max(50, Math.min(95, Math.round(confidence)));

  return {
    asset,
    timeframe,
    regime: { ...regime, confidence },
    modifiers,
    price: round(current.close, asset === "DOGE" ? 5 : 2),
    priceChange: round((current.close - previous.close) / previous.close * 100, 3),
    windowChange: round(change5, 3),
    range: { low: round(previousLow, asset === "DOGE" ? 5 : 2), high: round(previousHigh, asset === "DOGE" ? 5 : 2), position: round(rangePosition * 100, 1) },
    metrics: {
      adx: round(adx, 1),
      choppiness: round(choppiness, 1),
      atrPercent: round(atrPercent, 3),
      atrPercentile,
      bbWidth: round(bbWidth, 3),
      bbWidthPercentile,
      volumeRatio: round(volumeRatio, 2),
      rsi: round(rsi, 1),
      emaSpread: round(emaSpread, 3),
      emaSlope: round(ema20Slope, 3),
    },
    candleClosedAt: new Date(current.time).toISOString(),
  };
}

export function normalizeMarketPulseConfig(input = {}) {
  const asset = String(input.asset || "BTC").toUpperCase();
  const timeframe = String(input.timeframe || "5m").toLowerCase();
  const requestedRefresh = Number(input.refreshSeconds || 30);
  return {
    asset: ASSETS.has(asset) ? asset : "BTC",
    timeframe: TIMEFRAMES.has(timeframe) ? timeframe : "5m",
    refreshSeconds: REFRESH_SECONDS.has(requestedRefresh) ? requestedRefresh : 30,
  };
}

async function fetchClosedCandles({ asset, timeframe }) {
  const symbol = `${asset}USDT`;
  const bases = [...new Set([config.binanceFuturesBaseUrl, "https://fapi.binance.com"])];
  let lastError = null;
  for (const base of bases) {
    try {
      const url = new URL("/fapi/v1/klines", base);
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", timeframe);
      url.searchParams.set("limit", "120");
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "Cache-Control": "no-cache" } });
      if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
      const rows = await response.json();
      const candles = rows
        .filter((row) => Number(row?.[6]) <= Date.now())
        .map((row) => ({ time: Number(row[6]), open: row[1], high: row[2], low: row[3], close: row[4], volume: row[5] }));
      if (candles.length < 60) throw new Error("Not enough closed Binance candles");
      return candles;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Market data unavailable");
}

function publicState() {
  return structuredClone(state);
}

function emitState() {
  const snapshot = publicState();
  for (const listener of listeners) listener(snapshot);
}

function persistState() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ active: state.active, config: state.config }, null, 2));
}

async function scan() {
  if (scanning) return publicState();
  scanning = true;
  state.scanning = true;
  state.error = null;
  emitState();
  try {
    const candles = await fetchClosedCandles(state.config);
    state.reading = classifyMarketRegime(candles, state.config);
    state.lastScanAt = new Date().toISOString();
  } catch (error) {
    state.error = error.message || String(error);
    state.lastScanAt = new Date().toISOString();
  } finally {
    scanning = false;
    state.scanning = false;
    state.nextScanAt = state.active ? new Date(Date.now() + state.config.refreshSeconds * 1000).toISOString() : null;
    emitState();
  }
  return publicState();
}

function scheduleNextScan() {
  clearTimeout(timer);
  if (!state.active) return;
  state.nextScanAt = new Date(Date.now() + state.config.refreshSeconds * 1000).toISOString();
  timer = setTimeout(async () => {
    await scan();
    scheduleNextScan();
  }, state.config.refreshSeconds * 1000);
  timer.unref?.();
}

export async function startMarketPulseMonitor(input) {
  clearTimeout(timer);
  const nextConfig = normalizeMarketPulseConfig(input);
  const configChanged = nextConfig.asset !== state.config.asset || nextConfig.timeframe !== state.config.timeframe;
  state.active = true;
  state.config = nextConfig;
  if (configChanged) state.reading = null;
  state.error = null;
  persistState();
  emitState();
  await scan();
  scheduleNextScan();
  return publicState();
}

export function stopMarketPulseMonitor() {
  clearTimeout(timer);
  timer = null;
  state.active = false;
  state.nextScanAt = null;
  persistState();
  emitState();
  return publicState();
}

export function getMarketPulseState() {
  return publicState();
}

export function subscribeMarketPulse(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initializeMarketPulseMonitor() {
  if (initialized) return;
  initialized = true;
  try {
    if (!fs.existsSync(statePath)) return;
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (saved?.active) void startMarketPulseMonitor(saved.config);
    else if (saved?.config) state.config = normalizeMarketPulseConfig(saved.config);
  } catch (error) {
    console.error("Market Pulse state restore failed:", error.message);
  }
}
