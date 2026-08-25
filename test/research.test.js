import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const projectRoot = new URL("..", import.meta.url);
const tempDatabaseDir = mkdtempSync(path.join(tmpdir(), "razor-research-"));
const tempDatabasePath = path.join(tempDatabaseDir, "database.db");
process.env.RAZOR_DATABASE_PATH = tempDatabasePath;

after(() => {
  rmSync(tempDatabaseDir, { recursive: true, force: true });
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function installResearchFetchStub() {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url.includes("ff_calendar_thisweek")) return jsonResponse([]);
    if (url.includes("html.duckduckgo.com")) return new Response("");
    if (url.includes("api.alternative.me")) return jsonResponse({ data: [] });
    if (url.includes("/api/v3/ticker/24hr")) {
      return jsonResponse({
        lastPrice: "100000",
        weightedAvgPrice: "99000",
        priceChange: "1000",
        priceChangePercent: "1.01",
        highPrice: "101000",
        lowPrice: "98000",
        volume: "100",
        quoteVolume: "10000000",
        count: 1000,
        closeTime: Date.now(),
      });
    }
    if (url.includes("/api/v3/ticker/bookTicker")) {
      return jsonResponse({ bidPrice: "99999", bidQty: "1", askPrice: "100001", askQty: "1" });
    }
    if (url.includes("/api/v3/klines") || url.includes("/fapi/v1/klines")) return jsonResponse([]);
    if (url.includes("/fapi/v1/globalLongShortAccountRatio")) return jsonResponse([]);
    if (url.includes("/fapi/v1/premiumIndex")) return jsonResponse({ time: Date.now() });
    if (url.includes("/fapi/v1/openInterest")) return jsonResponse({ time: Date.now() });

    return jsonResponse({});
  };

  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("importing research does not initialize or log a UFC dataset", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", 'await import("./src/research.js")'],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, RAZOR_DATABASE_PATH: tempDatabasePath },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /\bUFC\b|ufc_dataset|dataset.*memory/i);
});

test("a non-crypto sports market uses general research without fighter fields", async () => {
  const restoreFetch = installResearchFetchStub();
  try {
    const { buildResearchContext } = await import("../src/research.js");
    const context = await buildResearchContext({
      market: { question: "Will Jon Jones win his next MMA fight?" },
    });

    assert.equal(context.type, "general");
    assert.equal("fighters" in context, false);
    assert.equal("fighterConditions" in context, false);
  } finally {
    restoreFetch();
  }
});

test("crypto research classification remains intact", async () => {
  const restoreFetch = installResearchFetchStub();
  try {
    const { buildResearchContext } = await import("../src/research.js");
    const context = await buildResearchContext({
      market: { question: "Will Bitcoin trade above $100,000 tomorrow?" },
    });

    assert.equal(context.type, "crypto");
    assert.deepEqual(context.detectedAssets.map((asset) => asset.symbol), ["BTC"]);
    assert.equal("fighters" in context, false);
    assert.equal("fighterConditions" in context, false);
  } finally {
    restoreFetch();
  }
});
