import WebSocket from "ws";

const LIQUIDATION_WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";
const TARGET_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "DOGEUSDT"]);

const DEPTH_STREAMS = Array.from(TARGET_SYMBOLS).map(sym => `${sym.toLowerCase()}@depth20@100ms`).join('/');
const DEPTH_WS_URL = `wss://fstream.binance.com/stream?streams=${DEPTH_STREAMS}`;

// In-memory store: { "BTCUSDT": [ { timestamp, side, price, qty, value }, ... ] }
const liquidations = {};
TARGET_SYMBOLS.forEach(sym => liquidations[sym] = []);

// Keep only liquidations from the last 15 minutes
const MAX_AGE_MS = 15 * 60 * 1000; 

// In-memory store for Orderbook Depth
// { "BTCUSDT": { bidsValue: 0, asksValue: 0, imbalanceRatio: 1, lastUpdate: 0 } }
const orderbookDepth = {};
TARGET_SYMBOLS.forEach(sym => orderbookDepth[sym] = { bidsValue: 0, asksValue: 0, imbalanceRatio: 1, lastUpdate: 0 });

let wsLiquidations = null;
let wsDepth = null;
let isShuttingDown = false;

function cleanUpOldLiquidations(symbol, now) {
  liquidations[symbol] = liquidations[symbol].filter(liq => (now - liq.timestamp) <= MAX_AGE_MS);
}

export function startBinanceLiquidationStream() {
  if (wsLiquidations) return;
  
  console.log("[Binance WS] Menghubungkan ke Liquidation Stream...");
  wsLiquidations = new WebSocket(LIQUIDATION_WS_URL);

  wsLiquidations.on("open", () => {
    console.log("[Binance WS] Terhubung ke Liquidation Stream (!forceOrder@arr)");
  });

  wsLiquidations.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.e === "forceOrder" && msg.o) {
        const symbol = msg.o.s;
        if (!TARGET_SYMBOLS.has(symbol)) return;

        const side = msg.o.S; // "SELL" = Long liquidated, "BUY" = Short liquidated
        const price = parseFloat(msg.o.p);
        const qty = parseFloat(msg.o.q);
        const value = price * qty;
        const timestamp = msg.E;

        const liqData = {
          timestamp,
          type: side === "SELL" ? "LONG_LIQ" : "SHORT_LIQ",
          price,
          qty,
          value
        };

        liquidations[symbol].push(liqData);
        cleanUpOldLiquidations(symbol, Date.now());
        
        // Log besar (opsional) jika value > $10k
        if (value >= 10000) {
           // console.log(`[Binance WS] 🚨 ${liqData.type} on ${symbol}: $${value.toFixed(2)} at ${price}`);
        }
      }
    } catch (err) {
      console.error("[Binance WS] Parsing error:", err.message);
    }
  });

  wsLiquidations.on("close", () => {
    console.log("[Binance WS] Koneksi Liquidation terputus.");
    wsLiquidations = null;
    if (!isShuttingDown) {
      setTimeout(startBinanceLiquidationStream, 5000); // Reconnect
    }
  });

  wsLiquidations.on("error", (err) => {
    console.error("[Binance WS] Liquidation Error:", err.message);
    wsLiquidations.close();
  });
}

export function startBinanceDepthStream() {
  if (wsDepth) return;
  
  console.log("[Binance WS] Menghubungkan ke Depth Stream...");
  wsDepth = new WebSocket(DEPTH_WS_URL);

  wsDepth.on("open", () => {
    console.log("[Binance WS] Terhubung ke Depth Stream (20-levels, 100ms)");
  });

  wsDepth.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.stream && msg.data && msg.data.e === "depthUpdate") {
        // stream name is like "btcusdt@depth20@100ms"
        const symbol = msg.stream.split("@")[0].toUpperCase();
        if (!TARGET_SYMBOLS.has(symbol)) return;

        let bidsValue = 0;
        let asksValue = 0;

        // data.b is an array of [price, quantity] for Bids
        if (msg.data.b) {
          for (const bid of msg.data.b) {
            bidsValue += parseFloat(bid[0]) * parseFloat(bid[1]);
          }
        }
        
        // data.a is an array of [price, quantity] for Asks
        if (msg.data.a) {
          for (const ask of msg.data.a) {
            asksValue += parseFloat(ask[0]) * parseFloat(ask[1]);
          }
        }

        const imbalanceRatio = asksValue === 0 ? 1 : bidsValue / asksValue;
        
        orderbookDepth[symbol] = {
          bidsValue,
          asksValue,
          imbalanceRatio,
          lastUpdate: Date.now()
        };
      }
    } catch (err) {
      console.error("[Binance WS] Depth parsing error:", err.message);
    }
  });

  wsDepth.on("close", () => {
    console.log("[Binance WS] Koneksi Depth terputus.");
    wsDepth = null;
    if (!isShuttingDown) {
      setTimeout(startBinanceDepthStream, 5000); // Reconnect
    }
  });

  wsDepth.on("error", (err) => {
    console.error("[Binance WS] Depth Error:", err.message);
    wsDepth.close();
  });
}

export function stopBinanceLiquidationStream() {
  isShuttingDown = true;
  if (wsLiquidations) {
    wsLiquidations.close();
    wsLiquidations = null;
  }
}

export function stopBinanceDepthStream() {
  isShuttingDown = true;
  if (wsDepth) {
    wsDepth.close();
    wsDepth = null;
  }
}

/**
 * Returns the latest orderbook depth imbalance for the given symbol.
 */
export function getOrderbookImbalance(symbol) {
  if (!orderbookDepth[symbol]) return null;
  
  // If the data is older than 10 seconds, it might be stale
  if (Date.now() - orderbookDepth[symbol].lastUpdate > 10000) {
    return null;
  }

  return orderbookDepth[symbol];
}

/**
 * Returns a summary of liquidations for the given symbol over the last `minutes` (up to 15).
 */
export function getRecentLiquidations(symbol, minutes = 15) {
  if (!liquidations[symbol]) return { longsLiqValue: 0, shortsLiqValue: 0, totalCount: 0 };

  const now = Date.now();
  const cutoff = now - (minutes * 60 * 1000);
  
  cleanUpOldLiquidations(symbol, now);
  
  let longsLiqValue = 0;
  let shortsLiqValue = 0;
  let totalCount = 0;

  for (const liq of liquidations[symbol]) {
    if (liq.timestamp >= cutoff) {
      totalCount++;
      if (liq.type === "LONG_LIQ") longsLiqValue += liq.value;
      if (liq.type === "SHORT_LIQ") shortsLiqValue += liq.value;
    }
  }

  return {
    longsLiqValue,
    shortsLiqValue,
    totalCount
  };
}
