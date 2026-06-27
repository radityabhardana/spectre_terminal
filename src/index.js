import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertConfig, config } from "./config.js";
import {
  formatAnalysis,
  formatAnalyzeAllSummary,
  formatBook,
  formatEventHubPrompt,
  formatEventQuickScan,
  formatHelp,
  formatMarketBubble,
  formatSearchResults,
  formatTopMarkets,
  directionSignal,
  formatShortCondition,
} from "./format.js";
import {
  getMarketFromPolymarketLink,
  getMarketById,
  getMarketsFromPolymarketLink,
  listTopMarkets,
  getOrderBook,
  parsePolymarketLink,
  pickYesNoTokens,
  SEARCH_ENGINE_VERSION,
  searchMarkets,
} from "./polymarket.js";
import { askQwen, askQwenEvent, askQwenHotNiche } from "./qwen.js";
import { scrapeTwitter } from "./twitter_scraper.js";
import { broadcastAlert } from "./web.js";
import { buildResearchContext } from "./research.js";
import { enterCommandGuard, releaseCommandGuard } from "./rate-limit.js";
import { scoreMarket } from "./scoring.js";
import { getRecentWhales, formatSnifferWhales, setSnifferState, getSnifferState, setNotificationCallback, getTrackerConfig, setTrackerConfig, getAggressiveMode } from "./sniffer.js";
import { appendAnalysisLog, addAnalyzedEvent } from "./storage.js";
import { TelegramBot } from "./telegram.js";

// Helper untuk UI
export async function getWhalesData(minSize = 500) {
  const whales = getRecentWhales(minSize);
  return formatSnifferWhales(whales, minSize);
}

// ── Admin Chat ID untuk Push Notification (Sniffer) ───────────────────────
let adminChatId = null;

// ── CloddsBot-ported modules ──────────────────────────────────────────────
import {
  addAlert, listAlerts, deleteAlert, startAlertMonitor,
  formatAlertsList, parseAlertCommand,
} from "./alerts.js";
import {
  scanWhaleActivity, fetchTopTraders, scanInternalArbitrage,
  formatWhaleResults, formatTopTraders, formatInternalArbitrageResults,
} from "./whale.js";
import {
  detectInternalArbitrage, detectCrossPlatformArbitrage, scanAllOpportunities,
  formatOpportunityScan,
} from "./arbitrage.js";
import {
  getShadowTrades, calculatePerformanceMetrics, calculateKelly,
  getPerformanceByCategory, getTimingAnalysis, runBacktest,
  formatAnalyticsSummary, formatKellyResult, formatBacktestResult, formatTimingAnalysis,
} from "./analytics.js";
import { evaluateResolutions } from "./evaluate.js";
import { evaluateShortMarketCondition } from "./short_condition.js";

const MENU_BUTTONS = {
  TOP: "Top Markets",
  SEARCH: "Search Market",
  ANALYZE: "Analyze Link / ID",
  QUICK_SCAN: "Quick Scan Event",
  ARB: "Scan Arbitrage",
  WHALES: "Whale Activity",
  ANALYTICS: "Performance Stats",
  EVALUATE: "Evaluate PnL",
  ALERTS: "My Alerts",
  BOOK: "Orderbook Check",
  SHORT_COND: "Short Market Vibe",
  VERSION: "Bot Version",
  HELP: "Help",
  EXAMPLE: "Example Flow",
};

function menuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: MENU_BUTTONS.TOP }, { text: MENU_BUTTONS.ANALYZE }],
        [{ text: MENU_BUTTONS.SEARCH }, { text: MENU_BUTTONS.QUICK_SCAN }],
        [{ text: MENU_BUTTONS.ARB }, { text: MENU_BUTTONS.WHALES }],
        [{ text: MENU_BUTTONS.ANALYTICS }, { text: MENU_BUTTONS.EVALUATE }],
        [{ text: MENU_BUTTONS.ALERTS }, { text: MENU_BUTTONS.SHORT_COND }],
        [{ text: MENU_BUTTONS.BOOK }, { text: MENU_BUTTONS.HELP }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      is_persistent: true,
    },
  };
}

const eventSessions = new Map();
const EVENT_SESSION_TTL_MS = 30 * 60 * 1000;

function createEventSession({ event, markets, sourceInput }) {
  cleanupEventSessions();
  const id = Math.random().toString(36).slice(2, 8);
  eventSessions.set(id, {
    id,
    event,
    markets,
    sourceInput,
    createdAt: Date.now(),
  });
  return id;
}

function cleanupEventSessions() {
  const cutoff = Date.now() - EVENT_SESSION_TTL_MS;
  for (const [id, session] of eventSessions.entries()) {
    if (session.createdAt < cutoff) eventSessions.delete(id);
  }
}

function getEventSession(id) {
  cleanupEventSessions();
  return eventSessions.get(String(id || "").trim()) || null;
}

function eventHubKeyboard({ sessionId, markets }) {
  const top = [...markets]
    .sort((a, b) => b.liquidity + b.volume - (a.liquidity + a.volume))
    .slice(0, 8);

  const rows = [
    [
      { text: "Quick Scan", callback_data: `/eventscan ${sessionId}` },
      { text: "AI Best", callback_data: `/eventbest ${sessionId}` },
    ],
    [
      { text: "Top 3", callback_data: `/eventtop ${sessionId}` },
      { text: "Analyze All", callback_data: `/eventall ${sessionId}` },
    ],
  ];

  for (let i = 0; i < top.length; i += 4) {
    rows.push(
      top.slice(i, i + 4).map((market, offset) => ({
        text: `${i + offset + 1}`,
        callback_data: `/eventmarket ${sessionId} ${market.id}`,
      }))
    );
  }

  rows.push([{ text: "Help", callback_data: "/help" }]);

  return {
    reply_markup: {
      inline_keyboard: rows,
    },
  };
}

function slugLike(value) {
  return /^[a-z0-9-]{5,}$/.test(String(value || "").trim());
}

function menuAnswer(text) {
  return { text, options: menuKeyboard() };
}

function normalizeButtonText(text) {
  const trimmed = String(text || "").trim();
  if (trimmed === MENU_BUTTONS.TOP) return "/top";
  if (trimmed === MENU_BUTTONS.SEARCH) return "/search";
  if (trimmed === MENU_BUTTONS.ANALYZE) return "/analyze";
  if (trimmed === MENU_BUTTONS.QUICK_SCAN) return "/quickscan";
  if (trimmed === MENU_BUTTONS.ARB) return "/arb";
  if (trimmed === MENU_BUTTONS.WHALES) return "/whales";
  if (trimmed === MENU_BUTTONS.ANALYTICS) return "/analytics";
  if (trimmed === MENU_BUTTONS.EVALUATE) return "/evaluate";
  if (trimmed === MENU_BUTTONS.ALERTS) return "/alerts";
  if (trimmed === MENU_BUTTONS.BOOK) return "/book";
  if (trimmed === MENU_BUTTONS.VERSION) return "/version";
  if (trimmed === MENU_BUTTONS.HELP) return "/help";
  if (trimmed === MENU_BUTTONS.EXAMPLE) return "/example";
  return text;
}

