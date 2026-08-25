import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startWebServer } from "../src/web.js";
import { getProviderStatuses, resetProviderStatusCache } from "../src/provider-status.js";

function jsonRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
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

test("provider-status uses non-blocking per-provider stale-while-revalidate", async (t) => {
  const calls = [];
  const timeoutValues = [];
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let binanceMode = "success";
  let gdeltCalls = 0;
  const originalTimeout = AbortSignal.timeout;

  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    timeoutValues.push(milliseconds);
    return originalTimeout.call(AbortSignal, milliseconds);
  });
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (calls.length <= 2) await fetchGate;
    if (url.pathname === "/api/v3/ping") {
      if (binanceMode === "network-failure") throw new Error("upstream secret should not leak");
      return new Response("{}", { status: 200 });
    }
    if (url.pathname === "/api/v2/doc/doc") {
      gdeltCalls += 1;
      return new Response("upstream body must not leak", { status: gdeltCalls === 1 ? 429 : 503 });
    }
    throw new Error(`unexpected health URL: ${url.pathname}`);
  });

  const server = startWebServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");

  const port = server.address().port;
  const firstResults = await Promise.all([
    jsonRequest(port, "/api/provider-status?cacheBust=first"),
    jsonRequest(port, "/api/provider-status?cacheBust=deduped"),
  ]);
  const result = firstResults[0];
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.providers.map((provider) => provider.name), ["binance", "gdelt"]);
  assert.deepEqual(result.body.providers.map((provider) => ({
    configured: provider.configured,
    reachable: provider.reachable,
    status: provider.status,
    latencyMs: provider.latencyMs,
    error: provider.error,
  })), [
    { configured: true, reachable: null, status: "checking", latencyMs: null, error: null },
    { configured: true, reachable: null, status: "checking", latencyMs: null, error: null },
  ]);
  assert.deepEqual(firstResults[1].body, result.body);
  assert.equal(calls.length, 2, "initial requests must share each provider's in-flight check");

  releaseFetch();
  await flush();
  await flush();
  assert.deepEqual(timeoutValues, [10_000, 25_000]);

  const firstRefresh = await jsonRequest(port, "/api/provider-status?cacheBust=refreshed");
  const binance = firstRefresh.body.providers[0];
  const gdelt = firstRefresh.body.providers[1];
  assert.equal(binance.reachable, true);
  assert.equal(binance.status, "connected");
  assert.equal(binance.error, null);
  assert.equal(gdelt.reachable, true);
  assert.equal(gdelt.status, "rate_limited");
  assert.equal(gdelt.error, "HTTP 429");
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.fromEntries(calls[1].searchParams), {
    query: "healthcheck",
    mode: "ArtList",
    format: "json",
    maxrecords: "1",
    timespan: "15min",
    sort: "DateDesc",
  });

  binanceMode = "network-failure";
  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  currentTime += 20_000;
  const staleSuccess = await jsonRequest(port, "/api/provider-status?cacheBust=stale");
  assert.equal(staleSuccess.body.providers[0].reachable, true);
  assert.equal(staleSuccess.body.providers[0].status, "connected");
  assert.equal(staleSuccess.body.providers[0].error, null);
  assert.equal(staleSuccess.body.providers[1].status, "rate_limited");
  assert.equal(calls.length, 3, "GDELT results must remain cached for at least 30 seconds");
  assert.deepEqual(timeoutValues, [10_000, 25_000, 10_000]);

  currentTime += 6_000;
  const failedRefresh = await jsonRequest(port, "/api/provider-status?cacheBust=retry");
  assert.equal(failedRefresh.body.providers[0].reachable, true);
  assert.equal(failedRefresh.body.providers[0].status, "connected");
  assert.equal(failedRefresh.body.providers[0].error, null);
  assert.equal(failedRefresh.body.providers[1].status, "rate_limited");
  assert.equal(calls.length, 4, "failed providers should retry on their short failure TTL");
  await flush();
  await flush();
  const disconnected = await jsonRequest(port, "/api/provider-status?cacheBust=disconnected");
  assert.equal(disconnected.body.providers[0].reachable, false);
  assert.equal(disconnected.body.providers[0].status, "disconnected");
  assert.equal(disconnected.body.providers[0].error, "request failed");
  assert.equal(calls.length, 4);

  currentTime += 300_000;
  await jsonRequest(port, "/api/provider-status?cacheBust=non2xx-refresh");
  await flush();
  await flush();
  const non2xx = await jsonRequest(port, "/api/provider-status?cacheBust=non2xx");
  assert.equal(non2xx.body.providers[1].reachable, true);
  assert.equal(non2xx.body.providers[1].status, "degraded");
  assert.equal(non2xx.body.providers[1].error, "HTTP 503");
  assert.equal(calls.length, 6, "both provider caches should refresh after their TTLs");
  assert.deepEqual(timeoutValues, [10_000, 25_000, 10_000, 10_000, 10_000, 25_000]);
  assert.doesNotMatch(JSON.stringify(result.body), /upstream|body|secret|stack|data-api|gdeltproject/i);
});

test("GDELT transport failures degrade twice, disconnect on the third, and reset", async (t) => {
  resetProviderStatusCache();
  let gdeltMode = "failure";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/v3/ping") return new Response("{}", { status: 200 });
    if (url.pathname !== "/api/v2/doc/doc") throw new Error("unexpected URL");
    if (gdeltMode === "success") return new Response("{}", { status: 200 });
    if (gdeltMode === "rate_limited") return new Response("body must not leak", { status: 429 });
    throw new Error("transport secret must not leak");
  });

  getProviderStatuses();
  await flush();
  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  const gdeltStatus = () => getProviderStatuses().find((provider) => provider.name === "gdelt");

  let status = gdeltStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.reachable, null);
  assert.equal(status.error, "request failed");

  currentTime += 60_000;
  gdeltStatus();
  await flush();
  status = gdeltStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.reachable, null);

  currentTime += 60_000;
  gdeltStatus();
  await flush();
  status = gdeltStatus();
  assert.equal(status.status, "disconnected");
  assert.equal(status.reachable, false);

  gdeltMode = "success";
  currentTime += 60_000;
  gdeltStatus();
  await flush();
  status = gdeltStatus();
  assert.equal(status.status, "connected");
  assert.equal(status.reachable, true);

  gdeltMode = "failure";
  currentTime += 60_000;
  gdeltStatus();
  await flush();
  status = gdeltStatus();
  assert.equal(status.status, "degraded");
  assert.equal(status.reachable, null);

  gdeltMode = "rate_limited";
  currentTime += 60_000;
  gdeltStatus();
  await flush();
  status = gdeltStatus();
  assert.equal(status.status, "rate_limited");
  assert.equal(status.reachable, true);
  assert.equal(status.error, "HTTP 429");
  gdeltMode = "failure";
  currentTime += 300_000;
  gdeltStatus();
  await flush();
  status = gdeltStatus();
  assert.equal(status.status, "degraded", "an HTTP response must reset the transient failure count");
  assert.equal(status.reachable, null);
  assert.doesNotMatch(JSON.stringify(status), /transport|secret|body|stack/i);
});
