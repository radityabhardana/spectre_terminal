import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { resetProviderConnectionCache } from "../src/qwen.js";
import { startWebServer } from "../src/web.js";

function jsonRequest(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/api/engine-status?cacheBust=ignored",
      headers: { host: `127.0.0.1:${port}` },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
  });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("engine-status is ordered, non-blocking, isolated, and secret-safe", async (t) => {
  resetProviderConnectionCache();
  const calls = [];
  let releaseInitial;
  const initialGate = new Promise((resolve) => { releaseInitial = resolve; });

  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (calls.length <= 4) await initialGate;
    if (url.pathname === "/api/v3/ping") return new Response("{}", { status: 200 });
    if (url.pathname === "/events") return new Response("{}", { status: 200 });
    if (url.pathname === "/time") return new Response("upstream secret", { status: 429 });
    if (url.pathname === "/v1/models") return new Response("qwen secret", { status: 429 });
    throw new Error(`unexpected upstream URL: ${url.pathname}`);
  });

  const server = startWebServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const port = server.address().port;

  const firstResults = await Promise.all([jsonRequest(port), jsonRequest(port)]);
  const first = firstResults[0];
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body.engines.map((engine) => engine.id), ["gamma", "clob", "qwen", "local", "binance"]);
  assert.deepEqual(first.body.engines.slice(0, 3).map((engine) => ({
    reachable: engine.reachable,
    status: engine.status,
    latencyMs: engine.latencyMs,
    error: engine.error,
  })), [
    { reachable: null, status: "checking", latencyMs: null, error: null },
    { reachable: null, status: "checking", latencyMs: null, error: null },
    { reachable: null, status: "checking", latencyMs: null, error: null },
  ]);
  assert.equal(first.body.engines[3].status, "connected");
  assert.equal(calls.length, 4, "concurrent endpoint calls must share each engine refresh");

  releaseInitial();
  await flush();
  await flush();
  const refreshed = await jsonRequest(port);
  const refreshedById = new Map(refreshed.body.engines.map((engine) => [engine.id, engine]));
  assert.equal(refreshedById.get("gamma").status, "connected");
  assert.equal(refreshedById.get("clob").reachable, true);
  assert.equal(refreshedById.get("clob").status, "rate_limited");
  assert.equal(refreshedById.get("qwen").reachable, true);
  assert.equal(refreshedById.get("qwen").status, "rate_limited");
  assert.equal(refreshedById.get("local").latencyMs, 0);
  const gammaCall = calls.find((url) => url.pathname === "/events");
  assert.equal(gammaCall.searchParams.get("limit"), "1");
  assert.equal(gammaCall.searchParams.get("active"), "true");
  assert.equal(calls.find((url) => url.pathname === "/time").search, "");
  assert.doesNotMatch(JSON.stringify(refreshed.body), /secret|upstream|stack|authorization|Bearer/i);

  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  currentTime += 31_000;
  const duringRefresh = await jsonRequest(port);
  const duringById = new Map(duringRefresh.body.engines.map((engine) => [engine.id, engine]));
  assert.equal(duringById.get("binance").status, "connected");
  assert.equal(duringById.get("binance").reachable, true);
  assert.equal(calls.length, 8, "expired engines refresh independently");
});
