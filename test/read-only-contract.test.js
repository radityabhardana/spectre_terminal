import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

test("order execution and private-wallet modules are absent", () => {
  assert.equal(existsSync(path.join(root, "src", "trade.js")), false);
  assert.equal(existsSync(path.join(root, "src", "wallet.js")), false);

  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies?.["@polymarket/clob-client"], undefined);
  assert.equal(pkg.dependencies?.ethers, "^6.17.0", "ethers remains required by the read-only Polygon tracker");

  const configSource = read("src/config.js");
  assert.match(configSource, /RETIRED_ENV_KEYS/);
  assert.match(configSource, /delete process\.env\[key\]/);
});

test("runtime routes and config contain no retired execution or reflection surface", () => {
  const runtime = ["src/web.js", "src/config.js", "src/storage.js", "src/index.js", "src/qwen.js"]
    .map(read)
    .join("\n");
  for (const retired of [
    "/api/execute-trade",
    "/api/wallet-stream",
    "/api/reflections",
    "/api/evaluate/single",
    "/api/evaluate/all",
    "/api/settings/short-memory",
    "prediction_reflections",
    "trade_requests",
    "trade_executions",
    "enableLiveTrading",
    "walletPrivateKey",
    "enableAiReflectionMemory",
  ]) {
    assert.equal(runtime.includes(retired), false, `runtime must not contain ${retired}`);
  }
});

test("retired secret names are absent while read-only data providers remain", () => {
  const example = read(".env.example");
  for (const key of [
    "ENABLE_LIVE_TRADING",
    "WALLET_PRIVATE_KEY",
    "CLOB_API_KEY",
    "CLOB_API_SECRET",
    "CLOB_API_PASSPHRASE",
    "ENABLE_AI_REFLECTION_MEMORY",
    "TRADE_MAX_PRICE",
    "TRADE_FEE_BUFFER_CENTS",
    "TRADE_MIN_SECONDS_TO_CLOSE",
  ]) {
    assert.equal(example.includes(key), false, `.env.example must not contain ${key}`);
  }
  assert.match(example, /POLYMARKET_CLOB_URL=/);
  assert.match(example, /POLYGON_RPC_URL=/);
  assert.match(example, /ENTRY_MAX_PRICE=/);
});

test("frontend removes execution, portfolio, and learning UI but keeps tracked-wallet intelligence", () => {
  const frontend = ["public/index.html", "public/app.js", "public/terminal-shell.js"].map(read).join("\n");
  for (const retired of [
    "tradePanelModal",
    "btnExecuteTrade",
    "pmRightPanel",
    "walletPortfolioValue",
    "pane-learning",
    "reflectionContainer",
    "btnEvaluateAllHistory",
    "Execution Generation",
    "Stop Loss:",
    "Take Profit:",
    "/api/execute-trade",
    "/api/wallet-stream",
    "/api/reflections",
  ]) {
    assert.equal(frontend.includes(retired), false, `frontend must not contain ${retired}`);
  }
  assert.match(frontend, /trackerCardPaneWallet/);
  assert.match(frontend, /\/api\/wallet-profile\//);
});
