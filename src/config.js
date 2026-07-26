import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

loadDotEnv(path.join(projectRoot, ".env"));

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

function positiveNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function probabilityPrice(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 && num < 1 ? num : fallback;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

const nineRouterApiKey = process.env.NINEROUTER_API_KEY || process.env.NINE_ROUTER_API_KEY || process.env.NINEROUTER_KEY || "";
const openRouterApiKey = process.env.OPENROUTER_API_KEY || "";
const directQwenApiKey = process.env.QWEN_API_KEY || "";
const aiProvider = nineRouterApiKey
  ? {
      name: "9router",
      apiKey: nineRouterApiKey,
      baseUrl: process.env.NINEROUTER_BASE_URL || process.env.NINE_ROUTER_BASE_URL || process.env.NINEROUTER_URL || "http://127.0.0.1:20128/v1",
    }
  : openRouterApiKey
    ? {
        name: "openrouter",
        apiKey: openRouterApiKey,
        baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      }
    : {
        name: "dashscope",
        apiKey: directQwenApiKey,
        baseUrl: process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      };
const defaultModels = aiProvider.name === "9router"
  ? {
      fast: "alims-intl/deepseek-v4-flash",
      analyst: "alims-intl/deepseek-v4-flash",
      final: "alims-intl/deepseek-v4-pro",
      evaluator: "alims-intl/deepseek-v3.2",
    }
  : aiProvider.name === "dashscope"
    ? { fast: "qwen-turbo", analyst: "qwen-plus", final: "qwen-max", evaluator: "qwen-max" }
    : { fast: "", analyst: "", final: "", evaluator: "" };

export const config = {
  aiProviderName: aiProvider.name,
  qwenApiKey: aiProvider.apiKey,
  qwenApiKeyBackup: process.env.QWEN_API_KEY_BACKUP || "",
  qwenBackupBaseUrl: normalizeBaseUrl(process.env.QWEN_BACKUP_BASE_URL),
  qwenBaseUrl: normalizeBaseUrl(aiProvider.baseUrl),
  // Model Roles for Single Market Analysis
  qwenBullModel: process.env.QWEN_BULL_MODEL || process.env.QWEN_FAST_MODEL || defaultModels.fast,
  qwenBearModel: process.env.QWEN_BEAR_MODEL || process.env.QWEN_ANALYST_MODEL || defaultModels.analyst,
  qwenRiskManagerModel: process.env.QWEN_RISK_MANAGER_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.final,

  // Model Role for Learning/Post-Mortem
  qwenEvaluatorModel: process.env.QWEN_EVALUATOR_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.evaluator,
  qwenShortModel: process.env.QWEN_SHORT_MODEL || process.env.QWEN_BULL_MODEL || process.env.QWEN_FAST_MODEL || defaultModels.fast,

  // Model Roles for Multi-Market Event Analysis
  qwenScoutModel: process.env.QWEN_SCOUT_MODEL || process.env.QWEN_FAST_MODEL || defaultModels.fast,
  qwenEventAnalystModel: process.env.QWEN_EVENT_ANALYST_MODEL || process.env.QWEN_ANALYST_MODEL || defaultModels.analyst,
  qwenEventFinalModel: process.env.QWEN_EVENT_FINAL_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.final,

  customApiKey: process.env.CUSTOM_API_KEY || "",
  customBaseUrl: normalizeBaseUrl(process.env.CUSTOM_BASE_URL),
  customFinalModel: process.env.CUSTOM_FINAL_MODEL || "",

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
  qwenShortMaxTokens: positiveInt(process.env.QWEN_SHORT_MAX_TOKENS, 2400),
  qwenRequestTimeoutMs: positiveInt(process.env.QWEN_REQUEST_TIMEOUT_MS, 90000),
  polymarketRequestTimeoutMs: positiveInt(process.env.POLYMARKET_REQUEST_TIMEOUT_MS, 10000),
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
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || "",
  clobApiKey: process.env.CLOB_API_KEY || "",
  clobApiSecret: process.env.CLOB_API_SECRET || "",
  clobApiPassphrase: process.env.CLOB_API_PASSPHRASE || "",
  enableLiveTrading: process.env.ENABLE_LIVE_TRADING === "true",
  maxTradeUsdc: positiveNumber(process.env.MAX_TRADE_USDC, 10),
  maxTradeBatchUsdc: positiveNumber(process.env.MAX_TRADE_BATCH_USDC, 25),
  maxDailyTradeUsdc: positiveNumber(process.env.MAX_DAILY_TRADE_USDC, 50),
  maxTradesPerRequest: positiveInt(process.env.MAX_TRADES_PER_REQUEST, 3),
  tradeSignalTtlSeconds: positiveInt(process.env.TRADE_SIGNAL_TTL_SECONDS, 60),
  tradeMaxPrice: probabilityPrice(process.env.TRADE_MAX_PRICE, 0.70),
  tradeFeeBufferCents: positiveNumber(process.env.TRADE_FEE_BUFFER_CENTS, 4),
  tradeMinSecondsToClose: positiveInt(process.env.TRADE_MIN_SECONDS_TO_CLOSE, 30),
  allowInsecureTls: process.env.ALLOW_INSECURE_TLS === "true",
  enableAiReflectionMemory: process.env.ENABLE_AI_REFLECTION_MEMORY === "true",
};

export function assertConfig() {
  const missing = [];
  if (!config.qwenApiKey) missing.push("NINEROUTER_API_KEY, OPENROUTER_API_KEY, or QWEN_API_KEY");

  if (missing.length) {
    throw new Error(
      `Missing env: ${missing.join(", ")}. Copy .env.example to .env and fill it.`
    );
  }
}

export function assertQwenConfig() {
  if (!config.qwenApiKey) {
    throw new Error("Missing AI provider key. Configure NINEROUTER_API_KEY, OPENROUTER_API_KEY, or QWEN_API_KEY.");
  }
  const models = [config.qwenBullModel, config.qwenBearModel, config.qwenRiskManagerModel, config.qwenEvaluatorModel, config.qwenShortModel, config.qwenScoutModel, config.qwenEventAnalystModel, config.qwenEventFinalModel];
  if (models.some((model) => !String(model || "").trim())) {
    throw new Error("All AI role model IDs must be configured for the selected provider.");
  }
  const customValues = [config.customApiKey, config.customBaseUrl, config.customFinalModel].filter(Boolean);
  if (customValues.length > 0 && customValues.length < 3) {
    throw new Error("CUSTOM_API_KEY, CUSTOM_BASE_URL, and CUSTOM_FINAL_MODEL must be configured together.");
  }
}
