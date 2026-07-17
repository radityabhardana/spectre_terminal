import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getRecentReflections } from "./storage.js";

let tokenUsageByModel = {};
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const TOKEN_FILE = path.join(DATA_DIR, 'token_usage.json');

try {
  if (fs.existsSync(TOKEN_FILE)) {
    tokenUsageByModel = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  }
} catch (e) {
  console.error("Error reading token usage:", e);
}

function saveTokenUsage() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenUsageByModel, null, 2));
  } catch (e) {
    console.error("Error saving token usage:", e);
  }
}

export function getTotalAITokensUsed() {
  return tokenUsageByModel;
}

export function resetTotalAITokensUsed() {
  tokenUsageByModel = {};
  saveTokenUsage();
}

const BINANCE_BASE_URLS = [
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
  'https://data-api.binance.vision'
];

async function fetchWithFallback(endpoints, path, options) {
  for (const base of endpoints) {
    try {
      const res = await fetch(base + path, options);
      if (res.ok) return res;
    } catch (e) {
      // Try next endpoint
    }
  }
  throw new Error("All Binance endpoints failed");
}

const dataDir = path.resolve(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const VALID_VERDICTS = new Set([
  "SKIP",
  "WATCHLIST",
  "VALUE CANDIDATE",
  "HIGH RISK UNDERDOG",
]);

function truncate(value, maxChars) {
  const text = String(value || "");
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function nowInJakarta() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function daysUntil(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.round((time - Date.now()) / 86400000);
}

function compactOrderBook(book, levels = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  return {
    asset_id: book?.asset_id || null,
    bids_count: bids.length,
    asks_count: asks.length,
    top_bids: bids.slice(0, levels).map((item) => ({
      price: item.price,
      size: item.size,
    })),
    top_asks: asks.slice(0, levels).map((item) => ({
      price: item.price,
      size: item.size,
    })),
  };
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("Empty Qwen response");

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("Qwen response is not valid JSON");
  }
}

function cleanList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 5);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function normalizeAnalysis(value, rawText) {
  const verdict = String(value.verdict || "").trim().toUpperCase();

  return {
    verdict: VALID_VERDICTS.has(verdict) ? verdict : "SKIP",
    confidence: Number.isFinite(Number(value.confidence)) && Number(value.confidence) > 0
      ? Math.max(1, Math.min(100, Math.round(Number(value.confidence))))
      : null,
    positionSizePct: Number.isFinite(Number(value.position_size_pct)) ? Number(value.position_size_pct) : null,
    estimatedFairProbability: (() => {
      const val = value.estimated_fair_probability !== undefined ? value.estimated_fair_probability : value.estimatedFairProbability;
      const num = typeof val === 'string' ? parseFloat(val.replace('%', '')) : Number(val);
      return Number.isFinite(num) ? num : null;
    })(),
    expectedValueCents: Number.isFinite(Number(value.expected_value_cents)) ? Number(value.expected_value_cents) : null,
    kellyEdge: Number.isFinite(Number(value.kelly_edge)) ? Number(value.kelly_edge) : null,
    summary: truncate(value.summary || value.ringkasan || "", 420),
    dataQuality: truncate(value.data_quality || value.dataQuality || "", 360),
    bullishCase: cleanList(value.bullish_case || value.bullishCase),
    bearishCase: cleanList(value.bearish_case || value.bearishCase),
    risks: {
      liquidity: truncate(value.risks?.liquidity || value.liquidity_risk || "", 220),
      spread: truncate(value.risks?.spread || value.spread_risk || "", 220),
      resolution: truncate(value.risks?.resolution || value.resolution_risk || "", 220),
      catalyst: truncate(value.risks?.catalyst || value.catalyst || "", 220),
    },
    missingData: cleanList(value.missing_data || value.missingData),
    checklist: {
      liquidity: Boolean(value.checklist?.liquidity),
      spread: Boolean(value.checklist?.spread),
      rules: Boolean(value.checklist?.rules),
      edge: Boolean(value.checklist?.edge),
      catalyst: Boolean(value.checklist?.catalyst),
    },
    finalReason: truncate(value.final_reason || value.finalReason || "", 420),
    rawText,
  };
}

function normalizeEventAnalysis(value, rawText) {
  const ranking = Array.isArray(value.ranking)
    ? value.ranking
        .map((item) => {
          const verdict = String(item.verdict || "").trim().toUpperCase();
          return {
            marketId: String(item.market_id || item.marketId || "").trim(),
            verdict: VALID_VERDICTS.has(verdict) ? verdict : "WATCHLIST",
            reason: truncate(item.reason || "", 260),
          };
        })
        .filter((item) => item.marketId)
        .slice(0, 20)
    : [];

  return {
    eventSummary: truncate(value.event_summary || value.eventSummary || "", 500),
    bestMarketId: String(value.best_market_id || value.bestMarketId || "").trim(),
    bestReason: truncate(value.best_reason || value.bestReason || "", 420),
    ranking,
    avoid: cleanList(value.avoid || value.avoid_markets || value.avoidMarkets),
    missingData: cleanList(value.missing_data || value.missingData),
    finalNote: truncate(value.final_note || value.finalNote || "", 420),
    rawText,
  };
}

function normalizeScout(value, rawText) {
  return {
    taskType: truncate(value.task_type || value.taskType || "", 80),
    complexity: truncate(value.complexity || "", 80),
    mainQuestion: truncate(value.main_question || value.mainQuestion || "", 220),
    marketType: truncate(value.market_type || value.marketType || "", 120),
    riskFocus: cleanList(value.risk_focus || value.riskFocus),
    missingData: cleanList(value.missing_data || value.missingData),
    recommendedDepth: truncate(value.recommended_depth || value.recommendedDepth || "", 80),
    rawText,
  };
}

function normalizeAnalystReview(value, rawText) {
  const verdict = String(value.preliminary_verdict || value.preliminaryVerdict || "").trim().toUpperCase();

  return {
    rulesSummary: truncate(value.rules_summary || value.rulesSummary || "", 360),
    dataQuality: truncate(value.data_quality || value.dataQuality || "", 360),
    bullishCase: cleanList(value.bullish_case || value.bullishCase),
    bearishCase: cleanList(value.bearish_case || value.bearishCase),
    risks: {
      liquidity: truncate(value.risks?.liquidity || value.liquidity_risk || "", 220),
      spread: truncate(value.risks?.spread || value.spread_risk || "", 220),
      resolution: truncate(value.risks?.resolution || value.resolution_risk || "", 220),
      catalyst: truncate(value.risks?.catalyst || value.catalyst || "", 220),
    },
    missingData: cleanList(value.missing_data || value.missingData),
    preliminaryVerdict: VALID_VERDICTS.has(verdict) ? verdict : "WATCHLIST",
    confidence: Number.isFinite(Number(value.confidence)) && Number(value.confidence) > 0
      ? Math.max(1, Math.min(100, Math.round(Number(value.confidence))))
      : null,
    rawText,
  };
}

function eventHardBlockers(score) {
  return (score.blockers || []).filter((item) => item !== "No measured positive edge");
}

