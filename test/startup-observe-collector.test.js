import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DEFAULT_SAFE_EXIT_DEADLINE_MS as START_ALL_SAFE_EXIT_DEADLINE_MS, DEFAULT_SERVER_CLOSE_DEADLINE_MS as START_ALL_SERVER_CLOSE_DEADLINE_MS, startAll } from "../src/start-all.js";
import { DEFAULT_SAFE_EXIT_DEADLINE_MS as WEB_SAFE_EXIT_DEADLINE_MS, DEFAULT_SERVER_CLOSE_DEADLINE_MS as WEB_SERVER_CLOSE_DEADLINE_MS, startWebRuntime } from "../src/web.js";

class FakeServer extends EventEmitter {
  constructor(order = [], hangsOnClose = false) {
    super();
    this.listening = false;
    this.order = order;
    this.hangsOnClose = hangsOnClose;
  }

  close(callback) {
    this.order.push("server-close");
    this.listening = false;
    if (!this.hangsOnClose) callback?.();
  }

  closeAllConnections() {
    this.order.push("close-all-connections");
  }

  closeIdleConnections() {
    this.order.push("close-idle-connections");
  }
}

function noDataDependencies() {
  return {
    assertConfig: () => {},
    startSniffer: async () => {},
    stopSniffer: () => {},
    initBlockchainTracker: () => {},
    stopBlockchainTracker: () => {},
    startBinanceLiquidationStream: () => {},
    stopBinanceLiquidationStream: () => {},
    startBinanceDepthStream: () => {},
    stopBinanceDepthStream: () => {},
    installSignals: false,
    installProcessErrorHandlers: false,
    exit: () => {},
  };
}

test("importing web startup helpers has no collector or server side effect", async () => {
  let started = 0;
  const imported = await import("../src/web.js?startup-import-no-op");
  assert.equal(typeof imported.startWebRuntime, "function");
  assert.equal(started, 0);
});

test("default forced close deadlines precede the safe exit fallback", () => {
  assert.ok(START_ALL_SERVER_CLOSE_DEADLINE_MS < START_ALL_SAFE_EXIT_DEADLINE_MS);
  assert.ok(WEB_SERVER_CLOSE_DEADLINE_MS < WEB_SAFE_EXIT_DEADLINE_MS);
});

test("disabled start-all startup does not invoke the collector", async () => {
  const server = new FakeServer(); let started = 0;
  const runtime = startAll({
    ...noDataDependencies(), collectorEnabled: false, startWebServer: () => server,
    startCollector: () => { started += 1; },
  });
  server.listening = true; server.emit("listening"); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 0); await runtime.shutdown();
});

test("start-all starts the enabled collector once after listening and drains it before server close", async () => {
  const order = []; const server = new FakeServer(order); let starts = 0; let stops = 0;
  const runtime = startAll({
    ...noDataDependencies(), collectorEnabled: true, startWebServer: () => server,
    startCollector: () => { starts += 1; order.push("collector-start"); },
    stopCollector: async () => { stops += 1; order.push("collector-stop"); },
  });
  assert.equal(starts, 0); server.listening = true; server.emit("listening"); server.emit("listening");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1); await runtime.shutdown();
  assert.equal(stops, 1); assert.deepEqual(order, ["collector-start", "collector-stop", "server-close"]);
});

test("direct web runtime starts the enabled collector once after listening", async () => {
  const server = new FakeServer(); let starts = 0; let stops = 0;
  const runtime = startWebRuntime({
    collectorEnabled: true, startWebServer: () => server, installSignals: false, exit: () => {},
    startCollector: () => { starts += 1; }, stopCollector: async () => { stops += 1; },
  });
  server.listening = true; server.emit("listening"); await new Promise((resolve) => setImmediate(resolve)); server.emit("listening");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1); await runtime.shutdown(); assert.equal(stops, 1);
});