function parseCommand(text) {
  const normalized = normalizeButtonText(text).trim();
  if (looksLikeUrl(normalized)) return { command: "/analyze", arg: normalized };
  if (isShortMarketId(normalized)) return { command: "/analyze", arg: normalized };

  const [commandWithBot, ...rest] = normalized.split(/\s+/);
  const command = commandWithBot.split("@")[0].toLowerCase();
  return { command, arg: rest.join(" ").trim() };
}

function isShortMarketId(value) {
  return /^[0-9]{1,10}$/.test(value.trim());
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Prompt dibatalkan.");
    error.name = "AbortError";
    throw error;
  }
}

async function resolveMarketInput(arg) {
  if (isShortMarketId(arg)) return getMarketById(arg);

  if (looksLikeUrl(arg)) {
    const parsed = parsePolymarketLink(arg);
    if (!parsed) {
      throw new Error("Link harus dari polymarket.com/event/... atau polymarket.com/market/...");
    }

    const market = await getMarketFromPolymarketLink(arg);
    if (!market) {
      throw new Error("Link Polymarket ditemukan, tapi tidak ada market aktif yang bisa dianalisis.");
    }

    return market;
  }

  return (await searchMarkets(arg, 1))[0];
}

async function resolveAnalyzeInput(arg) {
  if (isShortMarketId(arg)) {
    return { kind: "market", market: await getMarketById(arg), event: null };
  }

  if (looksLikeUrl(arg)) {
    const parsed = parsePolymarketLink(arg);
    if (!parsed) {
      throw new Error("Link harus dari polymarket.com/event/... atau polymarket.com/market/...");
    }

    const result = await getMarketsFromPolymarketLink(arg);
    if (!result || !result.markets?.length) {
      throw new Error("Link Polymarket ditemukan, tapi tidak ada market aktif yang bisa dianalisis.");
    }

    if (result.kind === "event" && result.markets.length > 1) {
      return { kind: "event", event: result.event, markets: result.markets };
    }

    return { kind: "market", market: result.markets[0], event: result.event };
  }

  const market = (await searchMarkets(arg, 1))[0];
  return { kind: "market", market, event: null };
}

async function scoreOneMarket(market) {
  const tokens = pickYesNoTokens(market);
  if (!tokens.yesTokenId) {
    throw new Error(`Market ${market.id} tidak punya token utama.`);
  }

  const yesBook = await getOrderBook(tokens.yesTokenId);
  const baseScore = scoreMarket({ market, yesBook });
  const clobMidpoint =
    baseScore.marketProbability == null ? null : baseScore.marketProbability / 100;
  const gammaPrice = Number(tokens.yesPrice);
  const dataWarnings = [];

  if (
    Number.isFinite(clobMidpoint) &&
    Number.isFinite(gammaPrice) &&
    Math.abs(clobMidpoint - gammaPrice) >= 0.05
  ) {
    dataWarnings.push(
      `Gamma ${tokens.yesLabel} price ${gammaPrice.toFixed(3)} beda dari CLOB midpoint ${clobMidpoint.toFixed(3)}; untuk live market pakai CLOB/orderbook sebagai acuan utama.`
    );
  }

  if (Number(market.volume) > 0 && Number(market.volume) < 100) {
    dataWarnings.push(
      "Gamma volume sangat kecil untuk market live; volume bisa stale/baru mulai dan tidak selalu mencerminkan aktivitas orderbook."
    );
  }

  const score = {
    ...baseScore,
    primaryOutcomeLabel: tokens.yesLabel,
    secondaryOutcomeLabel: tokens.noLabel,
    primaryOutcomeIndex: tokens.yesIndex,
    secondaryOutcomeIndex: tokens.noIndex,
    primaryTokenId: tokens.yesTokenId,
    secondaryTokenId: tokens.noTokenId,
    gammaPrimaryPrice: Number.isFinite(gammaPrice) ? gammaPrice : null,
    dataWarnings,
  };
  return { market, yesBook, score };
}

async function scoreEventMarkets(markets, setStep, signal = null) {
  const analyzed = [];
  const batchSize = 5;

  for (let index = 0; index < markets.length; index += batchSize) {
    throwIfAborted(signal);
    const batch = markets.slice(index, index + batchSize);
    setStep(`Checking CLOB orderbooks ${Math.min(index + batch.length, markets.length)}/${markets.length}`);

    const rows = await Promise.all(
      batch.map(async (market) => {
        try {
          return await scoreOneMarket(market);
        } catch (error) {
          return { market, yesBook: null, score: null, error: error.message };
        }
      })
    );

    analyzed.push(...rows.filter((row) => row.score));
  }

  return analyzed;
}

function sortMarketsForAllMode(rows) {
  return [...rows].sort((a, b) => {
    const aBlocked = (a.score.blockers || []).length;
    const bBlocked = (b.score.blockers || []).length;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;

    const aSpread = Number.isFinite(a.score.spreadPercent) ? a.score.spreadPercent : 99;
    const bSpread = Number.isFinite(b.score.spreadPercent) ? b.score.spreadPercent : 99;
    if (aSpread !== bSpread) return aSpread - bSpread;

    return b.market.liquidity + b.market.volume - (a.market.liquidity + a.market.volume);
  });
}

function hardBlockersWithoutEdge(score) {
  return (score.blockers || []).filter((item) => item !== "No measured positive edge");
}

function pickBestEventCandidate(analyzedMarkets, qwenResult) {
  const qwenBestId = String(qwenResult?.analysis?.bestMarketId || "");
  const ranking = Array.isArray(qwenResult?.analysis?.ranking)
    ? qwenResult.analysis.ranking
    : [];

  if (qwenBestId) {
    const best = analyzedMarkets.find((row) => String(row.market.id) === qwenBestId);
    if (best && hardBlockersWithoutEdge(best.score).length === 0) return best;
  }

  for (const item of ranking) {
    const candidate = analyzedMarkets.find(
      (row) => String(row.market.id) === String(item.marketId)
    );
    if (candidate && hardBlockersWithoutEdge(candidate.score).length === 0) return candidate;
  }

  const sorted = sortMarketsForAllMode(analyzedMarkets);
  return sorted.find((row) => hardBlockersWithoutEdge(row.score).length === 0) || sorted[0] || null;
}

async function resolveAnalyzeAllEventInput(arg) {
  const input = String(arg || "").trim();
  const raw =
    looksLikeUrl(input) || input.includes("/")
      ? input
      : slugLike(input)
        ? `https://polymarket.com/event/${input}`
        : input;

  if (!looksLikeUrl(raw)) return null;
  const parsed = parsePolymarketLink(raw);
  if (!parsed) return null;

  return getMarketsFromPolymarketLink(raw);
}

function progressText({ query, step, elapsedSeconds, estimateSeconds, mode = "deep" }) {
  const remaining = Math.max(0, estimateSeconds - elapsedSeconds);
  const note =
    mode === "quick"
      ? "Bot sedang cek pilihan event dan CLOB orderbook tanpa Qwen."
      : "Bot sedang ambil market data, cek CLOB orderbook, lalu menjalankan Qwen fast -> analyst -> final.";
  return [
    "ANALISIS SEDANG BERJALAN",
    `Input: ${query}`,
    `Step: ${step}`,
    `Berjalan: ${elapsedSeconds}s`,
    `Estimasi sisa: ${remaining}s`,
    "",
    note,
  ].join("\n");
}

