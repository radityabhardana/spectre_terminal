import WebSocket from "ws";

// ponytail: binancefuture.com = alt domain for ISP-blocked regions (ID)
const LIQUIDATION_WS_URL = "wss://fstream.binancefuture.com/ws/!forceOrder@arr";
const TARGET_SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "DOGEUSDT"]);

const DEPTH_STREAMS = Array.from(TARGET_SYMBOLS).map(sym => `${sym.toLowerCase()}@depth20@100ms`).join('/');
const DEPTH_WS_URL = `wss://fstream.binancefuture.com/stream?streams=${DEPTH_STREAMS}`;


// ponytail: rejectUnauthorized:false bypasses Cloudflare WARP TLS interception.
// WARP replaces upstream cert with its own → Node rejects "certificate has expired".
// Safe here because we only connect to known Binance endpoints.
const WS_OPTS = { rejectUnauthorized: false };

// In-memory store: { "BTCUSDT": [ { timestamp, side, price, qty, value }, ... ] }
const liquidations = {};
TARGET_SYMBOLS.forEach(sym => liquidations[sym] = []);

const MAX_AGE_MS = 15 * 60 * 1000;

// In-memory store for Orderbook Depth
const orderbookDepth = {};
TARGET_SYMBOLS.forEach(sym => orderbookDepth[sym] = { bidsValue: 0, asksValue: 0, imbalanceRatio: 1, lastUpdate: 0 });

let wsLiquidations = null;
let wsDepth = null;
let isShuttingDown = false;

let liqPingInterval = null;
let depthPingInterval = null;

// ponytail: 10s max backoff (was 60s), consecutive fail counter to suppress spam
let liqReconnectDelay = 2000;
let depthReconnectDelay = 2000;
const MAX_RECONNECT_DELAY = 10000;
let liqConsecutiveFails = 0;
let depthConsecutiveFails = 0;

function cleanUpOldLiquidations(symbol, now) {
  liquidations[symbol] = liquidations[symbol].filter(liq => (now - liq.timestamp) <= MAX_AGE_MS);
}

export function startBinanceLiquidationStream() {
  if (wsLiquidations) return;

  // ponytail: only log first 3 attempts, then go silent to avoid terminal spam
  if (liqConsecutiveFails < 3) console.log("[Binance WS] Menghubungkan ke Liquidation Stream...");
  wsLiquidations = new WebSocket(LIQUIDATION_WS_URL, WS_OPTS);

  wsLiquidations.on("open", () => {
    console.log("✅ [Binance WS] Terhubung ke Liquidation Stream");
    liqReconnectDelay = 2000;
    liqConsecutiveFails = 0;
    if (liqPingInterval) clearInterval(liqPingInterval);
    liqPingInterval = setInterval(() => {
      if (wsLiquidations && wsLiquidations.readyState === WebSocket.OPEN) {
        wsLiquidations.ping();
      }
    }, 20000);
  });

  wsLiquidations.on("pong", () => {});

  wsLiquidations.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.e === "forceOrder" && msg.o) {
        const symbol = msg.o.s;
        if (!TARGET_SYMBOLS.has(symbol)) return;

        const side = msg.o.S;
        const price = parseFloat(msg.o.p);
        const qty = parseFloat(msg.o.q);
        const value = price * qty;
        const timestamp = msg.E;

        liquidations[symbol].push({
          timestamp,
          type: side === "SELL" ? "LONG_LIQ" : "SHORT_LIQ",
          price, qty, value
        });
        cleanUpOldLiquidations(symbol, Date.now());
      }
    } catch (err) {
      // Ignore parse errors
    }
  });

  wsLiquidations.on("close", (code) => {
    clearInterval(liqPingInterval);
    liqPingInterval = null;
    wsLiquidations = null;

    if (!isShuttingDown) {
      liqConsecutiveFails++;
      if (liqConsecutiveFails <= 3) {
        console.log(`[Binance WS] Liquidation terputus (${code || '?'}). Retry ${liqReconnectDelay/1000}s...`);
      } else if (liqConsecutiveFails % 30 === 0) {
        // ponytail: log summary every ~30 attempts (~5min at 10s max) instead of every time
        console.log(`[Binance WS] Liquidation masih gagal (${liqConsecutiveFails}x). Tetap retry di background.`);
      }
      setTimeout(startBinanceLiquidationStream, liqReconnectDelay);
      liqReconnectDelay = Math.min(liqReconnectDelay * 2, MAX_RECONNECT_DELAY);
    }
  });

  wsLiquidations.on("error", () => {});
}