function mechanicalEventFallback(analyzedMarkets, rawText = "") {
  const ranked = [...analyzedMarkets].sort((a, b) => {
    const aBlocked = eventHardBlockers(a.score).length ? 1 : 0;
    const bBlocked = eventHardBlockers(b.score).length ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;

    const aSpread = Number.isFinite(a.score.spreadPercent) ? a.score.spreadPercent : 99;
    const bSpread = Number.isFinite(b.score.spreadPercent) ? b.score.spreadPercent : 99;
    if (aSpread !== bSpread) return aSpread - bSpread;

    return b.market.liquidity + b.market.volume - (a.market.liquidity + a.market.volume);
  });
  const best = ranked.find((item) => eventHardBlockers(item.score).length === 0);

  return normalizeEventAnalysis(
    {
      event_summary:
        "Qwen tidak mengembalikan JSON valid, jadi bot memakai fallback ranking mekanis dari semua market aktif.",
      best_market_id: best?.market.id || "",
      best_reason: best
        ? "Dipilih fallback karena orderbook/spread relatif paling sehat dan market lolos hard blocker."
        : "Tidak ada market yang lolos hard blocker mekanis.",
      ranking: ranked.slice(0, 8).map(({ market, score }) => ({
        market_id: market.id,
        verdict: eventHardBlockers(score).length ? "SKIP" : score.verdict,
        reason: eventHardBlockers(score).length
          ? `Hard blocker: ${eventHardBlockers(score).join("; ")}`
          : `Spread ${score.spreadPercent?.toFixed?.(2) ?? "n/a"}%, confidence ${
              score.confidenceScore
            }/100, liquidity ${Math.round(market.liquidity)}.`,
      })),
      avoid: ranked
        .filter((item) => eventHardBlockers(item.score).length)
        .slice(0, 5)
        .map((item) => `${item.market.id}: ${eventHardBlockers(item.score).join("; ")}`),
      missing_data: ["Fair probability eksternal", "Catalyst/fundamental terbaru"],
      final_note:
        "Fallback ini berbasis market data, bukan analisis fundamental. Gunakan /analyze <Market ID> untuk deep dive pilihan tertentu.",
    },
    rawText
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Prompt dibatalkan.");
    error.name = "AbortError";
    throw error;
  }
}

