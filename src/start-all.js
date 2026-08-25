import { startWebServer } from "./web.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig, config } from "./config.js";
import { startBtc15mObserveCollector, stopBtc15mObserveCollector } from "./short-observe-coordinator.js";
import { startSniffer, stopSniffer } from "./sniffer.js";
import { initBlockchainTracker, stopBlockchainTracker } from "./blockchain-tracker.js";
import { startBinanceLiquidationStream, stopBinanceLiquidationStream, startBinanceDepthStream, stopBinanceDepthStream } from "./binance_ws.js";

export const DEFAULT_SERVER_CLOSE_DEADLINE_MS = 4500;
export const DEFAULT_SAFE_EXIT_DEADLINE_MS = 5000;
export const DEFAULT_COLLECTOR_DRAIN_DEADLINE_MS = 5000;

function onceAfterListening(server, callback) {
  if (server.listening) {
    queueMicrotask(callback);
    return;
  }
  server.once("listening", callback);
}

function closeServer(server, deadlineMs = 5000) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (deadline != null) clearTimeout(deadline);
      resolve();
    };
    const forceClose = () => {
      try { server.closeAllConnections?.(); } catch (error) { console.error("[WEB SERVER CLOSE]:", error?.message || error); }
      try { server.closeIdleConnections?.(); } catch (error) { console.error("[WEB SERVER CLOSE]:", error?.message || error); }
      finish();
    };
    deadline = setTimeout(forceClose, Math.max(0, deadlineMs));
    try { server.close(finish); } catch { finish(); }
  });
}

function installSignals(shutdown, processObject = process) {
  processObject.on("SIGINT", shutdown);
  processObject.on("SIGTERM", shutdown);
}

export function startAll(dependencies = {}) {
  const assertConfigFn = dependencies.assertConfig || assertConfig;
  const createServer = dependencies.startWebServer || startWebServer;
  const startCollector = dependencies.startCollector || startBtc15mObserveCollector;
  const stopCollector = dependencies.stopCollector || stopBtc15mObserveCollector;
  const collectorEnabled = dependencies.collectorEnabled ?? config.shortObserverBtc15mEnabled;
  const startSnifferFn = dependencies.startSniffer || startSniffer;
  const stopSnifferFn = dependencies.stopSniffer || stopSniffer;
  const initBlockchainTrackerFn = dependencies.initBlockchainTracker || initBlockchainTracker;
  const stopBlockchainTrackerFn = dependencies.stopBlockchainTracker || stopBlockchainTracker;
  const startLiquidationFn = dependencies.startBinanceLiquidationStream || startBinanceLiquidationStream;
  const stopLiquidationFn = dependencies.stopBinanceLiquidationStream || stopBinanceLiquidationStream;
  const startDepthFn = dependencies.startBinanceDepthStream || startBinanceDepthStream;
  const stopDepthFn = dependencies.stopBinanceDepthStream || stopBinanceDepthStream;
  const processObject = dependencies.process || process;
  const exit = dependencies.exit || ((code) => processObject.exit(code));
  const serverCloseDeadlineMs = dependencies.serverCloseDeadlineMs ?? DEFAULT_SERVER_CLOSE_DEADLINE_MS;
  const safeExitDeadlineMs = dependencies.safeExitDeadlineMs ?? DEFAULT_SAFE_EXIT_DEADLINE_MS;
  const collectorDrainDeadlineMs = dependencies.collectorDrainDeadlineMs ?? DEFAULT_COLLECTOR_DRAIN_DEADLINE_MS;

  assertConfigFn();
  const webServer = createServer(dependencies.serverOptions || {});
  let shuttingDown = false;
  let shutdownPromise = null;
  let collectorStartCalled = false;
  let collectorStartInvoked = false;
  let collectorStartPromise = null;

  if (!global.livePrices) global.livePrices = {};
  if (!global.livePriceTimestamps) global.livePriceTimestamps = {};

  startSnifferFn()
    .then(() => {
      if (!shuttingDown) initBlockchainTrackerFn();
    })
    .catch((error) => console.error("[Sniffer] Startup error:", error?.message || error));
  startLiquidationFn();
  startDepthFn();

  const startCollectorAfterListening = () => {
    if (shuttingDown || collectorStartCalled || !collectorEnabled) return;
    collectorStartCalled = true;
    collectorStartPromise = Promise.resolve()
      .then(async () => {
        if (shuttingDown) return false;
        collectorStartInvoked = true;
        await startCollector();
        return true;
      })
      .catch((error) => console.error("[Short observer] Startup error:", error?.message || error));
  };
  onceAfterListening(webServer, startCollectorAfterListening);

  async function shutdown(exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      const code = typeof exitCode === "number" ? exitCode : 0;
      console.log("Shutting down gracefully...");
      stopSnifferFn();
      stopBlockchainTrackerFn();
      stopLiquidationFn();
      stopDepthFn();
      if (collectorStartCalled) {
        const lifecycle = [collectorStartPromise || Promise.resolve(false)];
        if (collectorStartInvoked) {
          lifecycle.push(Promise.resolve().then(() => stopCollector()).catch((error) => {
            console.error("[Short observer] Shutdown error:", error?.message || error);
          }));
        }
        let drainTimer = null;
        await Promise.race([
          Promise.all(lifecycle),
          new Promise((resolve) => { drainTimer = setTimeout(resolve, Math.max(0, collectorDrainDeadlineMs)); }),
        ]);
        if (drainTimer != null) clearTimeout(drainTimer);
      }
      const safeExit = setTimeout(() => exit(code), Math.max(0, safeExitDeadlineMs));
      safeExit.unref?.();
      try {
        await closeServer(webServer, serverCloseDeadlineMs);
      } finally {
        clearTimeout(safeExit);
      }
      exit(code);
    })();
    return shutdownPromise;
  }

  if (dependencies.installSignals !== false) installSignals(shutdown, processObject);
  webServer.on("error", (error) => {
    console.error("[WEB SERVER FATAL]:", error?.message || error);
    void shutdown(1);
  });
  if (dependencies.installProcessErrorHandlers !== false) {
    processObject.on("uncaughtException", (error) => {
      console.error("[UNCAUGHT EXCEPTION]:", error?.stack || error);
      void shutdown(1);
    });
    processObject.on("unhandledRejection", (reason) => {
      console.error("[UNHANDLED REJECTION]:", reason?.stack || reason);
      void shutdown(1);
    });
  }

  console.log("Starting web UI and market-data services (Telegram disabled).");
  return { webServer, shutdown };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) startAll();
