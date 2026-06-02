import fs from "node:fs";
import path from "node:path";

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.resolve(process.cwd(), ".env"));

function positiveInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded > 0 ? rounded : fallback;
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  qwenApiKey: process.env.QWEN_API_KEY || "",
  qwenBaseUrl:
    process.env.QWEN_BASE_URL ||
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  qwenFastModel: process.env.QWEN_FAST_MODEL || "qwen-flash",
  qwenAnalystModel: process.env.QWEN_ANALYST_MODEL || "qwen-plus",
  qwenFinalModel: process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || "qwen-max",
  gammaUrl:
    process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com",
  clobUrl: process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com",
  binanceBaseUrl: process.env.BINANCE_BASE_URL || "https://data-api.binance.vision",
  binanceFuturesBaseUrl:
    process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com",
  defillamaBaseUrl: process.env.DEFILLAMA_BASE_URL || "https://api.llama.fi",
  defillamaStablecoinsUrl:
    process.env.DEFILLAMA_STABLECOINS_URL || "https://stablecoins.llama.fi",
  fearGreedUrl: process.env.FEAR_GREED_URL || "https://api.alternative.me/fng/",
  gdeltDocUrl:
    process.env.GDELT_DOC_URL || "https://api.gdeltproject.org/api/v2/doc/doc",
  maxQwenInputChars: positiveInt(process.env.MAX_QWEN_INPUT_CHARS, 7000),
  qwenMaxTokens: positiveInt(process.env.QWEN_MAX_TOKENS, 10000),
  cacheTtlSeconds: positiveInt(process.env.CACHE_TTL_SECONDS, 60),
  cryptoCacheTtlSeconds: positiveInt(process.env.CRYPTO_CACHE_TTL_SECONDS, 10),
  fundamentalCacheTtlSeconds: positiveInt(process.env.FUNDAMENTAL_CACHE_TTL_SECONDS, 900),
  newsCacheTtlSeconds: positiveInt(process.env.NEWS_CACHE_TTL_SECONDS, 900),
  researchFetchTimeoutMs: positiveInt(process.env.RESEARCH_FETCH_TIMEOUT_MS, 8000),
};

export function assertConfig() {
  const missing = [];
  if (!config.telegramToken) missing.push("TELEGRAM_BOT_TOKEN");
  if (!config.qwenApiKey) missing.push("QWEN_API_KEY");

  if (missing.length) {
    throw new Error(
      `Missing env: ${missing.join(", ")}. Copy .env.example to .env and fill it.`
    );
  }
}