async function callQwen(payload, baseUrl, apiKey, signal = null, retries = 3) {
  throwIfAborted(signal);

  const lang = config.botLanguage || "Indonesia";
  const requestPayload = {
    ...payload,
    messages: payload.messages?.map(m => {
      if (m.role === "system") {
        return {
          ...m,
          content: m.content + `\n\nCRITICAL INSTRUCTION: You MUST write ALL of your explanations, reasoning, thoughts, and output in the ${lang} language. Translate your entire output into ${lang} fluently.`
        };
      }
      return m;
    })
  };

  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestPayload),
        signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Qwen HTTP ${response.status}: ${text.slice(0, 300)}`);
      }

      const json = await response.json();
      if (json.usage && json.usage.total_tokens) {
        const mName = json.model || requestPayload.model || "unknown";
        tokenUsageByModel[mName] = (tokenUsageByModel[mName] || 0) + json.usage.total_tokens;
        saveTokenUsage();
      }
      return json;
    } catch (error) {
      if (i === retries - 1 || error.name === "AbortError") throw error;

      // Auto-switch to backup API key if forbidden/rate-limited/out of balance
      const isAuthOrQuotaError = error.message.includes("HTTP 401") || error.message.includes("HTTP 403") || error.message.includes("HTTP 429") || error.message.includes("Insufficient") || error.message.includes("Arrearage") || error.message.includes("DataInspectionFailed");
      
      if (isAuthOrQuotaError && config.qwenApiKeyBackup && apiKey === config.qwenApiKey && apiKey !== config.qwenApiKeyBackup) {
        console.error(`[Qwen] Primary API Key failed (${error.message}). SWAPPING TO BACKUP API KEY GLOBALLY!`);
        config.qwenApiKey = config.qwenApiKeyBackup;
        apiKey = config.qwenApiKeyBackup; // Update local variable for the next retry iteration
      } else {
        console.warn(`[Qwen] fetch failed, retrying (${i + 1}/${retries})... Error: ${error.message}`);
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function callQwenJson(payload, baseUrl, apiKey, signal = null) {
  let json;
  try {
    json = await callQwen(payload, baseUrl, apiKey, signal);
  } catch (error) {
    if (!String(error.message).includes("response_format")) throw error;
    const { response_format, ...fallbackPayload } = payload;
    json = await callQwen(fallbackPayload, baseUrl, apiKey, signal);
  }

  const text = json.choices?.[0]?.message?.content?.trim() || "";
  return {
    json,
    text,
    model: json.model || payload.model,
    usage: json.usage || null,
  };
}

async function callRoleQwenJson(payload, fallbackModel = "", baseUrl, apiKey, signal = null) {
  try {
    return await callQwenJson(payload, baseUrl, apiKey, signal);
  } catch (error) {
    if (error.name === "AbortError") throw error;
    if (/Qwen HTTP (401|403)/.test(String(error.message))) throw error;
    if (!fallbackModel || payload.model === fallbackModel) throw error;
    const fallback = await callQwenJson({ ...payload, model: fallbackModel }, baseUrl, apiKey, signal);
    return { ...fallback, fallbackFrom: payload.model };
  }
}

function usageValue(usage, key) {
  const value = usage?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function promptUsage(usage) {
  return usageValue(usage, "prompt_tokens") || usageValue(usage, "input_tokens");
}

function completionUsage(usage) {
  return usageValue(usage, "completion_tokens") || usageValue(usage, "output_tokens");
}

function aggregateUsage(roleResults) {
  const usages = roleResults.map((item) => item.usage).filter(Boolean);
  if (!usages.length) return null;

  const prompt = usages.reduce((sum, usage) => sum + promptUsage(usage), 0);
  const completion = usages.reduce((sum, usage) => sum + completionUsage(usage), 0);
  const total = usages.reduce((sum, usage) => {
    const explicit = usageValue(usage, "total_tokens");
    return sum + (explicit || promptUsage(usage) + completionUsage(usage));
  }, 0);

  return {
    prompt_tokens: prompt || undefined,
    completion_tokens: completion || undefined,
    total_tokens: total || undefined,
    role_usage: Object.fromEntries(roleResults.map((item) => [item.role, item.usage || null])),
  };
}

function pipelineModelLabel(models) {
  return `fast:${models.fast} | analyst:${models.analyst} | final:${models.final}`;
}

function roleMaxTokens(role) {
  const total = Math.max(900, config.qwenMaxTokens);
  if (role === "fast") return Math.max(300, Math.floor(total * 0.1));
  if (role === "analyst") return Math.max(300, Math.floor(total * 0.3));
  return Math.max(300, total - roleMaxTokens("fast") - roleMaxTokens("analyst"));
}

function parseJsonOr(value, fallback) {
  try {
    return extractJsonObject(value);
  } catch {
    return fallback;
  }
}

function promptSafe(value) {
  if (!value || typeof value !== "object") return value;
  const { rawText, ...rest } = value;
  return rest;
}

function researchBlock(researchContext) {
  if (!researchContext || researchContext.status === "skipped") {
    return [
      "EXTERNAL RESEARCH CONTEXT:",
      "Tidak tersedia. Jangan mengarang data eksternal.",
    ].join("\n");
  }

  // Compress the context to make API calls highly efficient while preserving the best analysis data
  const compressedContext = {
    provider: researchContext.provider,
    type: researchContext.type,
    summary: researchContext.summary,
    sentiment: researchContext.sentimentSummary,
    fundamental: researchContext.fundamentalSummary,
    news: researchContext.newsSummary,
    fighterConditions: researchContext.fighterConditions,
    limitations: researchContext.limitations
  };

  return [
    "EXTERNAL RESEARCH CONTEXT (COMPRESSED):",
    JSON.stringify(compressedContext, null, 2),
  ].join("\n");
}

// ─── Binance Technical Indicators ─────────────// Calculates RSI and MACD from raw Binance kline data (no external library needed)
async function fetchBinanceTechData(symbol = "BTCUSDT", intervalMinutes = 5) {
  try {
    // Fetch last 100 candles (more data = more accurate Wilder RSI + MACD signal warmup)
    const interval = intervalMinutes <= 5 ? "5m" : intervalMinutes <= 15 ? "15m" : "1h";
    const klinePath = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`;
    const tickerPath = `/api/v3/ticker/24hr?symbol=${symbol}`;

    const [klineRes, tickerRes] = await Promise.all([
      fetchWithFallback(BINANCE_BASE_URLS, klinePath, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }),
      fetchWithFallback(BINANCE_BASE_URLS, tickerPath, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) }),
    ]);

    if (!klineRes.ok || !tickerRes.ok) throw new Error("Binance API error");
    const klines = await klineRes.json(); // [[openTime, open, high, low, close, volume, ...], ...]
    const ticker = await tickerRes.json();

    const closes = klines.map(k => parseFloat(k[4]));
    const volumes = klines.map(k => parseFloat(k[5]));

    // ── RSI-14 using Wilder's Smoothing (matches TradingView / Binance exactly) ──
    const rsiPeriod = 14;
    // Step 1: compute all price changes
    const changes = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }
    // Step 2: initial seed avg from first 14 changes
    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < rsiPeriod; i++) {
      if (changes[i] >= 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= rsiPeriod;
    avgLoss /= rsiPeriod;
    // Step 3: Wilder's smoothing for the rest
    for (let i = rsiPeriod; i < changes.length; i++) {
      const gain = changes[i] >= 0 ? changes[i] : 0;
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
      avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
      avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = Math.round(100 - (100 / (1 + rs)));

    // ── EMA helper ──
    const calcEma = (data, period) => {
      const k = 2 / (period + 1);
      let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
      return val;
    };

    // ── MACD (12, 26, 9) — correct: compute full MACD line series, then EMA-9 ──
    // Build full EMA-12 and EMA-26 series across all candles
    const buildEmaSeries = (data, period) => {
      const k = 2 / (period + 1);
      const series = [];
      let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      series.push(val);
      for (let i = period; i < data.length; i++) {
        val = data[i] * k + val * (1 - k);
        series.push(val);
      }
      return series;
    };

    const ema12Series = buildEmaSeries(closes, 12); // length = closes.length - 11
    const ema26Series = buildEmaSeries(closes, 26); // length = closes.length - 25
    // Align: ema26 is shorter; match from the end
    const alignLen = Math.min(ema12Series.length, ema26Series.length);
    const macdSeries = [];
    for (let i = 0; i < alignLen; i++) {
      macdSeries.push(
        ema12Series[ema12Series.length - alignLen + i] -
        ema26Series[ema26Series.length - alignLen + i]
      );
    }
    const macdLine = parseFloat(macdSeries[macdSeries.length - 1].toFixed(2));
    // Signal = EMA-9 of the full MACD series
    const signalVal = macdSeries.length >= 9 ? calcEma(macdSeries, 9) : macdSeries[macdSeries.length - 1];
    const macdSignal = parseFloat(signalVal.toFixed(2));
    const macdHistogram = parseFloat((macdLine - macdSignal).toFixed(2));

    // Recent 5 candles summary
    const recentCandles = klines.slice(-5).map(k => ({
      time: new Date(k[0]).toISOString().slice(11, 16),
      open: parseFloat(k[1]).toFixed(2),
      close: parseFloat(k[4]).toFixed(2),
      direction: parseFloat(k[4]) >= parseFloat(k[1]) ? '▲' : '▼',
      vol: parseFloat(k[5]).toFixed(1)
    }));

    // Volume ratio: last candle vs 10-candle avg
    const avgVol10 = volumes.slice(-11, -1).reduce((a, b) => a + b, 0) / 10;
    const lastVol = volumes[volumes.length - 1];
    const volRatio = avgVol10 > 0 ? (lastVol / avgVol10).toFixed(2) : 1;

    return {
      symbol,
      interval,
      currentPrice: parseFloat(ticker.lastPrice).toFixed(2),
      priceChange24h: parseFloat(ticker.priceChangePercent).toFixed(2),
      high24h: parseFloat(ticker.highPrice).toFixed(2),
      low24h: parseFloat(ticker.lowPrice).toFixed(2),
      rsi14: rsi,
      rsiSignal: rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : rsi > 55 ? 'BULLISH ZONE' : rsi < 45 ? 'BEARISH ZONE' : 'NEUTRAL',
      macd: { line: macdLine, signal: macdSignal, histogram: macdHistogram, trend: macdHistogram > 0 ? 'BULLISH' : 'BEARISH' },
      recentCandles,
      volumeRatio: parseFloat(volRatio),
      volumeSignal: parseFloat(volRatio) > 1.5 ? 'HIGH (momentum)' : parseFloat(volRatio) < 0.7 ? 'LOW (weak)' : 'NORMAL',
    };
  } catch (err) {
    console.error('[Qwen] fetchBinanceTechData error:', err.message);
    return null;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

export async function askQwen({ market, score, orderBook, researchContext = null, signal = null }) {
  throwIfAborted(signal);
  const primaryOutcomeLabel = String(score?.primaryOutcomeLabel || market.outcomes?.[0] || "YES");
  const secondaryOutcomeLabel = String(score?.secondaryOutcomeLabel || market.outcomes?.[1] || "NO");
  const marketData = JSON.stringify(
    {
      currentDateAsiaJakarta: nowInJakarta(),
      question: market.question,
      eventGroup: market.eventTitle,
      marketVariant: market.groupItemTitle,
      description: market.description,
      endDate: market.endDate,
      daysUntilEndDate: daysUntil(market.endDate),
      active: market.active,
      closed: market.closed,
      acceptingOrders: market.acceptingOrders,
      liquidity: market.liquidity,
      volume: market.volume,
      outcomes: market.outcomes,
      outcomePrices: market.outcomePrices,
      primaryOutcomeLabel,
      secondaryOutcomeLabel,
      url: market.url,
    },
    null,
    2
  );

  let cryptoSymbol = "";
  let binanceSymbol = "";
  const qLower = (market.question || "").toLowerCase();
  if (qLower.includes("bitcoin") || qLower.includes("btc")) { cryptoSymbol = "BTC"; binanceSymbol = "BTCUSDT"; }
  else if (qLower.includes("ethereum") || qLower.includes("eth")) { cryptoSymbol = "ETH"; binanceSymbol = "ETHUSDT"; }
  else if (qLower.includes("doge") || qLower.includes("dogecoin")) { cryptoSymbol = "DOGE"; binanceSymbol = "DOGEUSDT"; }

  // Determine candle interval from market duration type
  const durationMins = market.duration_type === "1h" ? 60 : market.duration_type === "15m" ? 15 : 5;

  let cryptoContext = "";
  if (binanceSymbol) {
    const techData = await fetchBinanceTechData(binanceSymbol, durationMins);
    if (techData) {
      const priceToBeat = market.priceToBeat || "N/A";
      const currentPriceDisplay = market.currentPrice !== undefined
        ? `$${market.currentPrice.toFixed(2)} (Polymarket WebSocket)`
        : `$${techData.currentPrice} (Binance)`;
      cryptoContext = `\n\n━━━ BINANCE REAL-TIME TECHNICAL DATA (${cryptoSymbol}/USDT) ━━━
📍 Current Price: ${currentPriceDisplay}
🎯 Polymarket Target (priceToBeat): ${priceToBeat}
📈 24h Change: ${techData.priceChange24h}%  |  24h High: $${techData.high24h}  |  24h Low: $${techData.low24h}

📊 RSI-14 (${techData.interval}): ${techData.rsi14} → ${techData.rsiSignal}
   (>70 = Overbought/likely reversal | <30 = Oversold/likely bounce | 45-55 = Choppy)

📉 MACD (12,26,9):
   Line: ${techData.macd.line} | Signal: ${techData.macd.signal} | Histogram: ${techData.macd.histogram}
   Trend: ${techData.macd.trend} ${techData.macd.histogram > 0 ? '(momentum naik)' : '(momentum turun)'}

🕯️ Recent ${techData.interval} Candles (terbaru kanan):
${techData.recentCandles.map(c => `   ${c.time} ${c.direction} $${c.close} vol:${c.vol}`).join('\n')}

📦 Volume (vs 10-candle avg): ${techData.volumeRatio}x → ${techData.volumeSignal}

[!] INSTRUKSI: Gunakan data teknikal Binance ini sebagai dasar utama prediksi arah harga dalam ${durationMins} menit ke depan. RSI dan MACD lebih relevan dari Polymarket probability untuk short market.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }
  }

  function extractCoreLesson(text) {
    if (!text) return "Tidak ada catatan.";
    const kw = "3. **Core Lesson Learned";
    const idx = text.indexOf(kw);
    if (idx !== -1) {
      let after = text.substring(idx + kw.length);
      const nl = after.indexOf('\\n');
      if (nl !== -1) after = after.substring(nl + 1).trim();
      return after.substring(0, 500); // Batasi max 500 chars per lesson
    }
    // Fallback: ambil 300 karakter terakhir
    return text.length > 300 ? "..." + text.substring(text.length - 300) : text;
  }

  const recentReflections = getRecentReflections(5);
  const lessonsBlock = recentReflections.length > 0 
    ? `\nGLOBAL TRAPS CHECKLIST (EXTRACTED RAG MEMORY):\n${recentReflections.map((r, i) => `${i+1}. [Market: ${r.question} | Tebakan Salah: ${r.prediction}] -> ${extractCoreLesson(r.reflection_note)}`).join("\n\n")}`
    : "";

  // Market type detection — adapts analyst prompts to the event category
  const researchType = researchContext?.type || "general";
  const isCryptoMkt = researchType === "crypto";
  const isUfcMkt = researchType === "sports_ufc";
  // Short crypto market detection: check duration_type (5m/15m/1h) OR regex on question as fallback
  const isShortCryptoMkt = 
    ["5m", "15m", "1h"].includes(market.duration_type) ||
    /(bitcoin|btc|ethereum|eth|doge|dogecoin).*up.or.down/i.test(market.question || "");
  const durationLabel = market.duration_type === "1h" ? "1 Jam" : market.duration_type === "15m" ? "15 Menit" : "5 Menit";

  const bullAnalystHint = isUfcMkt
    ? "Fokus pada statistik petarung, track record kemenangan, keunggulan style bertarung (striker vs grappler), kondisi fisik terbaru, dan rekam jejak di fight level yang sama."
    : isCryptoMkt
      ? "Fokus pada katalis positif, momentum harga, RSI/MACD bullish, volume tinggi, dan indikator teknikal pendukung tren naik."
      : "Fokus pada peluang terealisasi berdasarkan data fundamental, berita terbaru, polling/survei, atau base rate historis yang mendukung outcome YES/PRIMARY.";

  const bearAnalystHint = isUfcMkt
    ? "Fokus pada kelemahan petarung sisi YES (cedera terbaru, turun form, kelemahan gaya), keunggulan lawan, dan faktor upset historis di matchup serupa."
    : isCryptoMkt
      ? "Fokus pada risiko downside, RSI overbought, MACD death cross, volume lemah, berita negatif makro, atau tanda-tanda reversal teknikal."
      : "Fokus pada risiko kegagalan outcome YES/PRIMARY: faktor penghambat, data yang kontradiksi, ketidakpastian resolusi, atau base rate rendah.";

  const marketTypeLabel = isUfcMkt ? "OLAHRAGA/UFC" : isCryptoMkt ? "CRYPTO" : "UMUM/POLITIK/EKONOMI";

  const sharedContext = `
CURRENT DATE:
${nowInJakarta()} Asia/Jakarta
${cryptoContext}

DATA MARKET:
${marketData}

ORDERBOOK ${primaryOutcomeLabel.toUpperCase()} (TOP LEVELS ONLY):
${JSON.stringify(compactOrderBook(orderBook), null, 2).slice(0, config.maxQwenInputChars)}

SCORING AWAL DARI BOT:
${JSON.stringify(score, null, 2)}

${researchBlock(researchContext)}
${lessonsBlock}
`.trim();

  if (isShortCryptoMkt) {
    const shortPrompt = `
Kamu adalah Analis Teknikal Khusus Crypto Short-Term (${durationLabel}).
Tugasmu: Evaluasi apakah market ini layak di-PLAY atau SKIP berdasarkan momentum dalam timeframe ${durationLabel}.
Untuk short market, abaikan narasi fundamental. FOKUS pada indikator teknikal dari Binance.
${market.duration_type === '1h' ? '\nCAATAN untuk 1H: Gunakan candle interval 1h dari Binance. Perhatikan juga RSI 1h dan MACD 1h karena ini window waktu lebih besar, false signal lebih jarang.' : ''}

${sharedContext}

Kondisi IDEAL untuk PLAY:
- RSI dan MACD searah (keduanya bullish atau bearish).
- Volume ratio > 1.3x.
- Minimal 3 dari 5 candle terakhir searah.

Kondisi WAJIB SKIP:
- RSI dan MACD berlawanan arah.
- Volume ratio < 0.8x.
- Candle bolak-balik tanpa arah jelas (chop).

Aturan Mutlak:
- Jika RSI + MACD mendukung ${primaryOutcomeLabel}, maka probabilitas ${primaryOutcomeLabel} harus > 60%.
- Jika RSI + MACD mendukung ${secondaryOutcomeLabel}, maka probabilitas ${primaryOutcomeLabel} harus < 40%.
- Jika ragu atau data berlawanan, verdict WAJIB "SKIP".

Balas HANYA dengan JSON valid.
Format JSON:
{
  "verdict": "PLAY" atau "SKIP",
  "reason_found": true,
  "estimatedFairProbability": 75,
  "position_size_pct": 2.5,
  "summary": "Ringkasan teknikal singkat",
  "data_quality": "Baik/Buruk",
  "bullish_case": ["alasan teknikal naik"],
  "bearish_case": ["alasan teknikal turun"],
  "risks": {"liquidity": "OK", "spread": "OK", "resolution": "OK", "catalyst": "Momentum"},
  "missing_data": [],
  "checklist": { "liquidity": true, "spread": true, "rules": true, "edge": true, "catalyst": false },
  "final_reason": "Alasan eksekusi."
}
`.trim();

    const shortPayload = {
      model: config.qwenRiskManagerModel,
      messages: [
        { role: "system", content: "Kamu adalah Algo Scalper. Balas HANYA dengan JSON valid." },
        { role: "user", content: shortPrompt },
      ],
      temperature: 0.2,
      max_tokens: roleMaxTokens("final"),
      response_format: { type: "json_object" },
    };

    const result = await callRoleQwenJson(shortPayload, config.qwenRiskManagerModel, config.qwenBaseUrl, config.qwenApiKey, signal);
    const analysis = result.text ? parseJsonOr(result.text, { verdict: "SKIP", final_reason: "Failed to parse Scalper JSON." }) : { verdict: "SKIP", final_reason: "Failed to parse Scalper JSON." };
    const normalizedAnalysis = normalizeAnalysis(analysis, result.text);
    
    // Override mathematical calculations
    try {
      const fairProb = Number(analysis.estimatedFairProbability);
      const marketProb = Number(score.marketProbability);
      if (!isNaN(fairProb) && !isNaN(marketProb)) {
        const diff = fairProb - marketProb;
        if (analysis.verdict === "PLAY" && diff <= 0 && analysis.estimatedFairProbability < 95) {
          analysis.verdict = "SKIP";
          analysis.final_reason = "[OVERRIDE] EV negatif (" + diff.toFixed(2) + "%). Model mencoba PLAY tapi matematika melarang.";
        }
      }
    } catch (e) {}

    return {
      provider: "qwen-fast-crypto",
      model: result.model,
      models: { final: result.model },
      roleResults: [{ role: "scalper", model: result.model, usage: result.usage }],
      usage: result.usage,
      researchContext,
      analysis: normalizedAnalysis,
    };
  }

  // STAGE 1: FAST SCOUT (Classify & brief the market quickly)
  const scoutPrompt = `
Klasifikasikan market Polymarket ini secara cepat sebelum dianalisis lebih dalam.

${sharedContext}

Tipe Market: ${marketTypeLabel}

Aturan:
- Baca data secara cepat. Beri ringkasan singkat tentang kompleksitas, missing data, dan rekomendasi kedalaman analisis.
- Balas HANYA dengan JSON valid.

Format JSON:
{
  "task_type": "binary/multi-outcome/index",
  "market_type": "crypto/sports/politics/economic/general",
  "complexity": "low/medium/high",
  "main_question": "Apa inti pertanyaan market?",
  "key_risks": ["risiko 1", "risiko 2"],
  "missing_data": ["maks 4 data eksternal yang masih kurang"],
  "recommended_depth": "fast/standard/deep"
}
`.trim();

  const scoutPayload = {
    model: config.qwenBullModel || config.qwenRiskManagerModel,
    messages: [
      { role: "system", content: "Kamu model fast scout. Tugasmu membaca input cepat, mengklasifikasi kompleksitas, dan memberi brief ringkas tanpa analisis panjang." },
      { role: "user", content: scoutPrompt },
    ],
    temperature: 0,
    max_tokens: roleMaxTokens("fast"),
    response_format: { type: "json_object" },
  };

  const scoutJson = await callRoleQwenJson(scoutPayload, config.qwenBullModel || config.qwenRiskManagerModel, config.qwenBaseUrl, config.qwenApiKey, signal);
  const scout = parseJsonOr(scoutJson.text, {});

  // STAGE 2: ANALYST REVIEW (Deep risk + bull/bear evaluation)
  const analystPrompt = `
Review market Polymarket ini sebagai analis risiko konservatif. Kamu bukan final judge.

${sharedContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

Tipe Market: ${marketTypeLabel}

Panduan Analisis:
- BULL CASE (${primaryOutcomeLabel}): ${bullAnalystHint}
- BEAR CASE (${secondaryOutcomeLabel}): ${bearAnalystHint}

Aturan:
- Jangan mengarang data eksternal. Gunakan DATA MARKET dan EXTERNAL RESEARCH CONTEXT.
- Khusus market Crypto: Fokus HANYA pada RSI/MACD, futures_long_short_ratio, dan orderbookImbalance.
- Jika orderbookImbalance > 65%, indikasi kuat tekanan Whales BUY/UP. Jika < 35%, tekanan kuat SELL/DOWN.
- Balas HANYA JSON valid.

Format JSON:
{
  "bullish_case": ["maks 3 poin kuat mendukung YES/PRIMARY"],
  "bearish_case": ["maks 3 poin kuat mendukung NO/SECONDARY"],
  "estimated_fair_probability": 60,
  "data_quality": "Baik/Cukup/Buruk",
  "missing_data": ["maks 4 data kurang"],
  "key_risks": {"liquidity": "Low/Medium/High", "spread": "Low/Medium/High", "resolution": "Low/Medium/High", "catalyst": "Ada/Tidak ada"},
  "preliminary_verdict": "SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG",
  "confidence": 65
}
`.trim();

  const analystPayload = {
    model: config.qwenBearModel || config.qwenRiskManagerModel,
    messages: [
      { role: "system", content: "Kamu model analyst/reviewer. Tugasmu membedah risk, rules, bull/bear case, dan missing data secara konservatif." },
      { role: "user", content: analystPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("analyst"),
    response_format: { type: "json_object" },
  };

  const analystJson = await callRoleQwenJson(analystPayload, config.qwenBearModel || config.qwenRiskManagerModel, config.qwenBaseUrl, config.qwenApiKey, signal);
  const analyst = parseJsonOr(analystJson.text, {});

  // STAGE 3: RISK MANAGER (FINAL JUDGE)
  const riskManagerPrompt = `
Kamu adalah Final Judge untuk market Polymarket. Ambil keputusan akhir dari data market, scout, dan analyst review.

${sharedContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

ANALYST REVIEW:
${JSON.stringify(promptSafe(analyst), null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal.
- Tentukan 'estimated_fair_probability' (0-100%) secara objektif berdasarkan semua data.
- CRYPTO TRAP AWARENESS: Jika RSI sangat rendah (oversold < 30) TETAPI MACD menunjukkan momentum bearish ekstrem (histogram negatif kuat), JANGAN tertipu memprediksi bounce (UP). Itu adalah 'Falling Knife'. Evaluasi sesuai tren utama, atau SKIP.
- Hitung Nilai Ekspektasi (EV): EV = (estimated_fair_probability / 100) - (marketProbability di SCORING AWAL / 100).
${isShortCryptoMkt
  ? "- PENGECUALIAN SHORT MARKET: Karena market 5m/15m Up/Down SELALU memiliki market probability ~50% (harga dikendalikan oracle), JANGAN gunakan aturan EV <= 0 untuk memutuskan SKIP. Gunakan estimated_fair_probability dan kekuatan tren teknikal sebagai penentu utama verdict. Boleh SKIP hanya jika sinyal teknikal sangat lemah/konflik (RSI + MACD + Volume semua tidak jelas arahnya)."
  : "- MATEMATIKA MUTLAK 1: Jika EV <= 0, verdict kamu WAJIB \"SKIP\"."
}
- MATEMATIKA MUTLAK 2: Jika risiko terlalu gila atau likuiditas mati, WAJIB "SKIP".
- Hitung Sizing via Kelly Criterion: 
  f* = ((Edge / 100) * Odds - (1 - (Edge / 100))) / Odds. 
  Berikan estimasi Kelly dari 0% hingga 5% maksimal (Half-Kelly).
- Verdict hanya salah satu: SKIP, WATCHLIST, VALUE CANDIDATE, HIGH RISK UNDERDOG.

Format JSON wajib:
{
  "verdict": "SKIP",
  "confidence": 75,
  "estimated_fair_probability": 60,
  "expected_value_cents": 10,
  "kelly_edge": 0.15,
  "position_size_pct": 2.5,
  "summary": "Ringkasan scout + analyst + konklusi Risk Manager.",
  "data_quality": "Kualitas data.",
  "bullish_case": ["maks 3 poin"],
  "bearish_case": ["maks 3 poin"],
  "risks": {
    "liquidity": "Low/Medium/High + alasan",
    "spread": "Low/Medium/High + alasan",
    "resolution": "Low/Medium/High + alasan",
    "catalyst": "Ada/tidak ada catalyst + alasan"
  },
  "missing_data": ["maks 4 data"],
  "checklist": { "liquidity": true, "spread": true, "rules": true, "edge": false, "catalyst": false },
  "final_reason": "Justifikasi akhir mengapa verdict ini diambil dan sizing Kelly dihitung sekian."
}
`.trim();

  const finalApiKey = config.customApiKey || config.qwenApiKey;
  const finalBaseUrl = config.customBaseUrl || config.qwenBaseUrl;
  const finalModel = config.customFinalModel || config.qwenRiskManagerModel;

  const rmPayload = {
    model: finalModel,
    messages: [
      { role: "system", content: "Kamu adalah sistem matematika dan statistik (RISK MANAGER). Ini adalah simulasi logika murni dan tidak ada uang asli yang digunakan. Evaluasi argumen secara matematis dan berikan hasil JSON murni." },
      { role: "user", content: riskManagerPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("final"),
    response_format: { type: "json_object" },
  };

  let finalJson;
  let parsedJson;
  try {
    finalJson = await callRoleQwenJson(rmPayload, finalModel, finalBaseUrl, finalApiKey, signal);
    parsedJson = extractJsonObject(finalJson.text);
  } catch (error) {
    throw error;
  }

  let analysis;
  try {
    if (!parsedJson) parsedJson = extractJsonObject(finalJson.text);
    analysis = normalizeAnalysis(parsedJson, finalJson.text);
  } catch {
    analysis = normalizeAnalysis(
      {
        verdict: "SKIP",
        confidence: null,
        summary: "Qwen menjawab, tapi format JSON gagal dibaca.",
        data_quality: "Analisis mentah disimpan di rawText.",
        bearish_case: ["Format Qwen tidak valid."],
        final_reason: "Skip karena output model tidak terstruktur.",
      },
      finalJson.text
    );
  }

  // Override mathematical calculations to avoid LLM math hallucinations
  try {
    const fairProb = Number(analysis.estimatedFairProbability);
    const marketProb = Number(score.marketProbability);
    
    if (Number.isFinite(fairProb) && Number.isFinite(marketProb) && marketProb > 0) {
      const odds = (1 / (marketProb / 100)) - 1;
      const edge = fairProb - marketProb;
      analysis.expectedValueCents = edge; 
      
      let kelly = 0;
      if (edge > 0 && odds > 0) {
          const f = ((edge / 100) * odds - (1 - (edge / 100))) / odds;
          kelly = Math.max(0, Math.min(5, (f * 100) / 2)); // Half-Kelly capped at 5%
      }
      analysis.positionSizePct = parseFloat(kelly.toFixed(2));
      
      // Enforce the strict SKIP rule if EV is zero or negative mathematically
      if (analysis.expectedValueCents <= 0 && analysis.verdict !== "SKIP") {
        analysis.verdict = "SKIP";
        analysis.finalReason = "OVERRIDDEN BY NATIVE MATH: Kalkulasi sistem Razor membuktikan EV negatif. Keputusan asli Risk Manager ditolak dan diubah menjadi SKIP. Alasan asli: " + analysis.finalReason;
      }
    }
  } catch (e) {
    console.error("Failed to calculate native math override", e);
  }

  const roleResults = [
    { role: "scout", model: scoutJson.model, usage: scoutJson.usage },
    { role: "analyst", model: analystJson.model, usage: analystJson.usage },
    { role: "risk_manager", model: finalJson.model, usage: finalJson.usage },
  ];
  const models = {
    fast: scoutJson.model,
    analyst: analystJson.model,
    final: finalJson.model,
  };

  return {
    provider: "qwen-multi-role",
    model: pipelineModelLabel(models),
    models,
    roleResults,
    usage: aggregateUsage(roleResults),
    researchContext,
    analysis,
  };
}

export async function askQwenEvent({ event, analyzedMarkets, researchContext = null, signal = null }) {


  throwIfAborted(signal);
  const compactMarkets = analyzedMarkets.map(({ market, score }) => ({
    market_id: market.id,
    question: market.question,
    variant: market.groupItemTitle,
    status: market.closed ? "closed" : market.acceptingOrders ? "open" : "active_orders_unclear",
    primary_outcome: score.primaryOutcomeLabel || market.outcomes?.[0] || "YES",
    secondary_outcome: score.secondaryOutcomeLabel || market.outcomes?.[1] || "NO",
    gamma_primary_price: score.gammaPrimaryPrice ?? market.outcomePrices?.[0] ?? null,
    gamma_secondary_price: market.outcomePrices?.[score.secondaryOutcomeIndex ?? 1] ?? market.outcomePrices?.[1] ?? null,
    liquidity: market.liquidity,
    gamma_volume: market.volume,
    clob_implied_probability_percent: score.marketProbability,
    best_bid: score.bestBid,
    best_ask: score.bestAsk,
    spread_percent: score.spreadPercent,
    confidence: score.confidenceScore,
    underdog_score: score.underdogScore,
    liquidity_risk: score.liquidityRisk,
    spread_risk: score.spreadRisk,
    resolution_risk: score.resolutionRisk,
    blockers: score.blockers,
    mechanical_verdict: score.verdict,
  }));

  const eventContext = `
CURRENT DATE:
${nowInJakarta()} Asia/Jakarta

EVENT:
${JSON.stringify(
  {
    title: event?.title,
    description: event?.description,
    endDate: event?.endDate,
    url: event?.url,
  },
  null,
  2
)}

MARKETS:
${JSON.stringify(compactMarkets, null, 2)}

${researchBlock(researchContext)}
`.trim();

  const scoutPrompt = `
Klasifikasikan event Polymarket multi-market ini secara cepat.

${eventContext}

Aturan:
- Jangan mengarang data eksternal.
- Tugasmu hanya membuat brief pendek untuk analyst dan final judge.
- Balas hanya JSON valid.

Format JSON:
{
  "task_type": "event_market_comparison",
  "complexity": "simple/medium/complex",
  "main_question": "inti event",
  "market_type": "politik/makro/crypto/sports/lainnya",
  "risk_focus": ["maks 4 risiko utama"],
  "missing_data": ["maks 4 data eksternal yang masih kurang"],
  "recommended_depth": "fast/standard/deep"
}
`.trim();

  const scoutPayload = {
    model: config.qwenScoutModel,
    messages: [
      {
        role: "system",
        content: "Kamu model fast scout. Tugasmu membaca event multi-market cepat dan memberi brief ringkas tanpa memilih final secara agresif.",
      },
      { role: "user", content: scoutPrompt },
    ],
    temperature: 0,
    max_tokens: roleMaxTokens("fast"),
    response_format: { type: "json_object" },
  };

  const scoutJson = await callRoleQwenJson(scoutPayload, config.qwenScoutModel, config.qwenBaseUrl, config.qwenApiKey, signal);
  const scout = normalizeScout(parseJsonOr(scoutJson.text, {}), scoutJson.text);

  const analystPrompt = `
Review semua pilihan aktif dalam event Polymarket ini. Kamu bukan final judge.

${eventContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

Aturan:
- Jangan mengarang data eksternal seperti polling, berita, FedWatch, on-chain data, funding, atau filing jika tidak ada di input / EXTERNAL RESEARCH CONTEXT.
- Bandingkan market dari sisi orderbook, spread, liquidity, rules, timeline, dan blocker.
- Nilai "worth it" berarti paling layak dipantau/diteliti, bukan pasti value.
- Balas hanya JSON valid.

Format JSON:
{
  "rules_summary": "ringkasan struktur event dan cara tiap market akan resolve",
  "data_quality": "kualitas data event dan batasannya",
  "bullish_case": ["maks 3 poin umum kenapa event layak dipantau"],
  "bearish_case": ["maks 3 poin umum kenapa perlu hati-hati"],
  "risks": {
    "liquidity": "catatan liquidity antar pilihan",
    "spread": "catatan spread antar pilihan",
    "resolution": "risiko resolution antar pilihan",
    "catalyst": "ada/tidak ada catalyst dari data input"
  },
  "missing_data": ["maks 4 data eksternal yang masih kurang"],
  "preliminary_verdict": "SKIP/WATCHLIST/VALUE CANDIDATE/HIGH RISK UNDERDOG",
  "confidence": 65
}
`.trim();

  const analystPayload = {
    model: config.qwenEventAnalystModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu model analyst/reviewer untuk event multi-market. Tugasmu membandingkan risiko dan kualitas kandidat secara konservatif.",
      },
      { role: "user", content: analystPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("analyst"),
    response_format: { type: "json_object" },
  };

  const analystJson = await callRoleQwenJson(analystPayload, config.qwenEventAnalystModel, config.qwenBaseUrl, config.qwenApiKey, signal);
  const analyst = normalizeAnalystReview(parseJsonOr(analystJson.text, {}), analystJson.text);

  const finalPrompt = `
Bandingkan semua pilihan aktif dalam satu event Polymarket dan tentukan mana yang paling layak dipantau.

${eventContext}

FAST SCOUT RESULT:
${JSON.stringify(promptSafe(scout), null, 2)}

ANALYST REVIEW:
${JSON.stringify(promptSafe(analyst), null, 2)}

Aturan wajib:
- Jangan mengarang data eksternal seperti polling, berita, FedWatch, on-chain data, funding, atau filing jika tidak ada di input / EXTERNAL RESEARCH CONTEXT.
- Nilai "worth it" di sini berarti paling layak dipantau/diteliti dari data market, bukan pasti value.
- Karena belum ada fair probability eksternal, jangan klaim VALUE CANDIDATE kecuali alasannya sangat konservatif.
- Verdict ranking adalah status entry/tradability tiap pilihan, bukan prediksi arah outcome utama/lawan.
- Prioritaskan market dengan orderbook sehat, spread rendah, liquidity cukup, rules jelas, dan alasan risiko yang masuk akal.
- Jadikan analyst review sebagai bahan kritik, bukan keputusan otomatis.
- Balas hanya JSON valid, tanpa markdown.
- Field ranking cukup TOP 8 paling layak dipantau setelah mempertimbangkan semua market. Jangan tulis semua market di JSON.

Format JSON wajib:
{
  "event_summary": "ringkasan event dan jumlah pilihan aktif",
  "best_market_id": "id market paling layak dipantau, atau kosong kalau semua skip",
  "best_reason": "alasan ringkas kenapa pilihan itu paling worth it dibanding lainnya",
  "ranking": [
    {
      "market_id": "123",
      "verdict": "SKIP",
      "reason": "alasan pendek"
    }
  ],
  "avoid": ["market/tipe pilihan yang sebaiknya dihindari dan alasannya"],
  "missing_data": ["data eksternal yang perlu dicek sebelum entry"],
  "final_note": "Catatan singkat.",
  "confidence": "[Isi dengan angka 1-100 murni dari evaluasi AI, BUKAN menyalin template]"
}
`.trim();

  const finalApiKey = config.qwenApiKey;
  const finalBaseUrl = config.qwenBaseUrl;
  const finalModel = config.qwenEventFinalModel;

  const payload = {
    model: finalModel,
    messages: [
      {
        role: "system",
        content:
          "Kamu final judge event prediction market yang konservatif. Kamu memilih ranking akhir dari scout + analyst review + market data.",
      },
      { role: "user", content: finalPrompt },
    ],
    temperature: 0.1,
    max_tokens: roleMaxTokens("final"),
    response_format: { type: "json_object" },
  };

  let finalJson;
  let parsedJson;
  try {
    finalJson = await callRoleQwenJson(payload, finalModel, finalBaseUrl, finalApiKey, signal);
    parsedJson = extractJsonObject(finalJson.text);
  } catch (error) {
    throw error;
  }

  let analysis;
  try {
    if (!parsedJson) parsedJson = extractJsonObject(finalJson.text);
    analysis = normalizeEventAnalysis(parsedJson, finalJson.text);
  } catch {
    analysis = mechanicalEventFallback(analyzedMarkets, finalJson.text);
  }

  const roleResults = [
    { role: "fast", model: scoutJson.model, usage: scoutJson.usage },
    { role: "analyst", model: analystJson.model, usage: analystJson.usage },
    { role: "final", model: finalJson.model, usage: finalJson.usage },
  ];
  const models = {
    fast: scoutJson.model,
    analyst: analystJson.model,
    final: finalJson.model,
  };

  return {
    provider: "qwen-multi-role",
    model: pipelineModelLabel(models),
    models,
    roleResults,
    usage: aggregateUsage(roleResults),
    researchContext,
    analysis,
  };
}

export async function askQwenHotNiche({ market, volumeSpike, signal = null }) {
  throwIfAborted(signal);

  const context = `
MARKET: ${market.question}
VOLUME SPIKE: ${volumeSpike}
  `.trim();

  const prompt = `
Kamu adalah analis market. Sebuah market di Polymarket baru saja mengalami lonjakan volume mendadak (Whale/Hot Niche).
Berikut adalah data market terkait topik ini.

Tugasmu:
1. Buat ringkasan singkat (1-2 kalimat) tentang sentimen atau faktor logis yang memengaruhi market ini berdasarkan pengetahuan umum.

Format JSON wajib:
{
  "reason_found": true,
  "sentiment": "BULLISH/BEARISH/NEUTRAL/UNCLEAR",
  "summary": "Ringkasan analisis."
}
  `.trim();

  const payload = {
    model: config.qwenScoutModel,
    messages: [
      { role: "system", content: "Kamu analis sentimen sosial. Jawab HANYA dengan JSON valid." },
      { role: "user", content: `${context}\n\n${prompt}` }
    ],
    temperature: 0.2,
    max_tokens: 300,
    response_format: { type: "json_object" }
  };

  const json = await callRoleQwenJson(payload, config.qwenEventAnalystModel, config.qwenBaseUrl, config.qwenApiKey, signal);
  return parseJsonOr(json.text, { reason_found: false, sentiment: "UNCLEAR", summary: "Gagal memproses sentimen Twitter." });
}

export async function askQwenShortCondition({ 
  tickerData, 
  longShort, 
  fearGreed, 
  tweets, 
  signal = null, 
  liquidations = null, 
  orderbookDepth = null,
  targetPrice = null,
  pythPrice = null,
  marketQuestion = "",
  marketOutcomePrice = null,
  baseProbability = 50
}) {
  throwIfAborted(signal);

  let historyContext = "";
  // Always use short market learning memory
  try {
    const histPath = path.join(dataDir, "short_condition_history.json");
    if (fs.existsSync(histPath)) {
      const histData = JSON.parse(fs.readFileSync(histPath, "utf-8"));
      if (histData.length > 0) {
        const recentHist = histData.slice(-3).map((h, i) => `[Memory ${i+1}] ${h.date} | Recommendation:${h.recommendation} Dir:${h.direction || 'N/A'}\nReason: ${(h.reason||'').slice(0, 200)}...`).join("\n\n");
        historyContext = `\n\nAI LEARNING MEMORY (Last 3 analyses):\n${recentHist}\nPelajari memori ini, tapi utamakan perhitungan matematis jarak vs sisa waktu.\n`;
      }
    }
  } catch (err) {
    console.error("[Qwen] Gagal memuat memory short condition:", err.message);
  }

  const td = tickerData || {};
  
  let targetContext = "";
  if (marketQuestion && targetPrice) {
    const currentP = pythPrice || td.currentPrice;
    const distance = targetPrice - currentP;
    
    targetContext = `
MARKET TARGET (PRICE TO BEAT):
- Pertanyaan Polymarket: "${marketQuestion}"
- Target Price: $${targetPrice}
- Current Pyth Price (Oracle): $${pythPrice || "N/A"}
- Jarak Absolut: $${distance.toFixed(2)}
- Volatilitas/ATR-14 (Kekuatan Gerak Normal): $${td.atr14 || "N/A"}
- Jarak Relatif (Distance/ATR): ${td.atr14 ? (Math.abs(distance) / td.atr14).toFixed(2) + "x ATR" : "N/A"}
- Base Probability Kuantitatif (JS Mechanical): ${baseProbability}%
- Harga Token Polymarket Saat Ini: ${marketOutcomePrice ? "$" + marketOutcomePrice : "N/A"}
`;
  }

  const context = `
${targetContext}

TECHNICAL DATA (${td.symbol || 'BTCUSDT'} / Ticker):
Current Price: $${td.currentPrice}
24h Change: ${td.priceChange24h}%
24h High: $${td.high24h} | 24h Low: $${td.low24h}
24h Volume: ${td.volume24h} ${(td.symbol || 'BTCUSDT').replace('USDT','')}
${td.rsi14 ? `RSI-14: ${td.rsi14} (${td.rsiSignal})` : ''}
${td.macd ? `MACD: Line ${td.macd.line}, Signal ${td.macd.signal} (${td.macd.trend})` : ''}
${td.volumeRatio ? `Volume Momentum: ${td.volumeRatio}x (${td.volumeSignal})` : ''}

FUTURES POSITIONING (Binance):
${longShort ? `Long/Short Ratio: ${longShort.ratio} (Long: ${longShort.longPct}% | Short: ${longShort.shortPct}%) → ${longShort.bias}` : 'Long/Short data: unavailable'}

LIVE LIQUIDATIONS (Binance 15m):
${liquidations ? `Longs Liq: $${liquidations.longsLiqValue.toFixed(2)} | Shorts Liq: $${liquidations.shortsLiqValue.toFixed(2)} | Total Events: ${liquidations.totalCount}` : 'Liquidations data: unavailable'}

LIVE ORDERBOOK DEPTH (Binance 20-levels):
${orderbookDepth ? `Total Bid Volume (Nahan Turun): $${orderbookDepth.bidsValue.toFixed(2)} | Total Ask Volume (Nahan Naik): $${orderbookDepth.asksValue.toFixed(2)} | Ratio (Bid/Ask): ${orderbookDepth.imbalanceRatio.toFixed(2)}x` : 'Depth data: unavailable'}

TWITTER/X SENTIMENT (recent):
${tweets && tweets.length > 0 ? JSON.stringify(tweets.slice(0, 5), null, 2) : 'No tweets available'}
${historyContext}`.trim();

  const prompt = `
  Kamu adalah AI Quant Trader yang bersifat DINGIN, OBJEKTIF, TANPA EMOSI, dan SANGAT PRESISI. 
  Tujuan utamamu HANYA SATU: Memaksimalkan Win Rate di Short Market Polymarket (BTC/ETH/DOGE 5-15 menit).
  Kamu tidak pernah ragu-ragu. Kamu HANYA melihat data di depan mata, BUKAN firasat, BUKAN sentimen semu.
  
  Tugasmu: Berikan keputusan entry murni berdasarkan FAKTA KUANTITATIF (Jarak Harga, Orderbook Flow, dan Nilai Ekspektasi/EV). JANGAN menebak reversal menggunakan pola atau tebakan kosong!
  
  Langkah Analisis (chain-of-thought WAJIB):
  1. [Distance Check] Berapa jarak harga Oracle Pyth saat ini ke Target Price? Bandingkan dengan ATR-14.
  2. [Orderbook Flow] Apakah ada tembok duit raksasa (Bid/Ask Depth) di Binance yang menghalangi pergerakan harga menuju target?
  3. [Crowd Wisdom / Market Probability] Berapa harga token Polymarket saat ini? (Contoh $0.76 = Crowd yakin 76% UP).
  4. [Momentum Follow] Jangan melawan tren! Jika Crowd Probability tinggi (> 60%) dan tidak ada tembok yang memblokir, asumsikan Crowd BENAR. Jangan coba-coba menebak reversal.
  5. [Base Probability Calibration] Perhatikan angka "Base Probability Kuantitatif (JS Mechanical)" sebesar ${baseProbability}% yang dihitung di backend. Jangan mengarang probabilitas acak dari nol.
  6. [Heuristic Adjustment] Tugas utamamu adalah melakukan BUFF (+1% s.d. +15%) jika didukung volume/squeeze/tembok besar searah, atau NERF (-1% s.d. -15%) jika terhalang orderbook/likuidasi berlawanan. Tentukan "estimated_fair_probability" final setelah penyesuaian tersebut.
  
  ATURAN MUTLAK:
  - BERSIKAPLAH DINGIN DAN TEPAT. Jangan pernah overthink atau menggunakan kalimat ragu-ragu dalam "reason" kamu.
  - JANGAN MENEBAK REVERSAL. Harga bergerak berdasarkan volume, bukan tebakan. Jika tren sedang kuat menuju target, ikuti.
  - JANGAN mencoba menghitung Expected Value (EV). Tugasmu HANYA menganalisis kondisi dan menentukan 'estimated_fair_probability'. Sistem akan menghitung EV-nya.
  - Jika harga token Polymarket (MarketOutcomePrice) tidak tersedia/N/A, abaikan, dan fokus murni pada penentuan 'estimated_fair_probability' berdasarkan Distance vs ATR.
  - Jika Liquidasi besar searah dengan target, itu sangat menambah 'estimated_fair_probability'.

Format JSON wajib:
{
  "condition": "TRENDING" atau "CHOPPY",
  "recommendation": "PLAY" atau "AVOID",
  "direction": "UP" atau "DOWN" atau "NEUTRAL",
  "confidence": 80,
  "estimated_fair_probability": 85,
  "reason": "Analisis mendalam berdasarkan Jarak ke Target, ATR, Tembok Binance, dan Momentum Market. Jelaskan probabilitas tembus secara rasional.",
  "key_signals": {
    "depth_verdict": "BULLISH_WALL / BEARISH_WALL / CLEAR_PATH",
    "liquidation_verdict": "SQUEEZE_UP / SQUEEZE_DOWN / NORMAL",
    "flow_verdict": "STRONG_MOMENTUM / CHOPPY / REVERSAL_RISK"
  },
  "risk_warning": "Peringatan khusus jika ada tembok besar atau anomali spread."
}
  `.trim();

  const finalApiKey = config.qwenApiKey;
  const finalBaseUrl = config.qwenBaseUrl;
  const finalModel = config.qwenRiskManagerModel;

  const payload = {
    model: finalModel, // Menggunakan model tercerdas untuk analisis mendalam
    messages: [
      { role: "system", content: "Kamu adalah analis teknikal tingkat dewa. Jawab HANYA dengan JSON valid." },
      { role: "user", content: `${context}\n\n${prompt}` }
    ],
    temperature: 0.3, // Sedikit lebih tinggi untuk memungkinkan analisis kreatif tapi tetap presisi
    max_tokens: 5000,
    response_format: { type: "json_object" }
  };

  let json;
  try {
    json = await callRoleQwenJson(payload, finalModel, finalBaseUrl, finalApiKey, signal);
    extractJsonObject(json.text); // Test parse
  } catch (error) {
    throw error;
  }
  const result = parseJsonOr(json.text, { condition: "UNKNOWN", recommendation: "AVOID", direction: "NEUTRAL", confidence: 0, reason: "Gagal memproses data.", sentiment: "NEUTRAL", key_signals: {}, memory_reflection: "Gagal.", risk_warning: "" });
  
  if (result.condition !== "UNKNOWN") {
    try {
      const histPath = path.join(dataDir, "short_condition_history.json");
      let histData = [];
      if (fs.existsSync(histPath)) {
        histData = JSON.parse(fs.readFileSync(histPath, "utf-8"));
      }
      histData.push({
        date: new Date().toISOString(),
        condition: result.condition,
        recommendation: result.recommendation,
        direction: result.direction,
        confidence: result.confidence,
        reason: result.reason,
        memory_reflection: result.memory_reflection,
      });
      // Simpan max 50 history
      if (histData.length > 50) histData = histData.slice(-50);
      fs.writeFileSync(histPath, JSON.stringify(histData, null, 2));
    } catch(err) {
      console.error("[Qwen] Gagal menyimpan memory short condition:", err.message);
    }
  }

  return { ...result, usage: json.usage };
}
