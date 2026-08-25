import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startWebServer } from "../src/web.js";
import { resetProviderStatusCache } from "../src/provider-status.js";

function jsonRequest(port, requestPath = "/api/provider-status?cacheBust=ignored") {
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

test("provider-status is non-blocking, deduplicated, and safe", async (t) => {
  resetProviderStatusCache();
  const calls = [];
  let releaseFetch;
  const fetchGate = new Promise((resolve) => { releaseFetch = resolve; });
  let mode = "success";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (calls.length === 1) await fetchGate;
    if (mode === "network-failure") throw new Error("upstream secret must not leak");
    if (mode === "rate-limited") return new Response("upstream body must not leak", { status: 429 });
    return new Response("{}", { status: 200 });
  });

  const server = startWebServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const port = server.address().port;

  const firstResults = await Promise.all([jsonRequest(port), jsonRequest(port)]);
  assert.equal(firstResults[0].statusCode, 200);
  assert.deepEqual(firstResults[0].body.providers.map((provider) => provider.name), ["binance"]);
  assert.deepEqual(firstResults[0].body.providers[0], {
    name: "binance",
    label: "Binance",
    configured: true,
    reachable: null,
    status: "checking",
    latencyMs: null,
    error: null,
  });
  assert.deepEqual(firstResults[1].body, firstResults[0].body);
  assert.equal(calls.length, 1);

  releaseFetch();
  await flush();
  await flush();
  const connected = await jsonRequest(port);
  assert.equal(connected.body.providers[0].status, "connected");
  assert.equal(connected.body.providers[0].reachable, true);
  assert.equal(calls[0].pathname, "/api/v3/ping");

  mode = "rate-limited";
  let currentTime = Date.now();
  t.mock.method(Date, "now", () => currentTime);
  currentTime += 10_000;
  await jsonRequest(port, "/api/provider-status?cacheBust=rate");
  await flush();
  const rateLimited = await jsonRequest(port, "/api/provider-status?cacheBust=rate-result");
  assert.equal(rateLimited.body.providers[0].reachable, true);
  assert.equal(rateLimited.body.providers[0].status, "rate_limited");
  assert.equal(rateLimited.body.providers[0].error, "HTTP 429");

  mode = "network-failure";
  currentTime += 10_000;
  await jsonRequest(port, "/api/provider-status?cacheBust=network");
  await flush();
  const safeFailure = await jsonRequest(port, "/api/provider-status?cacheBust=network-result");
  assert.notEqual(safeFailure.body.providers[0].error, "upstream secret must not leak");
  assert.doesNotMatch(JSON.stringify(safeFailure.body), /upstream|body|secret|stack|data-api/i);
});