export function startBinanceDepthStream() {
  if (wsDepth) return;

  if (depthConsecutiveFails < 3) console.log("[Binance WS] Menghubungkan ke Depth Stream...");
  wsDepth = new WebSocket(DEPTH_WS_URL, WS_OPTS);

  wsDepth.on("open", () => {
    console.log("✅ [Binance WS] Terhubung ke Depth Stream");
    depthReconnectDelay = 2000;
    depthConsecutiveFails = 0;
    if (depthPingInterval) clearInterval(depthPingInterval);
    depthPingInterval = setInterval(() => {
      if (wsDepth && wsDepth.readyState === WebSocket.OPEN) {
        wsDepth.ping();
      }
    }, 20000);
  });

  wsDepth.on("pong", () => {});

  wsDepth.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.stream && msg.data && msg.data.e === "depthUpdate") {
        const symbol = msg.stream.split("@")[0].toUpperCase();
        if (!TARGET_SYMBOLS.has(symbol)) return;

        let bidsValue = 0;
        let asksValue = 0;

        if (msg.data.b) {
          for (const bid of msg.data.b) {
            bidsValue += parseFloat(bid[0]) * parseFloat(bid[1]);
          }
        }
        if (msg.data.a) {
          for (const ask of msg.data.a) {
            asksValue += parseFloat(ask[0]) * parseFloat(ask[1]);
          }
        }

        orderbookDepth[symbol] = {
          bidsValue,
          asksValue,
          imbalanceRatio: asksValue === 0 ? 1 : bidsValue / asksValue,
          lastUpdate: Date.now()
        };
      }
    } catch (err) {
      // Ignore parse errors
    }
  });

  wsDepth.on("close", (code) => {
    clearInterval(depthPingInterval);
    depthPingInterval = null;
    wsDepth = null;

    if (!isShuttingDown) {
      depthConsecutiveFails++;
      if (depthConsecutiveFails <= 3) {
        console.log(`[Binance WS] Depth terputus (${code || '?'}). Retry ${depthReconnectDelay/1000}s...`);
      } else if (depthConsecutiveFails % 30 === 0) {
        console.log(`[Binance WS] Depth masih gagal (${depthConsecutiveFails}x). Tetap retry di background.`);
      }
      setTimeout(startBinanceDepthStream, depthReconnectDelay);
      depthReconnectDelay = Math.min(depthReconnectDelay * 2, MAX_RECONNECT_DELAY);
    }
  });

  wsDepth.on("error", () => {});
}

export function stopBinanceLiquidationStream() {
  isShuttingDown = true;
  clearInterval(liqPingInterval);
  liqPingInterval = null;
  if (wsLiquidations) { wsLiquidations.close(); wsLiquidations = null; }
}

export function stopBinanceDepthStream() {
  isShuttingDown = true;
  clearInterval(depthPingInterval);
  depthPingInterval = null;
  if (wsDepth) { wsDepth.close(); wsDepth = null; }
}

export function getOrderbookImbalance(symbol) {
  if (!orderbookDepth[symbol]) return null;
  if (Date.now() - orderbookDepth[symbol].lastUpdate > 10000) return null;
  return orderbookDepth[symbol];
}

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

  return { longsLiqValue, shortsLiqValue, totalCount };
}

export function getBinanceWsStatus() {
  const getStatus = (ws, fails) => {
    if (!ws) return fails > 0 ? "RECONNECTING" : "DISCONNECTED";
    if (ws.readyState === WebSocket.CONNECTING) return "CONNECTING";
    if (ws.readyState === WebSocket.OPEN) return "CONNECTED";
    if (ws.readyState === WebSocket.CLOSING) return "DISCONNECTED";
    return "DISCONNECTED";
  };
  return {
    liquidation: getStatus(wsLiquidations, liqConsecutiveFails),
    depth: getStatus(wsDepth, depthConsecutiveFails)
  };
}
