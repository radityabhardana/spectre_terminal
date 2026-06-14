/**
 * BTC Short-Term Derivatives Research
 * Dipakai untuk market Polymarket jenis "Will BTC go up/down X% in 5 minutes?"
 * Data source: Binance (5m candles, futures), Bybit (long/short ratio - public API no key)
 */

import { config } from "./config.js";
import { getCache, setCache } from "./storage.js";

// ─── Cache Helper ─────────────────────────────────────────────
async function fetchJsonCached(url, ttlSeconds = 10, extraHeaders = {}) {
  const key = `btcst:${url}`;
  const cached = getCache(key, ttlSeconds);
  if (cached) return cached;

  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(8000)
      : undefined;

  const res = await fetch(url, {
    signal,
    headers: {
      accept: "application/json",
      "user-agent": "polymarket-telegram-analyzer/0.1",
      ...extraHeaders,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  setCache(key, json);
  return json;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(v) {
  const n = num(v);
  return n == null ? "n/a" : `${n.toFixed(4)}%`;
}

// ─── 1. Binance 5m Candles (60 min lookback = 12 candles) ─────
async function fetchBinance5mCandles(symbol = "BTCUSDT") {
  const url = `${config.binanceBaseUrl}/api/v3/klines?symbol=${symbol}&interval=5m&limit=12`;
  const data = await fetchJsonCached(url, 10);
  if (!Array.isArray(data) || !data.length) return null;

  const closes = data.map((k) => num(k[4])).filter((v) => v != null);
  const highs  = data.map((k) => num(k[2])).filter((v) => v != null);
  const lows   = data.map((k) => num(k[3])).filter((v) => v != null);
  const vols   = data.map((k) => num(k[5])).filter((v) => v != null);

  const current = closes.at(-1);
  const prev5m  = closes.at(-2);
  const prev1h  = closes[0];
  const highMax = Math.max(...highs);
  const lowMin  = Math.min(...lows);
  const avgVol  = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
  const lastVol = vols.at(-1);

  // ATR proxy: average of (high - low) per candle
  const atrValues = data.map((k) => {
    const h = num(k[2]);
    const l = num(k[3]);
    return h != null && l != null ? h - l : null;
  }).filter((v) => v != null);
  const atr5m = atrValues.length ? atrValues.reduce((a, b) => a + b, 0) / atrValues.length : null;

  const change5m  = current && prev5m  ? ((current - prev5m) / prev5m) * 100  : null;
  const change1h  = current && prev1h  ? ((current - prev1h) / prev1h) * 100  : null;
  const volSpike  = avgVol && lastVol  ? lastVol / avgVol                      : null;

  let trend = "sideways";
  if (change1h != null && change1h >  0.3) trend = "bullish_1h";
  if (change1h != null && change1h < -0.3) trend = "bearish_1h";

  return {
    symbol,
    current_price: current,
    change_5m_pct: change5m,
    change_1h_pct: change1h,
    high_1h: highMax,
    low_1h: lowMin,
    range_1h_pct: highMax && lowMin ? ((highMax - lowMin) / lowMin) * 100 : null,
    atr_5m_usd: atr5m,
    volume_last_5m: lastVol,
    volume_avg_5m: avgVol,
    volume_spike_ratio: volSpike,
    trend_1h: trend,
    candles_count: data.length,
  };
}

// ─── 2. Binance Futures: Real-time OI + Funding Rate ──────────
async function fetchBinanceFuturesRealtime(symbol = "BTCUSDT") {
  const base = config.binanceFuturesBaseUrl;
  const [oiRes, premRes, lsRes] = await Promise.allSettled([
    fetchJsonCached(`${base}/fapi/v1/openInterest?symbol=${symbol}`, 10),
    fetchJsonCached(`${base}/fapi/v1/premiumIndex?symbol=${symbol}`, 10),
    fetchJsonCached(`${base}/fapi/v1/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`, 10),
  ]);

  const oi   = oiRes.status   === "fulfilled" ? oiRes.value   : null;
  const prem = premRes.status === "fulfilled" ? premRes.value : null;
  const ls   = lsRes.status   === "fulfilled" ? lsRes.value   : null;

  // OI history untuk delta (2 titik terakhir)
  let oiDelta = null;
  const oiHistRes = await Promise.allSettled([
    fetchJsonCached(`${base}/fapi/v1/openInterestHist?symbol=${symbol}&period=5m&limit=6`, 60),
  ]);
  if (oiHistRes[0].status === "fulfilled") {
    const hist = oiHistRes[0].value;
    if (Array.isArray(hist) && hist.length >= 2) {
      const latest = num(hist.at(-1)?.sumOpenInterest);
      const prev   = num(hist.at(-2)?.sumOpenInterest);
      oiDelta = latest && prev ? ((latest - prev) / prev) * 100 : null;
    }
  }

  // Binance global L/S
  let binanceLongRatio = null;
  let binanceShortRatio = null;
  if (Array.isArray(ls) && ls.length) {
    binanceLongRatio  = num(ls[0].longAccount);
    binanceShortRatio = num(ls[0].shortAccount);
  }

  return {
    open_interest: num(oi?.openInterest),
    open_interest_delta_5m_pct: oiDelta,
    funding_rate: num(prem?.lastFundingRate),
    funding_rate_pct: prem?.lastFundingRate ? num(prem.lastFundingRate) * 100 : null,
    next_funding_time: prem?.nextFundingTime
      ? new Date(num(prem.nextFundingTime)).toISOString()
      : null,
    mark_price: num(prem?.markPrice),
    index_price: num(prem?.indexPrice),
    binance_long_ratio: binanceLongRatio,
    binance_short_ratio: binanceShortRatio,
  };
}

// ─── 3. Bybit Long/Short Ratio (Public, No Auth) ─────────────
async function fetchBybitLongShort(symbol = "BTCUSDT") {
  const url = `https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol}&period=5min&limit=6`;
  const data = await fetchJsonCached(url, 10);

  const list = data?.result?.list;
  if (!Array.isArray(list) || !list.length) return null;

  const latest = list[0];
  const longRatio  = num(latest.buyRatio);
  const shortRatio = num(latest.sellRatio);

  // Hitung apakah long ratio sedang naik atau turun (trend 5 snapshot)
  const ratios = list.map((item) => num(item.buyRatio)).filter((v) => v != null);
  let longTrend = "stable";
  if (ratios.length >= 3) {
    const avg = ratios.slice(1).reduce((a, b) => a + b, 0) / (ratios.length - 1);
    if (ratios[0] > avg + 0.005) longTrend = "increasing";
    if (ratios[0] < avg - 0.005) longTrend = "decreasing";
  }

  let signal = "neutral";
  if (longRatio != null) {
    if (longRatio > 0.65) signal = "extreme_long_crowded"; // Risiko dump/squeeze turun
    if (longRatio > 0.58) signal = "long_crowded";         // Bias bearish short-term
    if (longRatio < 0.42) signal = "short_crowded";        // Bias bullish / squeeze atas
    if (longRatio < 0.35) signal = "extreme_short_crowded"; // Risiko squeeze besar
  }

  return {
    provider: "Bybit",
    symbol,
    long_ratio:   longRatio,
    short_ratio:  shortRatio,
    long_ratio_pct:  longRatio  != null ? (longRatio  * 100).toFixed(2) + "%" : "n/a",
    short_ratio_pct: shortRatio != null ? (shortRatio * 100).toFixed(2) + "%" : "n/a",
    long_trend: longTrend,
    signal,
    timestamp: new Date(num(latest.timestamp)).toISOString(),
    history: list.slice(0, 6).map((item) => ({
      long_ratio: num(item.buyRatio),
      short_ratio: num(item.sellRatio),
      time: new Date(num(item.timestamp)).toISOString(),
    })),
  };
}

// ─── Signal Interpreter ───────────────────────────────────────
function interpretSignals({ candles, futures, bybit }) {
  const signals = [];
  const biases  = [];

  // Candle signals
  if (candles) {
    if (candles.change_5m_pct != null) {
      if (candles.change_5m_pct >  0.2) { signals.push("🟢 5m momentum: bullish"); biases.push("UP"); }
      if (candles.change_5m_pct < -0.2) { signals.push("🔴 5m momentum: bearish"); biases.push("DOWN"); }
    }
    if (candles.volume_spike_ratio != null && candles.volume_spike_ratio > 2) {
      signals.push(`⚡ Volume spike: ${candles.volume_spike_ratio.toFixed(1)}x rata-rata`);
    }
    if (candles.trend_1h !== "sideways") {
      signals.push(`📊 Trend 1h: ${candles.trend_1h} (${candles.change_1h_pct?.toFixed(2)}%)`);
      biases.push(candles.trend_1h === "bullish_1h" ? "UP" : "DOWN");
    }
  }

  // Funding signals
  if (futures?.funding_rate_pct != null) {
    const fr = futures.funding_rate_pct;
    if (fr >  0.03) { signals.push(`💸 Funding rate tinggi: ${fr.toFixed(4)}% (long bayar — tekanan turun)`); biases.push("DOWN"); }
    if (fr < -0.03) { signals.push(`💸 Funding rate negatif: ${fr.toFixed(4)}% (short bayar — tekanan naik)`); biases.push("UP"); }
  }

  // OI delta signals
  if (futures?.open_interest_delta_5m_pct != null) {
    const d = futures.open_interest_delta_5m_pct;
    if (d >  0.5) signals.push(`📈 OI naik ${d.toFixed(2)}% dalam 5m (posisi baru dibuka)`);
    if (d < -0.5) signals.push(`📉 OI turun ${d.toFixed(2)}% dalam 5m (posisi ditutup/liquidasi)`);
  }

  // Bybit L/S signals
  if (bybit?.signal) {
    const s = bybit.signal;
    if (s === "extreme_long_crowded") { signals.push("🚨 Bybit: 65%+ long — SANGAT crowded, risiko dump tinggi"); biases.push("DOWN"); }
    if (s === "long_crowded")         { signals.push(`⚠️ Bybit: ${bybit.long_ratio_pct} long — pasar condong long`); biases.push("DOWN"); }
    if (s === "short_crowded")        { signals.push(`⚠️ Bybit: ${bybit.long_ratio_pct} long — pasar condong short, potensi squeeze`); biases.push("UP"); }
    if (s === "extreme_short_crowded"){ signals.push("🚨 Bybit: 35%- long — SANGAT short crowded, potensi short squeeze besar"); biases.push("UP"); }
  }

  // Count consensus
  const upCount   = biases.filter((b) => b === "UP").length;
  const downCount = biases.filter((b) => b === "DOWN").length;
  let consensus = "no_clear_bias";
  if (upCount   >= 2 && upCount   > downCount) consensus = "bullish_bias";
  if (downCount >= 2 && downCount > upCount)   consensus = "bearish_bias";
  if (upCount   >= 3)                          consensus = "strong_bullish";
  if (downCount >= 3)                          consensus = "strong_bearish";

  return { signals, consensus, up_signals: upCount, down_signals: downCount };
}

// ─── 4. Summary String untuk AI ──────────────────────────────
function buildSummary({ candles, futures, bybit, interpretation }) {
  const parts = [];

  if (candles) {
    parts.push(
      `Harga saat ini: $${candles.current_price?.toFixed(2) ?? "n/a"} | ` +
      `5m: ${candles.change_5m_pct?.toFixed(3) ?? "n/a"}% | ` +
      `1h: ${candles.change_1h_pct?.toFixed(3) ?? "n/a"}% | ` +
      `ATR-5m: $${candles.atr_5m_usd?.toFixed(2) ?? "n/a"} | ` +
      `Vol spike: ${candles.volume_spike_ratio?.toFixed(1) ?? "n/a"}x`
    );
  }

  if (futures) {
    parts.push(
      `Funding rate: ${futures.funding_rate_pct?.toFixed(4) ?? "n/a"}% | ` +
      `OI delta 5m: ${futures.open_interest_delta_5m_pct?.toFixed(2) ?? "n/a"}% | ` +
      `Binance L/S: ${futures.binance_long_ratio != null ? (futures.binance_long_ratio * 100).toFixed(1) + "%" : "n/a"} long`
    );
  }

  if (bybit) {
    parts.push(
      `Bybit L/S: ${bybit.long_ratio_pct} long / ${bybit.short_ratio_pct} short | ` +
      `Trend L/S: ${bybit.long_trend} | Signal: ${bybit.signal}`
    );
  }

  if (interpretation) {
    parts.push(
      `Consensus: ${interpretation.consensus} | ` +
      `Sinyal naik: ${interpretation.up_signals} | ` +
      `Sinyal turun: ${interpretation.down_signals}`
    );
    if (interpretation.signals.length) {
      parts.push("Active signals: " + interpretation.signals.join(" | "));
    }
  }

  return parts.join("\n");
}

// ─── Exported: Detect BTC Short-Term Market ──────────────────
const SHORT_TERM_PATTERNS = [
  /\b5[\s-]?min/i,
  /\b15[\s-]?min/i,
  /\bminute/i,
  /\bwithin\s+\d+\s+hour/i,
  /\bup\s+or\s+down/i,
  /\bup\b.*\bdown\b/i,
  /\bbtc\b.*\bwill\b/i,
  /\bwill\s+btc\b/i,
  /\bwill\s+bitcoin\b/i,
  /\babove\b.*\bbtc\b/i,
  /\bbtc\b.*\babove\b/i,
  /\bbtc\b.*\bbelow\b/i,
  /\bbelow\b.*\bbtc\b/i,
  /\bhit\b.*\bbtc\b/i,
  /reach.*\$[\d,]+.*btc/i,
];

export function isBtcShortTermMarket(text = "") {
  const hasBtc = /\b(btc|bitcoin)\b/i.test(text);
  if (!hasBtc) return false;
  return SHORT_TERM_PATTERNS.some((re) => re.test(text));
}

// ─── Main Export: buildBtcShortTermContext ────────────────────
export async function buildBtcShortTermContext() {
  const symbol = "BTCUSDT";
  const errors = [];

  const [candlesResult, futuresResult, bybitResult] = await Promise.allSettled([
    fetchBinance5mCandles(symbol),
    fetchBinanceFuturesRealtime(symbol),
    fetchBybitLongShort(symbol),
  ]);

  const candles = candlesResult.status === "fulfilled" ? candlesResult.value : null;
  const futures = futuresResult.status === "fulfilled" ? futuresResult.value : null;
  const bybit   = bybitResult.status   === "fulfilled" ? bybitResult.value   : null;

  if (candlesResult.status === "rejected") errors.push(`Binance 5m candles: ${candlesResult.reason?.message}`);
  if (futuresResult.status === "rejected") errors.push(`Binance Futures: ${futuresResult.reason?.message}`);
  if (bybitResult.status   === "rejected") errors.push(`Bybit L/S: ${bybitResult.reason?.message}`);

  const interpretation = interpretSignals({ candles, futures, bybit });
  const summary = buildSummary({ candles, futures, bybit, interpretation });

  const hasData = candles || futures || bybit;

  return {
    type: "btc_short_term_derivatives",
    status: hasData ? (errors.length ? "partial" : "ok") : "error",
    provider: "Binance (5m candles + Futures) + Bybit (Long/Short Ratio)",
    fetchedAt: new Date().toISOString(),
    summary,
    candles,
    futures,
    bybit,
    interpretation,
    errors,
    limitations: [
      "Data ini adalah snapshot real-time, bukan prediksi arah harga.",
      "Long/short ratio dari Bybit merepresentasikan akun, bukan nilai posisi.",
      "Funding rate mempengaruhi biaya hold, bukan arah harga langsung.",
      "Volume spike bisa berarti breakout ATAU exhaustion — butuh konteks.",
      "Market 5 menit Polymarket adalah sangat spekulatif dan penuh noise.",
    ],
  };
}
