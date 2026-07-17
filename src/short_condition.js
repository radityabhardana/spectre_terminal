import { askQwenShortCondition } from "./qwen.js";
import { getRecentLiquidations, getOrderbookImbalance } from "./binance_ws.js";

// Bypass Cloudflare WARP TLS block for Node.js native fetch
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const BINANCE_BASE_URLS = [
  'https://api.binancefuture.com', // Best for Indonesia/ISP Blocks
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
    const interval = intervalMinutes <= 5 ? "5m" : intervalMinutes <= 15 ? "15m" : intervalMinutes <= 60 ? "1h" : "4h";
    const klinePath = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=60`;
    const tickerPath = `/fapi/v1/ticker/24hr?symbol=${symbol}`;

    const [klineRes, tickerRes] = await Promise.all([
      fetchWithFallback(BINANCE_FAPI_URLS, klinePath, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }),
      fetchWithFallback(BINANCE_FAPI_URLS, tickerPath, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }),
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

    // ATR-14 (Average True Range)
    const atrPeriod = 14;
    let trs = [];
    for (let i = klines.length - atrPeriod; i < klines.length; i++) {
      const high = parseFloat(klines[i][2]);
      const low = parseFloat(klines[i][3]);
      const prevClose = i > 0 ? parseFloat(klines[i-1][4]) : parseFloat(klines[i][1]);
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trs.push(tr);
    }
    const atr14 = trs.reduce((a, b) => a + b, 0) / atrPeriod;

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
      atr14:          parseFloat(atr14.toFixed(2)),
      rsi14:          rsi,
      rsiSignal:      rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : rsi > 55 ? 'BULLISH ZONE' : rsi < 45 ? 'BEARISH ZONE' : 'NEUTRAL',
      macd:           { line: macdLine, signal: macdSignal, histogram: macdHistogram, trend: macdHistogram > 0 ? 'BULLISH' : 'BEARISH' },
      volumeRatio:    volRatio,
      volumeSignal:   volRatio > 1.5 ? 'HIGH (strong momentum)' : volRatio < 0.7 ? 'LOW (weak)' : 'NORMAL',
      recentCandles,
    };
  } catch (err) {
    // Silent catch due to frequent ISP blocking
    // console.error("[Short Condition] fetchBinanceTechData error:", err.message);
    return null;
  }
}

const BINANCE_FAPI_URLS = [
  'https://fapi.binancefuture.com', // Best for Indonesia/ISP Blocks
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com'
];

let longShortRatioCache = {}; // Symbol-specific cache: { [symbol]: { data, timestamp } }
const CACHE_DURATION_MS = 30 * 1000; // 30 detik (agar selalu fresh tapi anti-spam)

// Fetch Binance Futures Long/Short ratio
async function fetchLongShortRatio(symbol = "BTCUSDT") {
  const now = Date.now();
  if (longShortRatioCache[symbol] && (now - longShortRatioCache[symbol].timestamp < CACHE_DURATION_MS)) {
    return longShortRatioCache[symbol].data;
  }

  try {
    const path = `/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=3`;
    const res = await fetchWithFallback(BINANCE_FAPI_URLS, path, { headers: { 'Cache-Control': 'no-cache' } });
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

export async function evaluateShortMarketCondition({ signal = null, currentPriceStr = "", asset = "BTC", marketQuestion = "", marketOutcomePrice = null }) {
  const symbol = asset === "ETH" ? "ETHUSDT" : asset === "DOGE" ? "DOGEUSDT" : "BTCUSDT";

  // Extract target price from market question
  let targetPrice = null;
  if (marketQuestion) {
    const match = marketQuestion.match(/\$([0-9,]+(\.[0-9]+)?)/);
    if (match) {
      targetPrice = parseFloat(match[1].replace(/,/g, ''));
    }
  }

    // Fetch Pyth Oracle Data
    let pythPrice = null;
    const pythIds = {
      BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
      ETH: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
      DOGE: "dcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c"
    };
    const pid = pythIds[asset];
    if (pid) {
      try {
        const pythCtrl = new AbortController();
        const pythTimeout = setTimeout(() => pythCtrl.abort(), 5000);
        
        const pRes = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${pid}`, { signal: pythCtrl.signal });
        clearTimeout(pythTimeout);
        if (pRes.ok) {
          const pData = await pRes.json();
          const pInfo = pData.parsed?.[0]?.price;
          if (pInfo) {
            pythPrice = parseFloat(pInfo.price) * Math.pow(10, pInfo.expo);
          }
        }
        
        // Dynamically fetch Target Price (Opening Price) for 5-minute Up/Down markets
        if (!targetPrice && marketQuestion.toLowerCase().includes("up or down")) {
           let msInterval = 5 * 60 * 1000;
           const mqLower = marketQuestion.toLowerCase();
           if (mqLower.includes("4h")) {
               msInterval = 4 * 60 * 60 * 1000;
           } else if (mqLower.includes("1h") || mqLower.includes("1 hour")) {
               msInterval = 60 * 60 * 1000;
           } else if (mqLower.includes("15m") || mqLower.includes("15 min")) {
               msInterval = 15 * 60 * 1000;
           }
           const startTs = Math.floor((Math.floor(Date.now() / msInterval) * msInterval) / 1000);
           const kCtrl = new AbortController();
           const kTimeout = setTimeout(() => kCtrl.abort(), 5000);
           let kRes = await fetch(`https://hermes.pyth.network/v2/updates/price/${startTs}?ids[]=${pid}`, { signal: kCtrl.signal });
           clearTimeout(kTimeout);
           if (!kRes.ok) {
             const kCtrl2 = new AbortController();
             const kTimeout2 = setTimeout(() => kCtrl2.abort(), 5000);
             kRes = await fetch(`https://hermes.pyth.network/v2/updates/price/${startTs - 5}?ids[]=${pid}`, { signal: kCtrl2.signal });
             clearTimeout(kTimeout2);
           }
           if (kRes.ok) {
              const kData = await kRes.json();
              const kInfo = kData.parsed?.[0]?.price;
              if (kInfo) {
                 targetPrice = parseFloat(kInfo.price) * Math.pow(10, kInfo.expo);
              }
           }
        }
      } catch(err) {
        if (err.name === 'AbortError') {
          console.warn("[Short Condition] Pyth Oracle timeout (>5s), skipping.");
        } else {
          console.warn("[Short Condition] Failed to fetch Pyth Oracle:", err.message);
        }
      }
    }

  let intervalMinutes = 5;
  const mqLower = marketQuestion.toLowerCase();
  if (mqLower.includes("4h")) intervalMinutes = 240;
  else if (mqLower.includes("1h") || mqLower.includes("1 hour")) intervalMinutes = 60;
  else if (mqLower.includes("15m") || mqLower.includes("15 min")) intervalMinutes = 15;

  let tickerData = await fetchBinanceTechData(symbol, intervalMinutes);
  
  if (!tickerData) {
    if (pythPrice) {
      tickerData = {
        symbol,
        interval: 'n/a',
        currentPrice: pythPrice.toFixed(2),
        priceChange24h: '0.00',
        high24h: pythPrice.toFixed(2),
        low24h: pythPrice.toFixed(2),
        volume24h: '0.00',
        rsi14: null,
        rsiSignal: 'unavailable',
        macd: null,
        volumeRatio: null,
        volumeSignal: 'unavailable',
        recentCandles: null,
        fallback: true
      };
    } else {
      throw new Error("Gagal mengambil data ticker Binance maupun Oracle Pyth. Periksa koneksi internet.");
    }
  }

  // Override price if live Polymarket WebSocket price provided
  if (currentPriceStr && !isNaN(parseFloat(currentPriceStr))) {
    tickerData.currentPrice = parseFloat(currentPriceStr).toFixed(2);
  }

  // Fetch remaining data sources in parallel (all gracefully fail to null)
  const [longShort, fearGreed] = await Promise.all([
    fetchLongShortRatio(symbol),
    fetchFearGreed(),
  ]);

  // Liquidations (Websocket 15m)
  const liqData = getRecentLiquidations(symbol, 15);

  // Orderbook Depth (Websocket 100ms)
  const depthData = getOrderbookImbalance(symbol);

  // Calculate Base Probability mechanically
  let baseProbability = 50;
  if (targetPrice && tickerData && tickerData.atr14) {
    const currentP = pythPrice || parseFloat(tickerData.currentPrice);
    const distance = targetPrice - currentP;
    const relDistance = Math.abs(distance) / tickerData.atr14;

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
      const isBullish = tickerData.macd.trend === 'BULLISH';
      if (isAboveMarket) {
        trendAdjustment += isBullish ? 5 : -5;
      } else if (isBelowMarket) {
        trendAdjustment += isBullish ? -5 : 5;
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
      pythPrice,
      marketQuestion,
      marketOutcomePrice,
      baseProbability
    });

    // Celah 1b: EV Math in Backend with Safety Buffer (+2 cents)
    let evOverrideActive = false;
    if (result.estimated_fair_probability && marketOutcomePrice) {
       const ev = (result.estimated_fair_probability / 100) - marketOutcomePrice;
       result.expected_value_cents = Math.round(ev * 100);
       
       if (ev <= 0.02 && result.recommendation === "PLAY") {
          result.recommendation = "AVOID";
          evOverrideActive = true; // Mark so Scout Override cannot re-enable PLAY
          result.reason = `[EV OVERRIDE] Margin EV terlalu tipis/negatif (${result.expected_value_cents} cents <= 2 cents). Rekomendasi Qwen dibatalkan demi keamanan matematis.\nAsli: ` + (result.reason || "");
       }
    }

    // marketOutcomePrice = harga token UP/YES di CLOB (0.0 - 1.0)
    // Token DOWN/NO = 1 - upPrice (karena binary market)
    const upTokenPrice = marketOutcomePrice;
    const downTokenPrice = upTokenPrice !== null ? parseFloat((1 - upTokenPrice).toFixed(4)) : null;

    // Mechanical Scout Override (Optimize WR by trusting crowd/market over AI if strong)
    // Threshold 0.62/0.38 — captures cases where crowd is clearly >60% to one side
    // Celah 2: Kondisional Volume Momentum (Anti-Squeeze Blindness)
    // GUARDRAIL: Scout Override TIDAK BOLEH menimpa EV Override (sesuai AGENTS.md)
    const isExtremeSqueeze = tickerData?.volumeRatio > 2.0;

    if (upTokenPrice !== null && !isExtremeSqueeze && !evOverrideActive) {
      if (upTokenPrice >= 0.62) {
        // Crowd sangat dominan percaya arah UP
        result.direction = "UP";
        result.recommendation = "PLAY";
        result.reason = `[SCOUT OVERRIDE] Crowd dominan arah UP — Token UP: ${(upTokenPrice * 100).toFixed(1)}% vs DOWN: ${(downTokenPrice * 100).toFixed(1)}%. Mengabaikan keraguan Qwen demi Win Rate.\nAsli: ` + (result.reason || "");
      } else if (downTokenPrice !== null && downTokenPrice >= 0.62) {
        // Crowd sangat dominan percaya arah DOWN
        result.direction = "DOWN";
        result.recommendation = "PLAY";
        result.reason = `[SCOUT OVERRIDE] Crowd dominan arah DOWN — Token DOWN: ${(downTokenPrice * 100).toFixed(1)}% vs UP: ${(upTokenPrice * 100).toFixed(1)}%. Mengabaikan keraguan Qwen demi Win Rate.\nAsli: ` + (result.reason || "");
      }
    } else if (evOverrideActive && upTokenPrice !== null && (upTokenPrice >= 0.62 || (downTokenPrice !== null && downTokenPrice >= 0.62))) {
      // Scout ingin override tapi EV guardrail sudah aktif — blokir
      result.reason = `[SCOUT OVERRIDE BLOCKED] EV guardrail aktif (EV ≤ 2 cents). Scout tidak diizinkan override. Crowd signal diabaikan.\n` + (result.reason || "");
    } else if (isExtremeSqueeze && upTokenPrice !== null && (upTokenPrice >= 0.62 || (downTokenPrice !== null && downTokenPrice >= 0.62))) {
      result.reason = `[SCOUT OVERRIDE CANCELLED] Terdeteksi anomali volume momentum ekstrem (Ratio: ${tickerData?.volumeRatio}x). Mengikuti murni hasil AI.\n` + (result.reason || "");
    }
  
    return { tickerData, liquidations: liqData, depth: depthData, pythPrice, targetPrice, evaluation: result, usage: result.usage };
}
