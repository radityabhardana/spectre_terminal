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

function nonNegativeInt(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  const rounded = Math.floor(num);
  return rounded >= 0 ? rounded : fallback;
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  qwenApiKey: process.env.QWEN_API_KEY || "",
  qwenApiKeyBackup: process.env.QWEN_API_KEY_BACKUP || "",
  qwenBaseUrl:
    process.env.QWEN_BASE_URL ||
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  // Model Roles for Single Market Analysis
  qwenBullModel: process.env.QWEN_BULL_MODEL || process.env.QWEN_FAST_MODEL || "qwen-turbo",
  qwenBearModel: process.env.QWEN_BEAR_MODEL || process.env.QWEN_ANALYST_MODEL || "qwen-plus",
  qwenRiskManagerModel: process.env.QWEN_RISK_MANAGER_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || "qwen-max",
  
  // Model Role for Learning/Post-Mortem
  qwenEvaluatorModel: process.env.QWEN_EVALUATOR_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || "qwen-max",

  // Model Roles for Multi-Market Event Analysis
  qwenScoutModel: process.env.QWEN_SCOUT_MODEL || process.env.QWEN_FAST_MODEL || "qwen-turbo",
  qwenEventAnalystModel: process.env.QWEN_EVENT_ANALYST_MODEL || process.env.QWEN_ANALYST_MODEL || "qwen-plus",
  qwenEventFinalModel: process.env.QWEN_EVENT_FINAL_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || "qwen-max",

  customApiKey: process.env.CUSTOM_API_KEY || "",
  customBaseUrl: process.env.CUSTOM_BASE_URL || "",
  customFinalModel: process.env.CUSTOM_FINAL_MODEL || "",

  conduitApiKey: process.env.CONDUIT_API_KEY || "",
  conduitBaseUrl: process.env.CONDUIT_BASE_URL || "https://conduit.ozdoev.net/v1",
  conduitModel: process.env.CONDUIT_MODEL || "claude-haiku-4-5",
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
  commandCooldownMs: nonNegativeInt(process.env.COMMAND_COOLDOWN_MS, 3000),
  qwenCommandCooldownMs: nonNegativeInt(process.env.QWEN_COMMAND_COOLDOWN_MS, 45000),
  duplicateCommandCooldownMs: nonNegativeInt(process.env.DUPLICATE_COMMAND_COOLDOWN_MS, 3000),
  webPassword: process.env.WEB_PASSWORD || "",
  minQwenConfidence: positiveInt(process.env.MIN_QWEN_CONFIDENCE, 80),
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

export function assertQwenConfig() {
  if (!config.qwenApiKey) {
    throw new Error("Missing env: QWEN_API_KEY. Copy .env.example to .env and fill it.");
  }
}
