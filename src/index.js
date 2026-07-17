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
import { broadcastAlert } from "./web.js";
import { buildResearchContext } from "./research.js";
import { enterCommandGuard, releaseCommandGuard } from "./rate-limit.js";
import { scoreMarket } from "./scoring.js";
import { getRecentWhales, formatSnifferWhales, setSnifferState, getSnifferState, setNotificationCallback, getTrackerConfig, setTrackerConfig } from "./sniffer.js";
import { appendAnalysisLog, addAnalyzedEvent } from "./storage.js";

// Helper untuk UI
export async function getWhalesData(minSize = 500) {
  const whales = getRecentWhales(minSize);
  return formatSnifferWhales(whales, minSize);
}

// ── Admin Chat ID untuk Push Notification (Sniffer) ───────────────────────
let adminChatId = null;

// ── CloddsBot-ported modules ──────────────────────────────────────────────
import {
  getShadowTrades, calculateKelly, formatKellyResult
} from "./analytics.js";
import { evaluateResolutions } from "./evaluate.js";
import { evaluateShortMarketCondition } from "./short_condition.js";

const MENU_BUTTONS = {
  SEARCH: "Search Market",
  ANALYZE: "Analyze Link / ID",
  EVALUATE: "Evaluate PnL",
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
        [{ text: MENU_BUTTONS.SEARCH }, { text: MENU_BUTTONS.ANALYZE }],
        [{ text: MENU_BUTTONS.SHORT_COND }, { text: MENU_BUTTONS.BOOK }],
        [{ text: MENU_BUTTONS.EVALUATE }, { text: MENU_BUTTONS.HELP }],
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

async function deepAnalyzeMarket({ market, query, setStep, ctx, signal = null }) {
  throwIfAborted(signal);
  setStep("Fetching CLOB orderbook");
  const scored = await scoreOneMarket(market);

  throwIfAborted(signal);
  const isShortCryptoMarket = /(bitcoin|btc|ethereum|eth|doge|dogecoin).*(up|down|above|below|reach|higher|lower|\$[0-9])/i.test(scored.market.question || "");
  let qwenResult;
  let researchContext = "";

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
      usage: shortRes.usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
      analysis: {
        verdict: shortRes.evaluation.recommendation === "PLAY" ? "VALUE CANDIDATE" : "SKIP",
        confidence: shortRes.evaluation.confidence,
        estimatedFairProbability: shortRes.evaluation.estimated_fair_probability,
        expectedValueCents: shortRes.evaluation.expected_value_cents,
        targetPrice: shortRes.targetPrice,
        pythPrice: shortRes.pythPrice,
        scoutDirection: shortRes.evaluation.direction,
        scoutRecommendation: shortRes.evaluation.recommendation,
        finalReason: shortRes.evaluation.reason,
        summary: shortRes.evaluation.reason ? shortRes.evaluation.reason.substring(0, 150) + "..." : "Short Market Sniper V2",
        bullishCase: ["Flow Momentum: " + (shortRes.evaluation.key_signals?.flow_verdict || "")],
        bearishCase: ["Orderbook/Liq: " + (shortRes.evaluation.key_signals?.depth_verdict || "")]
      }
    };
  } else {
    setStep("Fetching crypto research context");
    researchContext = await buildResearchContext({ market: scored.market });
    throwIfAborted(signal);
    
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

  let finalPrediction;
  
  if (isShortCryptoMarket && qwenResult?.analysis) {
    const scoutDirection = String(qwenResult.analysis.scoutDirection || "").toUpperCase();
    const scoutRec = String(qwenResult.analysis.scoutRecommendation || "").toUpperCase();
    
    if (scoutRec === "AVOID" || scoutDirection === "NEUTRAL") {
      finalPrediction = "=";
    } else if (scoutDirection === "UP" || scoutDirection === "YES") {
      finalPrediction = String(scored.score?.primaryOutcomeLabel || "UP").toUpperCase();
    } else if (scoutDirection === "DOWN" || scoutDirection === "NO") {
      finalPrediction = String(scored.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    } else {
      finalPrediction = "=";
    }
  } else if (qwenResult?.analysis?.verdict === "SKIP") {
    finalPrediction = "=";
  } else {
    const confidence = Number(qwenResult?.analysis?.confidence);
    if (!Number.isNaN(confidence) && confidence < config.minQwenConfidence) {
      finalPrediction = "=";
      if (qwenResult?.analysis) {
        qwenResult.analysis.final_reason = `[OVERRIDE] Confidence terlalu rendah (${confidence}% < ${config.minQwenConfidence}%). Mencegah halusinasi AI. Alasan asli: ` + qwenResult.analysis.final_reason;
      }
    } else {
      const direction = directionSignal(scored.score);
      finalPrediction = direction.side === "NETRAL" ? "=" : direction.side;
    }
  }

  const executionTime = ctx?.commandStartTime ? Math.round((Date.now() - ctx.commandStartTime) / 1000) : null;
  const fullAnalysisMarkdown = formatAnalysis({ market: scored.market, score: scored.score, qwenResult, finalPrediction, analysisTime: executionTime });

  if (!signal?.aborted) {
    addAnalyzedEvent({
      market_id: scored.market.id,
      question: scored.market.question,
      url: scored.market.url,
      prediction: finalPrediction,
      analysis_conclusion: fullAnalysisMarkdown,
      qwen_confidence: String(qwenResult?.analysis?.confidence || ""),
      data_confidence: String(scored.score?.confidenceScore || ""),
      execution_time: executionTime
    });
  }

  return fullAnalysisMarkdown;
}

async function quickScanEvent({ result, query, setStep, ctx, limit = 8, signal = null }) {
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

async function bestCandidateAnalysis({ result, query, setStep, ctx, signal = null }) {
  throwIfAborted(signal);
  if (result.kind !== "event" || result.markets.length <= 1) {
    const single = result.markets?.[0];
    if (!single) return "Tidak ada market aktif untuk dianalisis.";
    return deepAnalyzeMarket({ market: single, query, setStep, ctx, signal });
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
  
  const isShortCryptoMarketBest = /(bitcoin|btc|ethereum|eth|doge|dogecoin).*(up|down|above|below|reach|higher|lower|\$[0-9])/i.test(best.market.question || "");
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
      usage: shortRes.usage || { total_tokens: 0, prompt_tokens: 0, completion_tokens: 0 },
      analysis: {
        verdict: shortRes.evaluation.recommendation === "PLAY" ? "VALUE CANDIDATE" : "SKIP",
        confidence: shortRes.evaluation.confidence,
        estimatedFairProbability: shortRes.evaluation.estimated_fair_probability,
        expectedValueCents: shortRes.evaluation.expected_value_cents,
        targetPrice: shortRes.targetPrice,
        pythPrice: shortRes.pythPrice,
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

  const executionTime = ctx?.commandStartTime ? Math.round((Date.now() - ctx.commandStartTime) / 1000) : null;
  const fullAnalysisMarkdownBest = formatAnalysis({ market: best.market, score: best.score, qwenResult: bestQwen, finalPrediction: bestFinalPrediction, analysisTime: executionTime });

  if (!signal?.aborted) {
    addAnalyzedEvent({
      market_id: best.market.id,
      question: best.market.question,
      url: best.market.url,
      prediction: bestFinalPrediction,
      analysis_conclusion: fullAnalysisMarkdownBest,
      qwen_confidence: String(bestQwen?.analysis?.confidence || ""),
      data_confidence: String(best.score?.confidenceScore || ""),
      execution_time: executionTime
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
    return deepAnalyzeMarket({ market: single, query, setStep, ctx, signal });
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
  if (ctx) ctx.commandStartTime = Date.now();
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
        "1. Cari market:",
        "/search BTC",
        "",
        "2. Analisis dari Market ID:",
        "/analyze 2169995",
        "",
        "3. Pilih market dari event (mode pilih):",
        "/analyze https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025",
        "",
        "4. Cari kandidat paling worth it otomatis dari event:",
        "/analyzebest colombia-presidential-election"
      ].join("\n")
    );
  }

  if (command === "/search") {
    if (!arg) return menuAnswer("Pakai format: /search <keyword>\n\nContoh: /search BTC");
    
    let query = arg;
    const parsed = parsePolymarketLink(arg);
    if (parsed && parsed.slug) {
      query = parsed.slug.replace(/-/g, " ");
    }
    
    const markets = await searchMarkets(query, 5);
    return menuAnswer(formatSearchResults(markets));
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
            const markdown = await deepAnalyzeMarket({ market: target.market, query: url, setStep, ctx, signal });
            
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
        return bestCandidateAnalysis({ result: target, query: arg, setStep, ctx, signal: ctx?.signal });
      }

      return deepAnalyzeMarket({ market: target.market, query: arg, setStep, ctx, signal: ctx?.signal });
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

      return bestCandidateAnalysis({ result, query: arg, setStep, ctx, signal: ctx?.signal });
    });

    return menuAnswer(output);
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

// ── Background Monitors ──────────────────────────────────────────────
setNotificationCallback(async (payload) => {
  if (typeof payload === "string") {
    console.log("\n[Whale Alert]\n" + payload.replace(/\*/g, ""));
  } else if (payload && payload.type === "HOT_NICHE") {
    const { marketInfo, recentTradesCount, triggerWhale } = payload;
    console.log(`\n[Hot Niche Alert] Market: ${marketInfo.question}`);
    
    try {
      const volumeSpike = `${recentTradesCount} whale trades dalam 15 menit. Trigger: ${triggerWhale.side} $${triggerWhale.sizeUsdc.toFixed(0)}`;
      
      const qwenAnalysis = await askQwenHotNiche({ market: marketInfo, volumeSpike });
      
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
