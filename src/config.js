import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeChainlinkFeedId } from "./short-market-sources.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RETIRED_ENV_KEYS = new Set([
  "ENABLE_LIVE_TRADING",
  "WALLET_PRIVATE_KEY",
  "CLOB_API_KEY",
  "CLOB_API_SECRET",
  "CLOB_API_PASSPHRASE",
  "ENABLE_AI_REFLECTION_MEMORY",
]);
const SHORT_OBSERVER_ENABLED_ENV_KEY = "SHORT_OBSERVER_BTC_15M_ENABLED";

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const rawEq = line.indexOf("=");
    const rawKey = rawEq === -1 ? "" : line.slice(0, rawEq).trim();
    if (rawKey === SHORT_OBSERVER_ENABLED_ENV_KEY) {
      if (!(rawKey in process.env)) process.env[rawKey] = line.slice(rawEq + 1);
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (RETIRED_ENV_KEYS.has(key)) continue;
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
for (const key of RETIRED_ENV_KEYS) delete process.env[key];

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

const SHORT_OBSERVER_ENV_KEYS = Object.freeze({
  enabled: "SHORT_OBSERVER_BTC_15M_ENABLED",
  expectedChainlinkFeedId: "SHORT_OBSERVER_BTC_15M_EXPECTED_CHAINLINK_FEED_ID",
  discoveryIntervalMs: "SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS",
  discoveryLookaheadMs: "SHORT_OBSERVER_BTC_15M_DISCOVERY_LOOKAHEAD_MS",
  discoveryTimeoutMs: "SHORT_OBSERVER_BTC_15M_DISCOVERY_TIMEOUT_MS",
  snapshotIntervalMs: "SHORT_OBSERVER_BTC_15M_SNAPSHOT_INTERVAL_MS",
  snapshotTimeoutMs: "SHORT_OBSERVER_BTC_15M_SNAPSHOT_TIMEOUT_MS",
  resolutionIntervalMs: "SHORT_OBSERVER_BTC_15M_RESOLUTION_INTERVAL_MS",
  resolutionTimeoutMs: "SHORT_OBSERVER_BTC_15M_RESOLUTION_TIMEOUT_MS",
  resolutionGraceMs: "SHORT_OBSERVER_BTC_15M_RESOLUTION_GRACE_MS",
  freezeBeforeCloseMs: "SHORT_OBSERVER_BTC_15M_FREEZE_BEFORE_CLOSE_MS",
  lateStartGraceMs: "SHORT_OBSERVER_BTC_15M_LATE_START_GRACE_MS",
  retries: "SHORT_OBSERVER_BTC_15M_RETRIES",
  retryBackoffMs: "SHORT_OBSERVER_BTC_15M_RETRY_BACKOFF_MS",
  leaseTimeoutMs: "SHORT_OBSERVER_BTC_15M_LEASE_TIMEOUT_MS",
  shutdownTimeoutMs: "SHORT_OBSERVER_BTC_15M_SHUTDOWN_TIMEOUT_MS",
});

const shortObserverRawConfig = Object.fromEntries(
  Object.entries(SHORT_OBSERVER_ENV_KEYS).map(([name, envKey]) => [name, process.env[envKey]])
);

function optionalObserverNumber(value) {
  const text = String(value ?? "");
  if (!text || !/^[0-9]+$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}

const shortObserverBtc15m = {
  expectedChainlinkFeedId: canonicalizeChainlinkFeedId(shortObserverRawConfig.expectedChainlinkFeedId) || undefined,
  discoveryIntervalMs: optionalObserverNumber(shortObserverRawConfig.discoveryIntervalMs),
  discoveryLookaheadMs: optionalObserverNumber(shortObserverRawConfig.discoveryLookaheadMs),
  discoveryTimeoutMs: optionalObserverNumber(shortObserverRawConfig.discoveryTimeoutMs),
  snapshotIntervalMs: optionalObserverNumber(shortObserverRawConfig.snapshotIntervalMs),
  snapshotTimeoutMs: optionalObserverNumber(shortObserverRawConfig.snapshotTimeoutMs),
  resolutionIntervalMs: optionalObserverNumber(shortObserverRawConfig.resolutionIntervalMs),
  resolutionTimeoutMs: optionalObserverNumber(shortObserverRawConfig.resolutionTimeoutMs),
  resolutionGraceMs: optionalObserverNumber(shortObserverRawConfig.resolutionGraceMs),
  freezeBeforeCloseMs: optionalObserverNumber(shortObserverRawConfig.freezeBeforeCloseMs),
  lateStartGraceMs: optionalObserverNumber(shortObserverRawConfig.lateStartGraceMs),
  retries: optionalObserverNumber(shortObserverRawConfig.retries),
  retryBackoffMs: optionalObserverNumber(shortObserverRawConfig.retryBackoffMs),
  leaseTimeoutMs: optionalObserverNumber(shortObserverRawConfig.leaseTimeoutMs),
  shutdownTimeoutMs: optionalObserverNumber(shortObserverRawConfig.shutdownTimeoutMs),
};

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

const omniApiKey = process.env.OMNI_API_KEY || "";
const aiProvider = {
  name: "omniroute",
  apiKey: omniApiKey,
  baseUrl: process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1",
};
const defaultModels = {
  fast: "alims-intl/deepseek-v4-flash-0731",
  analyst: "alims-intl/deepseek-v4-flash-0731",
  final: "alims-intl/deepseek-v4-pro-0813",
  fallback: "alims-intl/deepseek-v4-flash-0731",
};

export const config = {
  aiProviderName: aiProvider.name,
  omniApiKey: aiProvider.apiKey,
  omniRouteBaseUrl: normalizeBaseUrl(aiProvider.baseUrl),
  qwenApiKey: aiProvider.apiKey,
  qwenBaseUrl: normalizeBaseUrl(aiProvider.baseUrl),
  // Model Roles for Single Market Analysis
  qwenBullModel: process.env.QWEN_BULL_MODEL || process.env.QWEN_FAST_MODEL || defaultModels.fast,
  qwenBearModel: process.env.QWEN_BEAR_MODEL || process.env.QWEN_ANALYST_MODEL || defaultModels.analyst,
  qwenRiskManagerModel: process.env.QWEN_RISK_MANAGER_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.final,

  qwenFallbackModel: process.env.QWEN_FALLBACK_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.fallback,
  qwenShortModel: process.env.QWEN_SHORT_MODEL || process.env.QWEN_BULL_MODEL || process.env.QWEN_FAST_MODEL || defaultModels.fast,
  // Reserved for post-mortem/evaluation use; no evaluator runtime exists yet.
  qwenEvaluatorModel: process.env.QWEN_EVALUATOR_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.final,

  // Model Roles for Multi-Market Event Analysis
  qwenScoutModel: process.env.QWEN_SCOUT_MODEL || process.env.QWEN_FAST_MODEL || defaultModels.fast,
  qwenEventAnalystModel: process.env.QWEN_EVENT_ANALYST_MODEL || process.env.QWEN_ANALYST_MODEL || defaultModels.analyst,
  qwenEventFinalModel: process.env.QWEN_EVENT_FINAL_MODEL || process.env.QWEN_FINAL_MODEL || process.env.QWEN_MODEL || defaultModels.final,

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
  qwenShortMaxTokens: positiveInt(process.env.QWEN_SHORT_MAX_TOKENS, 4000),
  qwenRequestTimeoutMs: positiveInt(process.env.QWEN_REQUEST_TIMEOUT_MS, 90000),
  shortAiTimeoutMs: positiveInt(process.env.SHORT_AI_TIMEOUT_MS, 15000),
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
  entryMaxPrice: probabilityPrice(process.env.ENTRY_MAX_PRICE, 0.70),
  entryFeeBufferCents: positiveNumber(process.env.ENTRY_FEE_BUFFER_CENTS, 4),
  entryMinSecondsToClose: positiveInt(process.env.ENTRY_MIN_SECONDS_TO_CLOSE, 30),
  allowInsecureTls: process.env.ALLOW_INSECURE_TLS === "true",

  // Observer settings intentionally have no fallbacks or defaults.
  shortObserverBtc15mEnabled: shortObserverRawConfig.enabled === "true",
  shortObserverBtc15m,
  shortObserverBtc15mDiscoveryIntervalMs: shortObserverBtc15m.discoveryIntervalMs,
  shortObserverBtc15mDiscoveryLookaheadMs: shortObserverBtc15m.discoveryLookaheadMs,
  shortObserverBtc15mDiscoveryTimeoutMs: shortObserverBtc15m.discoveryTimeoutMs,
  shortObserverBtc15mSnapshotIntervalMs: shortObserverBtc15m.snapshotIntervalMs,
  shortObserverBtc15mSnapshotTimeoutMs: shortObserverBtc15m.snapshotTimeoutMs,
  shortObserverBtc15mResolutionIntervalMs: shortObserverBtc15m.resolutionIntervalMs,
  shortObserverBtc15mResolutionTimeoutMs: shortObserverBtc15m.resolutionTimeoutMs,
  shortObserverBtc15mResolutionGraceMs: shortObserverBtc15m.resolutionGraceMs,
  shortObserverBtc15mFreezeBeforeCloseMs: shortObserverBtc15m.freezeBeforeCloseMs,
  shortObserverBtc15mLateStartGraceMs: shortObserverBtc15m.lateStartGraceMs,
  shortObserverBtc15mRetries: shortObserverBtc15m.retries,
  shortObserverBtc15mRetryBackoffMs: shortObserverBtc15m.retryBackoffMs,
  shortObserverBtc15mLeaseTimeoutMs: shortObserverBtc15m.leaseTimeoutMs,
  shortObserverBtc15mShutdownTimeoutMs: shortObserverBtc15m.shutdownTimeoutMs,
};

export function assertConfig() {
  const missing = [];
  if (!config.omniApiKey) missing.push("OMNI_API_KEY");

  if (missing.length) {
    throw new Error(
      `Missing env: ${missing.join(", ")}. Copy .env.example to .env and fill it.`
    );
  }
}

export function assertShortObserverConfig() {
  const enabledValue = shortObserverRawConfig.enabled ?? "";
  if (enabledValue !== "" && enabledValue !== "true" && enabledValue !== "false") {
    throw new Error(`${SHORT_OBSERVER_ENV_KEYS.enabled} must be exactly true or false.`);
  }

  if (enabledValue !== "true") {
    return { enabled: false, ...shortObserverBtc15m };
  }

  const missing = [];
  const invalidNumbers = [];
  const expectedFeedIdRaw = shortObserverRawConfig.expectedChainlinkFeedId;
  if (expectedFeedIdRaw == null || expectedFeedIdRaw === "") {
    missing.push(SHORT_OBSERVER_ENV_KEYS.expectedChainlinkFeedId);
  }
  const invalidFeedId = expectedFeedIdRaw != null
    && expectedFeedIdRaw !== ""
    && !shortObserverBtc15m.expectedChainlinkFeedId;

  for (const name of Object.keys(shortObserverBtc15m).filter((key) => key !== "expectedChainlinkFeedId")) {
    const envKey = SHORT_OBSERVER_ENV_KEYS[name];
    const rawValue = shortObserverRawConfig[name];
    const value = shortObserverBtc15m[name];
    if (rawValue == null || rawValue === "") {
      missing.push(envKey);
    } else if (!Number.isSafeInteger(value) || value <= 0) {
      invalidNumbers.push(envKey);
    }
  }

  if (missing.length || invalidFeedId || invalidNumbers.length) {
    const details = [];
    if (missing.length) details.push(`missing: ${missing.join(", ")}`);
    if (invalidFeedId) details.push(`invalid V2 Chainlink feed ID: ${SHORT_OBSERVER_ENV_KEYS.expectedChainlinkFeedId}`);
    if (invalidNumbers.length) details.push(`invalid positive safe integer values: ${invalidNumbers.join(", ")}`);
    throw new Error(`Invalid BTC 15m short observer configuration (${details.join("; ")}).`);
  }

  const invalidTiming = [];
  if (shortObserverBtc15m.resolutionTimeoutMs > shortObserverBtc15m.resolutionIntervalMs) {
    invalidTiming.push(`${SHORT_OBSERVER_ENV_KEYS.resolutionTimeoutMs} must be <= ${SHORT_OBSERVER_ENV_KEYS.resolutionIntervalMs}`);
  }
  if (shortObserverBtc15m.resolutionGraceMs < shortObserverBtc15m.resolutionIntervalMs) {
    invalidTiming.push(`${SHORT_OBSERVER_ENV_KEYS.resolutionGraceMs} must be >= ${SHORT_OBSERVER_ENV_KEYS.resolutionIntervalMs}`);
  }
  if (invalidTiming.length) {
    throw new Error(`Invalid BTC 15m short observer configuration (${invalidTiming.join("; ")}).`);
  }

  return { enabled: true, ...shortObserverBtc15m };
}

export function assertQwenConfig() {
  if (!config.omniApiKey) {
    throw new Error("Missing AI provider key. Configure OMNI_API_KEY.");
  }
  const models = [config.qwenBullModel, config.qwenBearModel, config.qwenRiskManagerModel, config.qwenFallbackModel, config.qwenShortModel, config.qwenEvaluatorModel, config.qwenScoutModel, config.qwenEventAnalystModel, config.qwenEventFinalModel];
  if (models.some((model) => !String(model || "").trim())) {
    throw new Error("All AI role model IDs must be configured for the selected provider.");
  }
}