async function runWithProgress(ctx, query, task, options = {}) {
  const estimateSeconds = options.estimateSeconds || 60;
  const mode = options.mode || "deep";
  const startedAt = Date.now();
  let step = "Resolving market input";

  const progressMessage = await ctx.sendMessage(
    progressText({ query, step, elapsedSeconds: 0, estimateSeconds, mode }),
    menuKeyboard()
  );

  const interval = setInterval(async () => {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    if (elapsedSeconds >= 5 && elapsedSeconds < 10) step = "Fetching Gamma market data";
    else if (elapsedSeconds >= 10 && elapsedSeconds < 15) step = "Checking CLOB orderbook";
    else if (elapsedSeconds >= 15) step = "Running Qwen multi-role pipeline";

    try {
      await ctx.sendChatAction("typing");
      if (progressMessage?.message_id) {
        await ctx.editMessageText(
          progressMessage.message_id,
          progressText({ query, step, elapsedSeconds, estimateSeconds, mode })
        );
      }
    } catch {
      // Progress updates are best-effort; final analysis still matters most.
    }
  }, 5000);

  try {
    const result = await task((nextStep) => {
      step = nextStep;
    });

    if (progressMessage?.message_id) {
      await ctx.deleteMessage(progressMessage.message_id).catch(() => {});
    }

    return result;
  } catch (error) {
    if (progressMessage?.message_id) {
      await ctx
        .editMessageText(
          progressMessage.message_id,
          [
            "ANALISIS GAGAL",
            `Input: ${query}`,
            `Error: ${error.message}`,
          ].join("\n")
        )
        .catch(() => {});
    }
    throw error;
  } finally {
    clearInterval(interval);
  }
}

function eventResultFromSession(session) {
  if (!session) return null;
  return {
    kind: "event",
    event: session.event,
    markets: session.markets,
  };
}

async function resolveEventInput(arg) {
  const session = getEventSession(arg);
  if (session) return eventResultFromSession(session);
  return resolveAnalyzeAllEventInput(arg);
}

