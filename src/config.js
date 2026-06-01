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
  qwenModel: process.env.QWEN_MODEL || "qwen-plus",
  gammaUrl:
    process.env.POLYMARKET_GAMMA_URL || "https://gamma-api.polymarket.com",
  clobUrl: process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com",
  maxQwenInputChars: positiveInt(process.env.MAX_QWEN_INPUT_CHARS, 7000),
  qwenMaxTokens: positiveInt(process.env.QWEN_MAX_TOKENS, 10000),
  cacheTtlSeconds: positiveInt(process.env.CACHE_TTL_SECONDS, 60),
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