test("direct web shutdown awaits collector stop before closing the server", async () => {
  const order = []; const server = new FakeServer(order); let releaseStop;
  const runtime = startWebRuntime({
    collectorEnabled: true, startWebServer: () => server, installSignals: false, exit: () => {},
    startCollector: () => {},
    stopCollector: () => new Promise((resolve) => { order.push("stop-called"); releaseStop = () => { order.push("stop-resolved"); resolve(); }; }),
  });
  server.listening = true; server.emit("listening"); await new Promise((resolve) => setImmediate(resolve));
  const stopping = runtime.shutdown(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["stop-called"]); releaseStop(); await stopping;
  assert.deepEqual(order, ["stop-called", "stop-resolved", "server-close"]);
});

test("start-all immediate post-listening shutdown cancels the queued collector start", async () => {
  const server = new FakeServer(); let starts = 0; let stops = 0;
  const runtime = startAll({
    ...noDataDependencies(), collectorEnabled: true, startWebServer: () => server,
    startCollector: () => { starts += 1; }, stopCollector: () => { stops += 1; },
  });
  server.listening = true; server.emit("listening"); const stopping = runtime.shutdown(); await stopping;
  assert.equal(starts, 0); assert.equal(stops, 0);
});

test("direct web immediate post-listening shutdown cancels the queued collector start", async () => {
  const server = new FakeServer(); let starts = 0; let stops = 0;
  const runtime = startWebRuntime({
    collectorEnabled: true, startWebServer: () => server, installSignals: false, exit: () => {},
    startCollector: () => { starts += 1; }, stopCollector: () => { stops += 1; },
  });
  server.listening = true; server.emit("listening"); const stopping = runtime.shutdown(); await stopping;
  assert.equal(starts, 0); assert.equal(stops, 0);
});

test("start-all bounds a hung server close and forces connections closed", async () => {
  const order = []; const server = new FakeServer(order, true);
  const runtime = startAll({
    ...noDataDependencies(), collectorEnabled: false, startWebServer: () => server,
    serverCloseDeadlineMs: 10, safeExitDeadlineMs: 1000,
  });
  server.listening = true; server.emit("listening"); await runtime.shutdown();
  assert.deepEqual(order, ["server-close", "close-all-connections", "close-idle-connections"]);
});

test("direct web bounds a hung server close and forces connections closed", async () => {
  const order = []; const server = new FakeServer(order, true);
  const runtime = startWebRuntime({
    collectorEnabled: false, startWebServer: () => server, installSignals: false, exit: () => {},
    serverCloseDeadlineMs: 10, safeExitDeadlineMs: 1000,
  });
  server.listening = true; server.emit("listening"); await runtime.shutdown();
  assert.deepEqual(order, ["server-close", "close-all-connections", "close-idle-connections"]);
});

test("start-all sequences delayed collector drain before server force-close and safe exit", async () => {
  const order = []; const server = new FakeServer(order, true); let releaseStop;
  const runtime = startAll({
    ...noDataDependencies(), collectorEnabled: true, startWebServer: () => server,
    collectorDrainDeadlineMs: 10, serverCloseDeadlineMs: 10, safeExitDeadlineMs: 30,
    startCollector: () => {}, stopCollector: () => new Promise((resolve) => { order.push("stop-called"); releaseStop = resolve; }),
    exit: () => order.push("exit"),
  });
  server.listening = true; server.emit("listening"); await new Promise((resolve) => setImmediate(resolve));
  await runtime.shutdown(); releaseStop();
  assert.deepEqual(order, ["stop-called", "server-close", "close-all-connections", "close-idle-connections", "exit"]);
});

test("direct web sequences delayed collector drain before server force-close and safe exit", async () => {
  const order = []; const server = new FakeServer(order, true); let releaseStop;
  const runtime = startWebRuntime({
    collectorEnabled: true, startWebServer: () => server, installSignals: false,
    collectorDrainDeadlineMs: 10, serverCloseDeadlineMs: 10, safeExitDeadlineMs: 30,
    startCollector: () => {}, stopCollector: () => new Promise((resolve) => { order.push("stop-called"); releaseStop = resolve; }),
    exit: () => order.push("exit"),
  });
  server.listening = true; server.emit("listening"); await new Promise((resolve) => setImmediate(resolve));
  await runtime.shutdown(); releaseStop();
  assert.deepEqual(order, ["stop-called", "server-close", "close-all-connections", "close-idle-connections", "exit"]);
});