async function deepAnalyzeMarket({ market, query, setStep, signal = null }) {
  throwIfAborted(signal);
  setStep("Fetching CLOB orderbook");
  const scored = await scoreOneMarket(market);

  throwIfAborted(signal);
  setStep("Fetching crypto research context");
  const researchContext = await buildResearchContext({ market: scored.market });

  throwIfAborted(signal);
  
  const isShortCryptoMarket = /(bitcoin|btc|ethereum|eth|doge|dogecoin).*(up|down|above|below)/i.test(scored.market.question || "");
  let qwenResult;

  if (isShortCryptoMarket) {
    setStep("Running Qwen SHORT MARKET Sniper pipeline");
    const asset = /ethereum|eth/i.test(scored.market.question) ? "ETH" : /doge/i.test(scored.market.question) ? "DOGE" : "BTC";
    const shortRes = await evaluateShortMarketCondition({
      signal,
      asset,
      marketQuestion: scored.market.question,
      marketOutcomePrice: scored.score.marketProbability / 100
    });
    
    qwenResult = {
      model: "Sniper V2",
      usage: "N/A",
      analysis: {
        verdict: shortRes.evaluation.recommendation === "PLAY" ? "VALUE CANDIDATE" : "SKIP",
        confidence: shortRes.evaluation.confidence,
        estimatedFairProbability: shortRes.evaluation.estimated_fair_probability,
        expectedValueCents: shortRes.evaluation.expected_value_cents,
        finalReason: shortRes.evaluation.reason,
        summary: shortRes.evaluation.reason ? shortRes.evaluation.reason.substring(0, 150) + "..." : "Short Market Sniper V2",
        bullishCase: ["Flow Momentum: " + (shortRes.evaluation.key_signals?.flow_verdict || "")],
        bearishCase: ["Orderbook/Liq: " + (shortRes.evaluation.key_signals?.depth_verdict || "")]
      }
    };
  } else {
    setStep("Running Qwen market pipeline (Hedge Fund Mode)");
    qwenResult = await askQwen({
      market: scored.market,
      score: scored.score,
      orderBook: scored.yesBook,
      researchContext,
      signal,
    });
  }

  appendAnalysisLog({
    query,
    marketId: scored.market.id,
    question: scored.market.question,
    score: scored.score,
    qwen: {
      model: qwenResult.model,
      usage: qwenResult.usage,
      researchContext,
      analysis: qwenResult.analysis,
    },
  });

  // For short crypto markets (Up/Down), derive direction from Qwen Bull/Bear debate result
  // since Polymarket probability is always ~50% and useless for direction.
  // For all other markets, use the standard directionSignal based on orderbook midpoint.
  
  let finalPrediction;
  
  if (isShortCryptoMarket && qwenResult?.analysis) {
    // For short crypto markets, prioritize Qwen's estimated_fair_probability to decide direction
    // even if the final verdict is SKIP (because prices change too fast for the verdict to be reliable).
    // >50 = bullish = primary outcome (Up), <50 = bearish = secondary outcome (Down)
    const fairProb = Number(qwenResult.analysis.estimatedFairProbability);
    const primaryLabel = String(scored.score?.primaryOutcomeLabel || "UP").toUpperCase();
    const secondaryLabel = String(scored.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    
    if (Number.isFinite(fairProb)) {
      if (fairProb >= 55) finalPrediction = primaryLabel;       // Clearly bullish → Up
      else if (fairProb <= 45) finalPrediction = secondaryLabel; // Clearly bearish → Down
      else finalPrediction = "=";                                // 45-55% → too uncertain, skip
    } else {
      // Fallback to directionSignal if fair_probability unavailable
      const direction = directionSignal(scored.score);
      finalPrediction = direction.side === "NETRAL" ? "=" : direction.side;
    }
  } else if (qwenResult?.analysis?.verdict === "SKIP") {
    finalPrediction = "="; // For non-short markets, force netral/skip if Risk Manager explicitly skips
  } else {
    // Confidence Guardrail
    const confidence = Number(qwenResult?.analysis?.confidence);
    if (!Number.isNaN(confidence) && confidence < config.minQwenConfidence) {
      finalPrediction = "="; // Force netral if AI is overthinking/uncertain
      if (qwenResult?.analysis) {
        qwenResult.analysis.final_reason = `[OVERRIDE] Confidence terlalu rendah (${confidence}% < ${config.minQwenConfidence}%). Mencegah halusinasi AI. Alasan asli: ` + qwenResult.analysis.final_reason;
      }
    } else {
      const direction = directionSignal(scored.score);
      finalPrediction = direction.side === "NETRAL" ? "=" : direction.side;
    }
  }

  // Aggressive Mode: force = to UP or DOWN
  if (finalPrediction === "=" && getAggressiveMode()) {
    const primaryLabelAgg = String(scored.score?.primaryOutcomeLabel || "UP").toUpperCase();
    const secondaryLabelAgg = String(scored.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    
    const fairProbAgg = Number(qwenResult?.analysis?.estimatedFairProbability);
    if (Number.isFinite(fairProbAgg) && fairProbAgg !== 50) {
      finalPrediction = fairProbAgg > 50 ? primaryLabelAgg : secondaryLabelAgg;
    } else {
      // Fallback to data score if fairProb missing or 50
      const scoreNum = Number(scored.score?.score || 50);
      finalPrediction = scoreNum >= 50 ? primaryLabelAgg : secondaryLabelAgg;
    }
    
    if (qwenResult?.analysis) {
      qwenResult.analysis.final_reason = `[AGGRESSIVE MODE] Memaksa trade. Awalnya NETRAL, dipaksa ke ${finalPrediction}. ` + (qwenResult.analysis.final_reason || "");
    }
  }

  const fullAnalysisMarkdown = formatAnalysis({ market: scored.market, score: scored.score, qwenResult, finalPrediction });

  if (!signal?.aborted) {
    addAnalyzedEvent({
      market_id: scored.market.id,
      question: scored.market.question,
      url: scored.market.url,
      prediction: finalPrediction,
      analysis_conclusion: fullAnalysisMarkdown,
      qwen_confidence: String(qwenResult?.analysis?.confidence || ""),
      data_confidence: String(scored.score?.confidenceScore || "")
    });
  }

  return fullAnalysisMarkdown;
}

async function quickScanEvent({ result, query, setStep, limit = 8, signal = null }) {
  throwIfAborted(signal);
  setStep(`Scoring ${result.markets.length} active markets`);
  const analyzedMarkets = await scoreEventMarkets(result.markets, setStep, signal);
  if (!analyzedMarkets.length) {
    return "Event ditemukan, tapi tidak ada market aktif dengan orderbook yang bisa discan.";
  }

  appendAnalysisLog({
    query,
    eventId: result.event?.id,
    eventTitle: result.event?.title,
    marketCount: analyzedMarkets.length,
    mode: limit <= 3 ? "top3" : "quickscan",
    eventAnalysis: analyzedMarkets.map(({ market, score }) => ({
      marketId: market.id,
      question: market.question,
      score,
    })),
  });

  return formatEventQuickScan({ event: result.event, analyzedMarkets, limit });
}

async function bestCandidateAnalysis({ result, query, setStep, signal = null }) {
  throwIfAborted(signal);
  if (result.kind !== "event" || result.markets.length <= 1) {
    const single = result.markets?.[0];
    if (!single) return "Tidak ada market aktif untuk dianalisis.";
    return deepAnalyzeMarket({ market: single, query, setStep, signal });
  }

  setStep(`Scoring ${result.markets.length} active markets`);
  const analyzedMarkets = await scoreEventMarkets(result.markets, setStep, signal);
  if (!analyzedMarkets.length) {
    return "Event ditemukan, tapi tidak ada market aktif dengan orderbook yang valid.";
  }

  throwIfAborted(signal);
  setStep("Fetching crypto research context");
  const eventResearchContext = await buildResearchContext({
    event: result.event,
    markets: result.markets,
  });

  throwIfAborted(signal);
  setStep("Running Qwen event pipeline");
  const eventQwen = await askQwenEvent({
    event: result.event,
    analyzedMarkets,
    researchContext: eventResearchContext,
    signal,
  });

  const best = pickBestEventCandidate(analyzedMarkets, eventQwen);
  if (!best) return "Tidak ada kandidat market yang layak dipilih saat ini.";

  throwIfAborted(signal);
  setStep("Fetching crypto research context for best market");
  const bestResearchContext = await buildResearchContext({ market: best.market });

  throwIfAborted(signal);
  
  const isShortCryptoMarketBest = /(bitcoin|btc|ethereum|eth|doge|dogecoin).*(up|down|above|below)/i.test(best.market.question || "");
  let bestQwen;

  if (isShortCryptoMarketBest) {
    setStep("Running Qwen SHORT MARKET Sniper pipeline for best candidate");
    const asset = /ethereum|eth/i.test(best.market.question) ? "ETH" : /doge/i.test(best.market.question) ? "DOGE" : "BTC";
    const shortRes = await evaluateShortMarketCondition({
      signal,
      asset,
      marketQuestion: best.market.question,
      marketOutcomePrice: best.score.marketProbability / 100
    });
    bestQwen = {
      model: "Sniper V2",
      usage: "N/A",
      analysis: {
        verdict: shortRes.evaluation.recommendation === "PLAY" ? "VALUE CANDIDATE" : "SKIP",
        confidence: shortRes.evaluation.confidence,
        estimatedFairProbability: shortRes.evaluation.estimated_fair_probability,
        expectedValueCents: shortRes.evaluation.expected_value_cents,
        finalReason: shortRes.evaluation.reason,
        summary: shortRes.evaluation.reason ? shortRes.evaluation.reason.substring(0, 150) + "..." : "Short Market Sniper V2",
        bullishCase: ["RSI/MACD: " + (shortRes.evaluation.key_signals?.rsi_verdict || "")],
        bearishCase: ["Orderbook/Liq: " + (shortRes.evaluation.key_signals?.depth_verdict || "")]
      }
    };
  } else {
    setStep("Running Qwen final market pipeline");
    bestQwen = await askQwen({
      market: best.market,
      score: best.score,
      orderBook: best.yesBook,
      researchContext: bestResearchContext,
      signal,
    });
  }

  appendAnalysisLog({
    query,
    mode: "analyzebest",
    eventId: result.event?.id,
    eventTitle: result.event?.title,
    selectedMarketId: best.market.id,
    selectedMarketQuestion: best.market.question,
    selectedScore: best.score,
    qwenEvent: {
      model: eventQwen.model,
      usage: eventQwen.usage,
      researchContext: eventResearchContext,
      analysis: eventQwen.analysis,
    },
    qwenBest: {
      model: bestQwen.model,
      usage: bestQwen.usage,
      researchContext: bestResearchContext,
      analysis: bestQwen.analysis,
    },
  });

  let bestFinalPrediction;

  if (isShortCryptoMarketBest && bestQwen?.analysis) {
    const fairProb = Number(bestQwen.analysis.estimatedFairProbability);
    const primaryLabel = String(best.score?.primaryOutcomeLabel || "UP").toUpperCase();
    const secondaryLabel = String(best.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    
    if (Number.isFinite(fairProb)) {
      if (fairProb >= 55) bestFinalPrediction = primaryLabel;
      else if (fairProb <= 45) bestFinalPrediction = secondaryLabel;
      else bestFinalPrediction = "=";
    } else {
      const direction = directionSignal(best.score);
      bestFinalPrediction = direction.side === "NETRAL" ? "=" : direction.side;
    }
  } else if (bestQwen?.analysis?.verdict === "SKIP") {
    bestFinalPrediction = "=";
  } else {
    // Confidence Guardrail
    const confidence = Number(bestQwen?.analysis?.confidence);
    if (!Number.isNaN(confidence) && confidence < config.minQwenConfidence) {
      bestFinalPrediction = "=";
      if (bestQwen?.analysis) {
        bestQwen.analysis.final_reason = `[OVERRIDE] Confidence terlalu rendah (${confidence}% < ${config.minQwenConfidence}%). Mencegah halusinasi AI. Alasan asli: ` + bestQwen.analysis.final_reason;
      }
    } else {
      const direction = directionSignal(best.score);
      bestFinalPrediction = direction.side === "NETRAL" ? "=" : direction.side;
    }
  }

  // Aggressive Mode override for bestFinalPrediction
  if (bestFinalPrediction === "=" && getAggressiveMode()) {
    const pLabelAgg = String(best.score?.primaryOutcomeLabel || "UP").toUpperCase();
    const sLabelAgg = String(best.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    
    const fairProbAgg = Number(bestQwen?.analysis?.estimatedFairProbability);
    if (Number.isFinite(fairProbAgg) && fairProbAgg !== 50) {
      bestFinalPrediction = fairProbAgg > 50 ? pLabelAgg : sLabelAgg;
    } else {
      const scoreNum = Number(best.score?.score || 50);
      bestFinalPrediction = scoreNum >= 50 ? pLabelAgg : sLabelAgg;
    }

    if (bestQwen?.analysis) {
      bestQwen.analysis.final_reason = `[AGGRESSIVE MODE] Memaksa trade. Awalnya NETRAL, dipaksa ke ${bestFinalPrediction}. ` + (bestQwen.analysis.final_reason || "");
    }
  }

  const fullAnalysisMarkdownBest = formatAnalysis({ market: best.market, score: best.score, qwenResult: bestQwen, finalPrediction: bestFinalPrediction });

  if (!signal?.aborted) {
    addAnalyzedEvent({
      market_id: best.market.id,
      question: best.market.question,
      url: best.market.url,
      prediction: bestFinalPrediction,
      analysis_conclusion: fullAnalysisMarkdownBest,
      qwen_confidence: String(bestQwen?.analysis?.confidence || ""),
      data_confidence: String(best.score?.confidenceScore || "")
    });
  }

  return [
    "AI BEST FROM EVENT",
    `Event: ${result.event?.title || "n/a"}`,
    `Selected Market ID: ${best.market.id}`,
    eventQwen.analysis?.bestReason ? `Event reason: ${eventQwen.analysis.bestReason}` : null,
    "",
    fullAnalysisMarkdownBest
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}

async function analyzeAllEvent({ result, query, setStep, ctx, signal = null }) {
  throwIfAborted(signal);
  if (result.kind !== "event" || result.markets.length <= 1) {
    const single = result.markets?.[0];
    if (!single) return "Tidak ada market aktif untuk dianalisis.";
    return deepAnalyzeMarket({ market: single, query, setStep, signal });
  }

  setStep(`Found ${result.markets.length} active markets`);
  const analyzedMarkets = await scoreEventMarkets(result.markets, setStep, signal);
  if (!analyzedMarkets.length) {
    return "Event ditemukan, tapi tidak ada market dengan orderbook utama yang bisa dianalisis.";
  }

  const sorted = sortMarketsForAllMode(analyzedMarkets);
  for (let i = 0; i < sorted.length; i += 1) {
    throwIfAborted(signal);
    const item = sorted[i];
    await ctx.sendMessage(
      formatMarketBubble({
        market: item.market,
        score: item.score,
        index: i + 1,
        total: sorted.length,
      }),
      menuKeyboard()
    );
    // Hindari rate-limit Telegram jika market sangat banyak (kasih jeda 500ms)
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  appendAnalysisLog({
    query,
    eventId: result.event?.id,
    eventTitle: result.event?.title,
    marketCount: sorted.length,
    mode: "analyzeall",
    eventAnalysis: sorted.map(({ market, score }) => ({
      marketId: market.id,
      question: market.question,
      score,
    })),
  });

  return formatAnalyzeAllSummary({
    event: result.event,
    analyzedMarkets: sorted,
  });
}

export async function handleCommand(text, message, ctx) {
  const { command, arg } = parseCommand(text);
  const guard = enterCommandGuard({ command, arg, message, ctx });
  if (!guard.allowed) return menuAnswer(guard.message);

  try {
  if (command === "/start" || command === "/help") {
    return menuAnswer(formatHelp());
  }

  if (command === "/version") {
    return menuAnswer(`Bot version: ${SEARCH_ENGINE_VERSION}`);
  }

  if (command === "/evaluate") {
    const progressMessage = await ctx.sendMessage("Mengecek market yang baru selesai di Polymarket dan mengevaluasi jurnal...", menuKeyboard());
    const resultText = await evaluateResolutions(ctx);
    await ctx.deleteMessage(progressMessage.message_id).catch(() => {});
    return menuAnswer(resultText);
  }

  if (command === "/example") {
    return menuAnswer(
      [
        "EXAMPLE FLOW",
        "0. Lihat market lagi rame:",
        "/top",
        "/top liquidity",
        "",
        "1. Cari market:",
        "/search MicroStrategy sells any Bitcoin",
        "",
        "2. Analisis dari Market ID:",
        "/analyze 2169995",
        "",
        "3. Pilih market dari event (mode pilih):",
        "/analyze https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025",
        "",
        "4. Scan cepat event tanpa Qwen:",
        "/quickscan colombia-presidential-election",
        "",
        "5. Cari kandidat paling worth it otomatis dari event:",
        "/analyzebest colombia-presidential-election",
        "",
        "6. Atau jelaskan semua pilihan aktif (1 pilihan = 1 bubble):",
        "/analyzeall https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025",
      ].join("\n")
    );
  }

  if (command === "/search") {
    if (!arg) return menuAnswer("Pakai format: /search <keyword>\n\nContoh: /search MicroStrategy sells any Bitcoin");
    
    let query = arg;
    const parsed = parsePolymarketLink(arg);
    if (parsed && parsed.slug) {
      // If it's a link, use the slug (e.g. 'ufc-jus3-ili1-2026-06-14') as the keyword
      // Replace dashes with spaces for better search relevance
      query = parsed.slug.replace(/-/g, " ");
    }
    
    const markets = await searchMarkets(query, 5);
    return menuAnswer(formatSearchResults(markets));
  }

  if (command === "/top" || command === "/trending") {
    const result = await listTopMarkets({ mode: arg || "volume", limit: 10 });
    return menuAnswer(formatTopMarkets(result));
  }

  if (command === "/book") {
    if (!arg) return menuAnswer("Pakai format: /book <tokenId, marketId, atau link Polymarket>\n\nContoh: /book 2169995");
    let tokenId = arg;
    if (isShortMarketId(arg) || looksLikeUrl(arg)) {
      const market = await resolveMarketInput(arg);
      const tokens = pickYesNoTokens(market);
      if (!tokens.yesTokenId) {
        return menuAnswer("Market ditemukan, tapi token utama tidak tersedia.");
      }
      tokenId = tokens.yesTokenId;
    }
    const book = await getOrderBook(tokenId);
    return menuAnswer(formatBook(book));
  }

  if (command === "/quickscan" || command === "/top3") {
    if (!arg) {
      return menuAnswer(
        `Pakai format: ${command} <link event atau slug event>\n\nContoh: ${command} colombia-presidential-election`
      );
    }

    const limit = command === "/top3" ? 3 : 8;
    const output = await runWithProgress(
      ctx,
      arg,
      async (setStep) => {
        setStep("Resolving event input");
        const result = await resolveEventInput(arg);
        if (!result || !result.markets?.length) {
          return "Event tidak ditemukan atau tidak punya market aktif yang bisa discan.";
        }
        return quickScanEvent({ result, query: arg, setStep, limit, signal: ctx?.signal });
      },
      { estimateSeconds: 25, mode: "quick" }
    );

    return menuAnswer(output);
  }

  if (command === "/eventscan" || command === "/eventtop") {
    const session = getEventSession(arg);
    if (!session) {
      return menuAnswer("Event session sudah expired. Kirim ulang link event-nya ya.");
    }

    const limit = command === "/eventtop" ? 3 : 8;
    const result = eventResultFromSession(session);
    const output = await runWithProgress(
      ctx,
      session.sourceInput || session.event?.title || arg,
      (setStep) =>
        quickScanEvent({
          result,
          query: session.sourceInput || session.event?.title || arg,
          setStep,
          limit,
          signal: ctx?.signal,
        }),
      { estimateSeconds: 25, mode: "quick" }
    );

    return menuAnswer(output);
  }

  if (command === "/eventmarket") {
    const [sessionId, marketId] = arg.split(/\s+/);
    const session = getEventSession(sessionId);
    if (!session) {
      return menuAnswer("Event session sudah expired. Kirim ulang link event-nya ya.");
    }

    const market = session.markets.find((item) => String(item.id) === String(marketId));
    if (!market) return menuAnswer("Market tidak ditemukan di event session ini.");

    const output = await runWithProgress(ctx, marketId, (setStep) =>
      deepAnalyzeMarket({ market, query: marketId, setStep, signal: ctx?.signal })
    );

    return menuAnswer(output);
  }

  if (command === "/eventbest") {
    const session = getEventSession(arg);
    if (!session) {
      return menuAnswer("Event session sudah expired. Kirim ulang link event-nya ya.");
    }

    const result = eventResultFromSession(session);
    const query = session.sourceInput || session.event?.title || arg;
    const output = await runWithProgress(ctx, query, (setStep) =>
      bestCandidateAnalysis({ result, query, setStep, signal: ctx?.signal })
    );

    return menuAnswer(output);
  }

  if (command === "/eventall") {
    const session = getEventSession(arg);
    if (!session) {
      return menuAnswer("Event session sudah expired. Kirim ulang link event-nya ya.");
    }

    const result = eventResultFromSession(session);
    const query = session.sourceInput || session.event?.title || arg;
    const output = await runWithProgress(
      ctx,
      query,
      (setStep) => analyzeAllEvent({ result, query, setStep, ctx, signal: ctx?.signal }),
      { estimateSeconds: 35, mode: "quick" }
    );

    return menuAnswer(output);
  }

  if (command === "/analyzequeue") {
    if (!arg) return menuAnswer("Format: /analyzequeue <url1>,<url2>...");
    
    const urls = arg.split(",").map(s => s.trim()).filter(Boolean);
    if (!urls.length) return menuAnswer("Tidak ada URL/ID market yang dikirim.");

    return runWithProgress(
      ctx,
      `Menganalisis ${urls.length} market dari antrian`,
      async (setStep, signal) => {
        let results = [];
        for (let i = 0; i < urls.length; i++) {
          throwIfAborted(signal);
          const url = urls[i];
          setStep(`[Queue ${i + 1}/${urls.length}] Resolving market...`);
          try {
            const target = await resolveAnalyzeInput(url);
            if (target.kind === "market" && !target.market) throw new Error("Market tidak ditemukan.");
            
            setStep(`[Queue ${i + 1}/${urls.length}] Analyzing: ${target.market.question}`);
            const markdown = await deepAnalyzeMarket({ market: target.market, query: url, setStep, signal });
            
            if (markdown && ctx && typeof ctx.sendMessage === "function") {
              await ctx.sendMessage(markdown, menuKeyboard());
            }
            
            results.push(`✅ Selesai: ${target.market.question}`);
          } catch (err) {
            results.push(`❌ Gagal (${url.slice(-15)}...): ${err.message}`);
          }
        }
        return `✅ Antrian Selesai Diproses!\n\n${results.join("\\n")}`;
      },
      { estimateSeconds: urls.length * 20, mode: "deep" }
    );
  }

  if (command === "/analyze") {
    if (!arg) {
      return menuAnswer(
        "Pakai format: /analyze <keyword, marketId, atau link Polymarket>\n\nContoh: /analyze https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025"
      );
    }

    let preResolvedTarget = null;
    if (looksLikeUrl(arg)) {
      const parsed = parsePolymarketLink(arg);
      if (!parsed) {
        return menuAnswer("Link harus dari polymarket.com/event/... atau polymarket.com/market/...");
      }

      const result = await getMarketsFromPolymarketLink(arg);
      if (!result || !result.markets?.length) {
        return menuAnswer("Link Polymarket ditemukan, tapi tidak ada market aktif yang bisa dianalisis.");
      }

      if (result.kind === "event" && result.markets.length > 1) {
        const sessionId = createEventSession({
          event: result.event,
          markets: result.markets,
          sourceInput: arg,
        });

        return {
          text: formatEventHubPrompt({
            event: result.event,
            markets: result.markets,
          }),
          options: eventHubKeyboard({
            sessionId,
            markets: result.markets,
          }),
        };
      }

      preResolvedTarget = { kind: "market", market: result.markets[0], event: result.event };
    }

    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving market input");
      const target = preResolvedTarget || (await resolveAnalyzeInput(arg));
      if (target.kind === "market" && !target.market) return "Market tidak ditemukan.";

      if (target.kind === "event") {
        return bestCandidateAnalysis({ result: target, query: arg, setStep, signal: ctx?.signal });
      }

      return deepAnalyzeMarket({ market: target.market, query: arg, setStep, signal: ctx?.signal });
    });

    return menuAnswer(output);
  }

  if (command === "/analyzebest") {
    if (!arg) {
      return menuAnswer(
        "Pakai format: /analyzebest <link event atau slug event>\n\nContoh: /analyzebest colombia-presidential-election"
      );
    }

    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving event input");
      const result = await resolveEventInput(arg);
      if (!result || !result.markets?.length) {
        return "Event tidak ditemukan atau tidak punya market aktif yang bisa dianalisis.";
      }

      return bestCandidateAnalysis({ result, query: arg, setStep, signal: ctx?.signal });
    });

    return menuAnswer(output);
  }

  if (command === "/analyzeall") {
    if (!arg) {
      return menuAnswer(
        "Pakai format: /analyzeall <link event Polymarket>\n\nContoh: /analyzeall https://polymarket.com/event/colombia-presidential-election"
      );
    }

    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving event input");
      const result = await resolveEventInput(arg);
      if (!result || !result.markets?.length) {
        return "Event tidak ditemukan atau tidak punya market aktif yang bisa dianalisis.";
      }

      return analyzeAllEvent({ result, query: arg, setStep, ctx, signal: ctx?.signal });
    }, { estimateSeconds: 35, mode: "quick" });

    return menuAnswer(output);
  }

  // ── 🔔 ALERTS (/alert, /alerts, /delalert) ─────────────────────────────
  if (command === "/alerts" || (command === "/alert" && !arg)) {
    return menuAnswer(formatAlertsList());
  }

  if (command === "/alert" && arg) {
    // Format: /alert <tokenId> <above|below|change> <threshold>
    // User harus kasih tokenId dari /book dulu
    const parsed = parseAlertCommand(arg);
    if (!parsed) {
      return menuAnswer(
        "Format: /alert <tokenId> <above|below|change> <threshold>\n\n" +
        "Contoh:\n" +
        "/alert abc123 above 0.70  → notif kalau harga naik ke ≥70¢\n" +
        "/alert abc123 below 0.30  → notif kalau harga turun ke ≤30¢\n" +
        "/alert abc123 change 5    → notif kalau harga berubah ≥5%\n\n" +
        "Dapatkan tokenId dari /book <marketId>"
      );
    }

    // Coba ambil nama market dari tokenId
    let question = `Token ${parsed.tokenId.slice(0, 12)}...`;
    try {
      const book = await getOrderBook(parsed.tokenId);
      if (book?.market) question = book.market.slice(0, 80);
    } catch { /* ignore */ }

    const id = addAlert({
      tokenId: parsed.tokenId,
      marketId: parsed.tokenId, // tokenId sama dengan marketId di sini
      question,
      condition: parsed.condition,
      threshold: parsed.threshold,
    });

    const condLabel = { price_above: "naik ke ≥", price_below: "turun ke ≤", price_change_pct: "berubah ≥" };
    const thresholdFmt = parsed.condition === "price_change_pct"
      ? `${parsed.threshold}%`
      : `${(parsed.threshold * 100).toFixed(1)}¢`;

    return menuAnswer(
      `✅ Alert dibuat! ID: *${id}*\n📊 ${question}\nKondisi: harga ${condLabel[parsed.condition]}${thresholdFmt}\n\nGunakan /delalert ${id} untuk menghapus.`
    );
  }

  if (command === "/delalert") {
    const id = parseInt(arg);
    if (!id) return menuAnswer("Format: /delalert <id>\nDapatkan ID dari /alerts");
    const ok = deleteAlert(id);
    return menuAnswer(ok ? `✅ Alert ${id} dihapus.` : `❌ Alert ${id} tidak ditemukan.`);
  }

  // ✨🐋 WHALE TRACKING (/whales, /whale, /toptraders, /add, /del) ✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨✨
  if (command === "/add") {
    if (!arg) return menuAnswer("Format: /add <alamat_wallet> [nickname]\nContoh: /add 0x123... WhaleSatu");
    const parts = arg.trim().split(/\s+/);
    const address = parts[0];
    const nickname = parts.slice(1).join(" ");
    const cfg = getTrackerConfig();
    const wallets = cfg.wallets;
    if (!wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
      wallets.push({ address, nickname });
      setTrackerConfig(cfg.minUsd, wallets);
      return menuAnswer(`✅ Wallet ${address} (${nickname || "Tanpa Nama"}) berhasil ditambahkan ke Tracker.`);
    } else {
      return menuAnswer(`⚠️ Wallet ${address} sudah ada di Tracker.`);
    }
  }

  if (command === "/del") {
    if (!arg) return menuAnswer("Format: /del <alamat_wallet>\nContoh: /del 0x123...");
    const address = arg.trim().toLowerCase();
    const cfg = getTrackerConfig();
    const originalLength = cfg.wallets.length;
    const wallets = cfg.wallets.filter(w => w.address.toLowerCase() !== address);
    if (wallets.length < originalLength) {
      setTrackerConfig(cfg.minUsd, wallets);
      return menuAnswer(`✅ Wallet ${address} berhasil dihapus dari Tracker.`);
    } else {
      return menuAnswer(`⚠️ Wallet ${address} tidak ditemukan di Tracker.`);
    }
  }

  if (command === "/sniffer") {
    if (arg === "on") {
      setSnifferState(true);
      return "✅ *LIVE WHALE SNIFFER DIAKTIFKAN*\nBot sekarang memantau Polymarket 24/7 dan akan mengirim notifikasi jika ada transaksi ≥ $500.";
    } else if (arg === "off") {
      setSnifferState(false);
      return "⏸️ *LIVE WHALE SNIFFER DIMATIKAN*\nPemantauan dihentikan.";
    } else {
      const state = getSnifferState() ? "ON ✅" : "OFF ⏸️";
      return `📡 *Status Sniffer saat ini: ${state}*\nGunakan \`/sniffer on\` atau \`/sniffer off\` untuk mengatur.`;
    }
  }

  if (command === "/shortcondition" || command === "/shortvibe") {
    return runWithProgress(ctx, "Checking short market condition...", async (setStep) => {
      setStep("Fetching live BTC data & Twitter sentiment");
      const result = await evaluateShortMarketCondition({ signal: ctx?.signal, currentPriceStr: arg });
      return formatShortCondition(result);
    }, { estimateSeconds: 15, mode: "quick" }).then(output => menuAnswer(output));
  }

  if (command === "/whales" || command === "/whale") {
    const minSize = parseInt(arg) || 500;
    return runWithProgress(ctx, `Whale scan (min $${minSize})`, async (setStep) => {
      setStep("Membuka memori Live Sniffer...");
      const whales = getRecentWhales(minSize);
      return formatSnifferWhales(whales, minSize);
    }, { estimateSeconds: 2, mode: "quick" }).then(output => menuAnswer(output));
  }

  if (command === "/toptraders") {
    const limit = parseInt(arg) || 10;
    const traders = await fetchTopTraders({ limit });
    return menuAnswer(formatTopTraders(traders));
  }

  // ── ⚖️ ARBITRAGE (/arb, /opps, /internalabs) ────────────────────────────
  if (command === "/arb" || command === "/opportunities" || command === "/opps") {
    return runWithProgress(ctx, "Scanning arbitrage opportunities", async (setStep) => {
      setStep("Fetching top markets");
      const { markets } = await listTopMarkets({ mode: "volume", limit: 30 });
      setStep(`Scanning ${markets.length} markets for opportunities`);
      // Require at least 0.5% internal gap and 2% cross-platform spread for good RR
      const results = await scanAllOpportunities(markets, { minGap: 0.005, minSpreadPct: 2 });
      return formatOpportunityScan(results);
    }, { estimateSeconds: 30, mode: "quick" }).then(output => menuAnswer(output));
  }

  if (command === "/internalarb") {
    return runWithProgress(ctx, "Scanning internal arbitrage", async (setStep) => {
      setStep("Fetching top markets");
      const { markets } = await listTopMarkets({ mode: "volume", limit: 50 });
      setStep(`Checking YES+NO prices on ${markets.length} markets`);
      // Require at least 0.5% internal gap for good RR
      const opps = await detectInternalArbitrage(markets, { minGap: 0.005 });
      return formatOpportunityScan({ internal: opps, crossPlatform: [], total: opps.length, scannedAt: new Date().toISOString() });
    }, { estimateSeconds: 35, mode: "quick" }).then(output => menuAnswer(output));
  }

  // ── 📊 ANALYTICS (/analytics, /stats, /timing, /bycat) ──────────────────
  if (command === "/analytics" || command === "/stats") {
    const days = parseInt(arg) || 30;
    const trades = getShadowTrades({ days });
    const metrics = calculatePerformanceMetrics(trades);
    return menuAnswer(formatAnalyticsSummary(metrics, `${days} hari terakhir`));
  }

  if (command === "/timing" || command === "/besttimes") {
    const trades = getShadowTrades({ days: 90 });
    const timing = getTimingAnalysis(trades);
    return menuAnswer(formatTimingAnalysis(timing));
  }

  if (command === "/bycat" || command === "/performance") {
    const trades = getShadowTrades({ days: 90 });
    const byCategory = getPerformanceByCategory(trades);
    if (!Object.keys(byCategory).length) {
      return menuAnswer("📭 Belum ada data resolved untuk analisis kategori.");
    }
    let text = "📊 *Performance by Category*\n\n";
    const sorted = Object.entries(byCategory).sort((a, b) => b[1].total - a[1].total);
    for (const [cat, data] of sorted) {
      text += `*${cat}*: WR ${data.winRate}% (${data.wins}W/${data.total - data.wins}L, ${data.total} total)\n`;
      if (data.sub && Object.keys(data.sub).length > 0) {
        const sortedSub = Object.entries(data.sub).sort((a, b) => b[1].total - a[1].total);
        for (const [subName, subData] of sortedSub) {
          const subWr = subData.total > 0 ? (subData.wins / subData.total * 100).toFixed(1) : "0.0";
          text += `  • ${subName}: WR ${subWr}% (${subData.wins}W/${subData.total - subData.wins}L, ${subData.total} total)\n`;
        }
      }
    }
    return menuAnswer(text);
  }

  // ── 📈 BACKTEST (/backtest) ───────────────────────────────────────────────
  if (command === "/backtest") {
    let strategy = "flat";
    let initialCapital = 1000;
    
    const argParts = (arg || "").trim().split(/\s+/);
    for (const a of argParts) {
      const lowerA = a.toLowerCase();
      if (["kelly", "flat", "conservative"].includes(lowerA)) {
        strategy = lowerA;
      } else if (!isNaN(parseFloat(a))) {
        initialCapital = parseFloat(a);
      }
    }

    const trades = getShadowTrades({ days: 180 });
    const result = runBacktest({ trades, strategy, initialCapital });
    return menuAnswer(formatBacktestResult(result));
  }

  // ── 📐 KELLY (/kelly) ────────────────────────────────────────────────────
  if (command === "/kelly") {
    // Format: /kelly <edge 0-1> <confidence 0-100> [bankroll]
    const parts = (arg || "").trim().split(/\s+/);
    const edge = parseFloat(parts[0]);
    const confidence = parseFloat(parts[1]) || 70;
    const bankroll = parseFloat(parts[2]) || 1000;

    if (!isFinite(edge) || edge < 0 || edge > 1) {
      return menuAnswer(
        "Format: /kelly <edge> <confidence> [bankroll]\n\n" +
        "Contoh: /kelly 0.10 75 1000\n" +
        "  edge: selisih fair value vs market price (0-1)\n" +
        "  confidence: dari scoring (0-100)\n" +
        "  bankroll: modal simulasi (default 1000)"
      );
    }

    const recentTrades = getShadowTrades({ days: 60 });
    const result = calculateKelly({ edge, confidence, bankroll, recentTrades });
    return menuAnswer(formatKellyResult(result));
  }

  return menuAnswer(formatHelp());
  } finally {
    releaseCommandGuard(guard);
  }
}

