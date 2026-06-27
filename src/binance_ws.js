import WebSocket from "ws";

const LIQUIDATION_WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr";
const TARGET_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "DOGEUSDT"]);

// In-memory store: { "BTCUSDT": [ { timestamp, side, price, qty, value }, ... ] }
const liquidations = {};
TARGET_SYMBOLS.forEach(sym => liquidations[sym] = []);

// Keep only liquidations from the last 15 minutes
const MAX_AGE_MS = 15 * 60 * 1000; 

let ws = null;
let isShuttingDown = false;

function cleanUpOldLiquidations(symbol, now) {
  liquidations[symbol] = liquidations[symbol].filter(liq => (now - liq.timestamp) <= MAX_AGE_MS);
}

export function startBinanceLiquidationStream() {
  if (ws) return;
  
  console.log("[Binance WS] Menghubungkan ke Liquidation Stream...");
  ws = new WebSocket(LIQUIDATION_WS_URL);

  ws.on("open", () => {
    console.log("[Binance WS] Terhubung ke Liquidation Stream (!forceOrder@arr)");
  });

  ws.on("message", (data) => {
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

  ws.on("close", () => {
    console.log("[Binance WS] Koneksi terputus.");
    ws = null;
    if (!isShuttingDown) {
      setTimeout(startBinanceLiquidationStream, 5000); // Reconnect
    }
  });

  ws.on("error", (err) => {
    console.error("[Binance WS] Error:", err.message);
    ws.close();
  });
}

export function stopBinanceLiquidationStream() {
  isShuttingDown = true;
  if (ws) {
    ws.close();
    ws = null;
  }
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
