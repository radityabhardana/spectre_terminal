import { askQwenShortCondition } from "./qwen.js";
import { scrapeTwitter } from "./twitter_scraper.js";
import { getRecentLiquidations, getOrderbookImbalance } from "./binance_ws.js";

const BINANCE_BASE_URLS = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
  'https://data-api.binance.vision'
];

async function fetchWithFallback(endpoints, path, options) {
  for (const base of endpoints) {
    try {
      const res = await fetch(base + path, options);
      if (res.ok) return res;
    } catch (e) {
      // Continue to next
    }
  }
  throw new Error("All endpoints failed");
}

// Fetch 24h ticker + klines + RSI/MACD dari Binance
async function fetchBinanceTechData(symbol = "BTCUSDT", intervalMinutes = 5) {
  try {
    const interval = intervalMinutes <= 5 ? "5m" : intervalMinutes <= 15 ? "15m" : "1h";
    const klinePath = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=60`;
    const tickerPath = `/api/v3/ticker/24hr?symbol=${symbol}`;

    const [klineRes, tickerRes] = await Promise.all([
      fetchWithFallback(BINANCE_BASE_URLS, klinePath, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }),
      fetchWithFallback(BINANCE_BASE_URLS, tickerPath, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }),
    ]);

    if (!klineRes.ok || !tickerRes.ok) throw new Error("Binance kline/ticker error");
    const klines = await klineRes.json();
    const ticker = await tickerRes.json();

    const closes  = klines.map(k => parseFloat(k[4]));
    const volumes = klines.map(k => parseFloat(k[5]));

    // RSI-14
    const rsiPeriod = 14;
    let gains = 0, losses = 0;
    for (let i = closes.length - rsiPeriod; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    const avgGain = gains / rsiPeriod;
    const avgLoss = losses / rsiPeriod;
    const rs  = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = Math.round(100 - (100 / (1 + rs)));

    // EMA helper
    const ema = (data, period) => {
      const k = 2 / (period + 1);
      let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
      return val;
    };

    // MACD (12, 26, 9)
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine      = parseFloat((ema12 - ema26).toFixed(2));
    const macdSignal    = parseFloat(ema(closes.slice(-15).map((c, i, arr) => i >= 9 ? ema(arr.slice(0, i + 1), 12) - ema(arr.slice(0, i + 1), 26) : 0).filter(v => v !== 0), 9).toFixed(2));
    const macdHistogram = parseFloat((macdLine - macdSignal).toFixed(2));

    // Volume ratio: last vs 10-candle avg
    const avgVol10 = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
    const lastVol  = volumes[volumes.length - 1];
    const volRatio = avgVol10 > 0 ? parseFloat((lastVol / avgVol10).toFixed(2)) : 1;

    // Recent 5 candles
    const recentCandles = klines.slice(-5).map(k => ({
      time:      new Date(k[0]).toISOString().slice(11, 16),
      open:      parseFloat(k[1]).toFixed(2),
      close:     parseFloat(k[4]).toFixed(2),
      direction: parseFloat(k[4]) >= parseFloat(k[1]) ? 'UP' : 'DOWN',
      vol:       parseFloat(k[5]).toFixed(1),
    }));

    return {
      symbol, interval,
      currentPrice:   parseFloat(ticker.lastPrice).toFixed(2),
      priceChange24h: parseFloat(ticker.priceChangePercent).toFixed(2),
      high24h:        parseFloat(ticker.highPrice).toFixed(2),
      low24h:         parseFloat(ticker.lowPrice).toFixed(2),
      volume24h:      parseFloat(ticker.volume).toFixed(2),
      rsi14:          rsi,
      rsiSignal:      rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : rsi > 55 ? 'BULLISH ZONE' : rsi < 45 ? 'BEARISH ZONE' : 'NEUTRAL',
      macd:           { line: macdLine, signal: macdSignal, histogram: macdHistogram, trend: macdHistogram > 0 ? 'BULLISH' : 'BEARISH' },
      volumeRatio:    volRatio,
      volumeSignal:   volRatio > 1.5 ? 'HIGH (strong momentum)' : volRatio < 0.7 ? 'LOW (weak)' : 'NORMAL',
      recentCandles,
    };
  } catch (err) {
    console.error("[Short Condition] fetchBinanceTechData error:", err.message);
    return null;
  }
}

const BINANCE_FAPI_URLS = [
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com'
];

// Fetch Binance Futures Long/Short ratio
async function fetchLongShortRatio(symbol = "BTCUSDT") {
  try {
    const path = `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`;
    const res = await fetchWithFallback(BINANCE_FAPI_URLS, path, { headers: { 'Cache-Control': 'no-cache' } });
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    const latest = data[data.length - 1];
    const ratio  = parseFloat(latest.longShortRatio).toFixed(3);
    const longPct = parseFloat(latest.longAccount * 100).toFixed(1);
    const shortPct = parseFloat(latest.shortAccount * 100).toFixed(1);
    return { ratio, longPct, shortPct, bias: parseFloat(ratio) >= 1 ? 'LONG_DOMINANT' : 'SHORT_DOMINANT' };
  } catch (err) {
    console.error("[Short Condition] fetchLongShortRatio error:", err.message);
    return null;
  }
}

// Fallback: hanya fetch 24h ticker (tanpa kline / RSI / MACD)
async function fetchBinanceTickerOnly(symbol = "BTCUSDT") {
  try {
    const res = await fetchWithFallback(BINANCE_BASE_URLS, `/api/v3/ticker/24hr?symbol=${symbol}`, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error("Ticker API error");
    const d = await res.json();
    return {
      symbol,
      interval: 'n/a',
      currentPrice:   parseFloat(d.lastPrice).toFixed(2),
      priceChange24h: parseFloat(d.priceChangePercent).toFixed(2),
      high24h:        parseFloat(d.highPrice).toFixed(2),
      low24h:         parseFloat(d.lowPrice).toFixed(2),
      volume24h:      parseFloat(d.volume).toFixed(2),
      rsi14:          null,
      rsiSignal:      'unavailable (kline error)',
      macd:           null,
      volumeRatio:    null,
      volumeSignal:   'unavailable (kline error)',
      recentCandles:  null,
      fallback:       true,
    };
  } catch (err) {
    console.error("[Short Condition] fetchBinanceTickerOnly error:", err.message);
    return null;
  }
}

// Fetch Fear & Greed Index (alternative.me)
async function fetchFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", { headers: { 'Cache-Control': 'no-cache' } });
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

export async function evaluateShortMarketCondition({ signal = null, currentPriceStr = "", asset = "BTC" }) {
  const symbol = asset === "ETH" ? "ETHUSDT" : asset === "DOGE" ? "DOGEUSDT" : "BTCUSDT";

  // If full kline data fails, fall back to ticker-only (no RSI/MACD but still functional)
  let techData = await fetchBinanceTechData(symbol, 5);
  if (!techData) {
    console.warn("[Short Condition] Kline fetch gagal, mencoba ticker fallback...");
    techData = await fetchBinanceTickerOnly(symbol);
  }
  if (!techData) throw new Error("Gagal mengambil data Binance (kline dan ticker keduanya gagal). Periksa koneksi internet.");

  // Override price if live Polymarket WebSocket price provided
  if (currentPriceStr && !isNaN(parseFloat(currentPriceStr))) {
    techData.currentPrice = parseFloat(currentPriceStr).toFixed(2);
  }

  // Fetch remaining data sources in parallel (all gracefully fail to null)
  const [longShort, fearGreed, tweets] = await Promise.all([
    fetchLongShortRatio(symbol),
    fetchFearGreed(),
    scrapeTwitter("Bitcoin OR Crypto").catch(() => []),
  ]);

  // Liquidations (Websocket 15m)
  const liqData = getRecentLiquidations(symbol, 15);

  // Orderbook Depth (Websocket 100ms)
  const depthData = getOrderbookImbalance(symbol);

  // Ask Qwen
  const result = await askQwenShortCondition({ techData, longShort, fearGreed, tweets, signal, liquidations: liqData, orderbookDepth: depthData });

  return { techData, longShort, fearGreed, liquidations: liqData, depth: depthData, evaluation: result };
}