let activeBot = null;

export function startTelegramBot() {
  assertConfig();
  activeBot = new TelegramBot(config.telegramToken, (text, msg, ctx) => {
    // Tangkap adminChatId secara otomatis saat interaksi pertama
    if (ctx && ctx.chatId) {
      adminChatId = ctx.chatId;
    }
    return handleCommand(text, msg, ctx);
  });

  // Daftarkan callback notifikasi untuk Sniffer
  setNotificationCallback(async (payload) => {
    if (typeof payload === "string") {
      const textMsg = payload;
      console.log("\n[Whale Alert]\n" + textMsg.replace(/\*/g, ""));
      if (adminChatId && activeBot) {
        await activeBot.sendMessage(adminChatId, textMsg, { parse_mode: "Markdown" }).catch(() => {});
      }
    } else if (payload && payload.type === "HOT_NICHE") {
      const { marketInfo, recentTradesCount, triggerWhale } = payload;
      console.log(`\n[Hot Niche Alert] Market: ${marketInfo.question}`);
      
      try {
        const tweets = await scrapeTwitter(marketInfo.question);
        const volumeSpike = `${recentTradesCount} whale trades dalam 15 menit. Trigger: ${triggerWhale.side} $${triggerWhale.sizeUsdc.toFixed(0)}`;
        
        const qwenAnalysis = await askQwenHotNiche({ market: marketInfo, volumeSpike, tweets });
        
        let textMsg = `🔥 *HOT NICHE DETECTED* 🔥\n\n`;
        textMsg += `📊 *Market:* [${marketInfo.question}](https://polymarket.com/event/${marketInfo.slug})\n`;
        textMsg += `📈 *Volume Spike:* ${volumeSpike}\n\n`;
        textMsg += `🐦 *X (Twitter) Sentiment:*\n`;
        textMsg += `Sentimen: *${qwenAnalysis.sentiment}*\n`;
        textMsg += `_Ringkasan:_ ${qwenAnalysis.summary}\n`;
        
        if (adminChatId && activeBot) {
          await activeBot.sendMessage(adminChatId, textMsg, { parse_mode: "Markdown", disable_web_page_preview: true }).catch(() => {});
        }
        
        // Broadcast ke SSE web UI
        broadcastAlert({
          type: "HOT_NICHE_UPDATE",
          marketInfo,
          volumeSpike,
          sentiment: qwenAnalysis.sentiment,
          summary: qwenAnalysis.summary
        });
      } catch (err) {
         console.error("[Hot Niche Error]", err);
      }
    }
  });

  // Start alert monitor — kirim alert price ke semua chat yang punya alert aktif
  // (simplified: kirim ke semua chat via broadcast, atau simpan chatId per alert)
  // Untuk sekarang: bot hanya bisa broadcast ke satu chatId yang pertama kirim command
  // Future: extend storage untuk per-user alert
  const stopAlerts = startAlertMonitor(async (msg) => {
    if (adminChatId && activeBot) {
      await activeBot.sendMessage(adminChatId, msg).catch(() => {});
    }
    console.log("[Alert]", msg.replace(/\*/g, ""));
  });

  // Cleanup on stop
  const originalStop = activeBot.stop.bind(activeBot);
  activeBot.stop = () => {
    stopAlerts();
    originalStop();
  };

  activeBot.start();
  return activeBot;
}

export function stopTelegramBot() {
  if (activeBot) {
    activeBot.stop();
    activeBot = null;
  }
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  startTelegramBot();
}
