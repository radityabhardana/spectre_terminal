import { startWebServer } from "./web.js";
import { startSniffer } from "./sniffer.js";
import { initBlockchainTracker } from "./blockchain-tracker.js";
import { startBinanceLiquidationStream, stopBinanceLiquidationStream, startBinanceDepthStream, stopBinanceDepthStream } from "./binance_ws.js";

const webServer = startWebServer();

// Initialize global.livePrices before sniffer starts writing to it
if (!global.livePrices) global.livePrices = {};

startSniffer(); // Start the live whale sniffer
initBlockchainTracker(); // Start the Polygon on-chain wallet tracker
startBinanceLiquidationStream(); // Start binance websocket liquidations
startBinanceDepthStream(); // Start binance websocket depth

console.log("Starting web UI and market-data services (Telegram disabled).");

let shuttingDown = false;
function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down gracefully...");
  stopBinanceLiquidationStream();
  stopBinanceDepthStream();
  if (webServer.listening) {
    webServer.close(() => process.exit(exitCode));
  } else {
    process.exit(exitCode);
  }
  setTimeout(() => process.exit(exitCode || 1), 5000).unref();
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
