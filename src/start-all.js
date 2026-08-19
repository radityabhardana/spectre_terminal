import { startWebServer } from "./web.js";
import { assertConfig } from "./config.js";
import { startSniffer, stopSniffer } from "./sniffer.js";
import { initBlockchainTracker, stopBlockchainTracker } from "./blockchain-tracker.js";
import { startBinanceLiquidationStream, stopBinanceLiquidationStream, startBinanceDepthStream, stopBinanceDepthStream } from "./binance_ws.js";

assertConfig();
const webServer = startWebServer();
let shuttingDown = false;

// Initialize global.livePrices before sniffer starts writing to it
if (!global.livePrices) global.livePrices = {};
if (!global.livePriceTimestamps) global.livePriceTimestamps = {};

startSniffer()
  .then(() => {
    if (!shuttingDown) initBlockchainTracker();
  })
  .catch((error) => console.error("[Sniffer] Startup error:", error?.message || error));
startBinanceLiquidationStream(); // Start binance websocket liquidations
startBinanceDepthStream(); // Start binance websocket depth

console.log("Starting web UI and market-data services (Telegram disabled).");

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down gracefully...");
  stopSniffer();
  stopBlockchainTracker();
  stopBinanceLiquidationStream();
  stopBinanceDepthStream();
  const code = typeof exitCode === "number" ? exitCode : 0;
  if (webServer.listening) {
    webServer.close(() => process.exit(code));
  } else {
    process.exit(code);
  }
  setTimeout(() => process.exit(code), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
webServer.on("error", (error) => {
  console.error("[WEB SERVER FATAL]:", error?.message || error);
  shutdown(1);
});
process.on("uncaughtException", (error) => {
  console.error("[UNCAUGHT EXCEPTION]:", error?.stack || error);
  shutdown(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]:", reason?.stack || reason);
  shutdown(1);
});
