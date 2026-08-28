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
  pickShortUpDownTokens,
  SEARCH_ENGINE_VERSION,
  searchMarkets,
} from "./polymarket.js";
import { askQwen, askQwenEvent } from "./qwen.js";
import { buildResearchContext } from "./research.js";
import { enterCommandGuard, releaseCommandGuard } from "./rate-limit.js";
import { assertMarketAllowed } from "./market-policy.js";
import { scoreMarket } from "./scoring.js";
import { getRecentWhales, formatSnifferWhales, setSnifferState, getSnifferState, getSnifferWsStatus, setNotificationCallback, getTrackerConfig, setTrackerConfig } from "./sniffer.js";
import { appendAnalysisLog, addAnalyzedEvent, getRecentResolvedOutcomes } from "./storage.js";

// Helper untuk UI
export async function getWhalesData(minSize = 500) {
  const whales = getRecentWhales(minSize);
  return formatSnifferWhales(whales, minSize);
}

// ── Admin Chat ID untuk Push Notification (Sniffer) ───────────────────────
let adminChatId = null;

// ── CloddsBot-ported modules ──────────────────────────────────────────────
import {
  calculateKelly, formatKellyResult
} from "./analytics.js";
import { resolvePendingEvents } from "./resolution.js";
import { evaluateShortMarketCondition } from "./short_condition.js";

const MENU_BUTTONS = {
  SEARCH: "Search Market",
  ANALYZE: "Analyze Link / ID",
  RESOLVE: "Check Outcomes",
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
        [{ text: MENU_BUTTONS.RESOLVE }, { text: MENU_BUTTONS.HELP }],
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

function menuAnswer(text, result = null) {
  return { text, options: menuKeyboard(), result };
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
  if (trimmed === MENU_BUTTONS.RESOLVE) return "/resolve";
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

function predictionFromValidatedAnalysis(analysis, score) {
  if (!analysis || analysis.verdict !== "VALUE CANDIDATE") return "=";
  const hardBlockers = (score?.blockers || []).filter((blocker) => blocker !== "No measured positive edge");
  if (hardBlockers.length) return "=";
  const confidence = Number(analysis.confidence);
  const fairProbability = Number(analysis.estimatedFairProbability);
  const marketProbability = Number(score?.marketProbability);
  if (!Number.isFinite(confidence) || confidence < config.minQwenConfidence) return "=";
  if (!Number.isFinite(fairProbability) || !Number.isFinite(marketProbability)) return "=";
  if (fairProbability - marketProbability < 5) return "=";
  return String(score?.primaryOutcomeLabel || "YES").toUpperCase();
}

function shortCryptoAsset(question) {
  const text = String(question || "");
  if (/\b(?:ethereum|eth)\b/i.test(text)) return "ETH";
  if (/\b(?:dogecoin|doge)\b/i.test(text)) return "DOGE";
  if (/\b(?:bitcoin|btc)\b/i.test(text)) return "BTC";
  return null;
}

function isShortCryptoMarket(market) {
  return Boolean(shortCryptoAsset(market?.question) && /\bup or down\b/i.test(String(market?.question || "")));
}

export function requireShortAnalysisMarket(target) {
  if (target?.kind !== "market" || !target.market) {
    throw new Error("Manual analysis requires a single short market, not a multi-market event.");
  }
  if (!isShortCryptoMarket(target.market)) {
    throw new Error("Market bukan fixed-window crypto Up or Down market.");
  }
  const durationType = target.market.durationType || target.market.duration_type;
  if (!["5m", "15m", "1h", "4h", "1d"].includes(durationType)) {
    throw new Error("Short market tidak memiliki duration metadata yang didukung.");
  }
  return target.market;
}

export function calculateExecutableOrderBook(book, targetNotional = config.entryTargetNotional) {
  const normalizedTarget = Number(targetNotional);
  const parseLevels = (levels, direction) => {
    if (!Array.isArray(levels) || levels.length === 0) {
      return { levels: [], error: `${direction.toUpperCase()}_BOOK_EMPTY` };
    }
    const parsed = levels.map((level) => {
      const price = Number(level?.price);
      const size = Number(level?.size);
      if (!Number.isFinite(price) || price <= 0 || price > 1 || !Number.isFinite(size) || size <= 0) return null;
      return { price, size };
    });
    if (parsed.some((level) => level == null)) {
      return { levels: [], error: `${direction.toUpperCase()}_BOOK_LEVEL_INVALID` };
    }
    return { levels: parsed, error: null };
  };

  const bidsResult = parseLevels(book?.bids, "bid");
  const asksResult = parseLevels(book?.asks, "ask");
  const bids = bidsResult.levels.sort((a, b) => b.price - a.price);
  const asks = asksResult.levels.sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const base = {
    valid: false,
    reason: bidsResult.error || asksResult.error || null,
    bestBid,
    bestAsk,
    midpoint: null,
    spread: null,
    spreadBps: null,
    targetNotional: Number.isFinite(normalizedTarget) && normalizedTarget > 0 ? normalizedTarget : null,
    availableAskDepth: asks.reduce((total, level) => total + level.size, 0),
    availableAskNotional: asks.reduce((total, level) => total + level.price * level.size, 0),
    filledAskDepth: 0,
    filledAskNotional: 0,
    vwapAsk: null,
    slippageFromBestAsk: null,
    slippageBps: null,
    assetId: book?.asset_id ?? null,
    bookTimestamp: book?.timestamp ?? null,
    bookTimestampMs: parseBookTimestampMs(book?.timestamp),
  };
  if (base.reason) return base;
  if (bestBid == null || bestAsk == null) {
    base.reason = "ONE_SIDED_BOOK";
    return base;
  }
  if (bestBid >= bestAsk) {
    base.reason = "CROSSED_BOOK";
    return base;
  }
  if (base.targetNotional == null) {
    base.reason = "TARGET_NOTIONAL_INVALID";
    return base;
  }

  base.midpoint = (bestBid + bestAsk) / 2;
  base.spread = bestAsk - bestBid;
  base.spreadBps = (base.spread / bestAsk) * 10_000;
  let remainingNotional = base.targetNotional;
  for (const level of asks) {
    if (remainingNotional <= 0) break;
    const quantity = Math.min(level.size, remainingNotional / level.price);
    base.filledAskDepth += quantity;
    base.filledAskNotional += quantity * level.price;
    remainingNotional -= quantity * level.price;
  }
  if (remainingNotional > 1e-9 || base.filledAskDepth <= 0) {
    base.reason = "INSUFFICIENT_ASK_DEPTH";
    return base;
  }
  base.vwapAsk = base.filledAskNotional / base.filledAskDepth;
  base.slippageFromBestAsk = base.vwapAsk - bestAsk;
  base.slippageBps = (base.slippageFromBestAsk / bestAsk) * 10_000;
  base.valid = [base.midpoint, base.spread, base.spreadBps, base.vwapAsk, base.slippageFromBestAsk, base.slippageBps]
    .every((value) => Number.isFinite(value));
  if (!base.valid) base.reason = "EXECUTION_METRICS_INVALID";
  return base;
}

function parseBookTimestampMs(value) {
  // Match strict observer handling: CLOB timestamps are integer milliseconds;
  // do not guess seconds, ISO strings, or other undocumented units here.
  const numeric = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(numeric) && numeric >= 1_000_000_000_000 ? numeric : null;
}

// Final CLOB age budget matches the active Chainlink snapshot timing budget.
const FINAL_CLOB_MAX_AGE_MS = 15_000;
const FINAL_CLOB_MAX_FUTURE_SKEW_MS = 2_000;

function executableOrderBookPricing(book) {
  return calculateExecutableOrderBook(book);
}

async function refreshShortExecutionSnapshot(marketId, score, signal = null) {
  const freshMarket = await getMarketById(marketId, true, signal).catch((error) => {
    if (signal?.aborted || error?.code === "UNSUPPORTED_UFC" || error?.code === "TOKEN_MAPPING_INVALID") throw error;
    return null;
  });
  const freshTokens = freshMarket ? pickShortUpDownTokens(freshMarket) : null;
  const primaryTokenId = freshTokens?.yesTokenId || score.primaryTokenId;
  const secondaryTokenId = freshTokens?.noTokenId || score.secondaryTokenId;
  const requiredBook = async (tokenId, side) => {
    if (!tokenId) {
      throw Object.assign(new Error(`Final ${side} CLOB token is unavailable.`), { code: "FINAL_CLOB_REFRESH_FAILED" });
    }
    let book;
    try {
      book = await getOrderBook(tokenId, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Object.assign(new Error(`Final ${side} CLOB book is unavailable.`), { code: "FINAL_CLOB_REFRESH_FAILED" });
    }
    if (book?.asset_id !== tokenId) {
      throw Object.assign(new Error(`Final ${side} CLOB book asset_id does not match requested token.`), { code: "FINAL_CLOB_REFRESH_FAILED" });
    }
    const prices = calculateExecutableOrderBook(book);
    if (!prices.valid) {
      throw Object.assign(new Error(`Final ${side} CLOB book is not executable: ${prices.reason || "invalid execution metrics"}.`), { code: "FINAL_CLOB_REFRESH_FAILED" });
    }
    if (prices.bookTimestampMs == null) {
      throw Object.assign(new Error(`Final ${side} CLOB book timestamp is missing or invalid.`), { code: "FINAL_CLOB_REFRESH_FAILED" });
    }
    const ageMs = Date.now() - prices.bookTimestampMs;
    if (ageMs > FINAL_CLOB_MAX_AGE_MS || ageMs < -FINAL_CLOB_MAX_FUTURE_SKEW_MS) {
      throw Object.assign(new Error(`Final ${side} CLOB book timestamp is stale or skewed.`), { code: "FINAL_CLOB_REFRESH_FAILED" });
    }
    return prices;
  };
  const [up, down] = await Promise.all([
    requiredBook(primaryTokenId, "UP"),
    requiredBook(secondaryTokenId, "DOWN"),
  ]);
  return {
    upAsk: up.vwapAsk,
    downAsk: down.vwapAsk,
    upMidpoint: up.midpoint,
    downMidpoint: down.midpoint,
    upBestAsk: up.bestAsk,
    downBestAsk: down.bestAsk,
    execution: { UP: up, DOWN: down },
    marketActive: freshMarket?.active === true,
    marketClosed: freshMarket?.closed !== false,
    acceptingOrders: freshMarket?.acceptingOrders === true,
  };
}

export function entryPricingForPrediction(analysis, prediction) {
  if (!analysis || prediction === "=") return { fairProbability: null, maxEntryPrice: null };
  const fairProbability = Number(analysis.estimatedFairProbability);
  if (!Number.isFinite(fairProbability) || fairProbability <= 5 || fairProbability > 100) {
    return { fairProbability: null, maxEntryPrice: null };
  }
  return {
    fairProbability,
    maxEntryPrice: Number(Math.min(
      config.entryMaxPrice,
      (fairProbability - 5 - config.entryFeeBufferCents) / 100
    ).toFixed(4)),
  };
}

async function resolveMarketInput(arg, signal = null) {
  if (isShortMarketId(arg)) return getMarketById(arg, false, signal);

  if (looksLikeUrl(arg)) {
    const parsed = parsePolymarketLink(arg);
    if (!parsed) {
      throw new Error("Link harus dari polymarket.com/event/... atau polymarket.com/market/...");
    }

    const market = await getMarketFromPolymarketLink(arg, signal);
    if (!market) {
      throw new Error("Link Polymarket ditemukan, tapi tidak ada market aktif yang bisa dianalisis.");
    }

    return market;
  }

  return (await searchMarkets(arg, 1, signal))[0];
}

async function resolveAnalyzeInput(arg, signal = null) {
  if (isShortMarketId(arg)) {
    return { kind: "market", market: await getMarketById(arg, false, signal), event: null };
  }

  if (looksLikeUrl(arg)) {
    const parsed = parsePolymarketLink(arg);
    if (!parsed) {
      throw new Error("Link harus dari polymarket.com/event/... atau polymarket.com/market/...");
    }

    const result = await getMarketsFromPolymarketLink(arg, signal);
    if (!result || !result.markets?.length) {
      throw new Error("Link Polymarket ditemukan, tapi tidak ada market aktif yang bisa dianalisis.");
    }

    if (result.kind === "event" && result.markets.length > 1) {
      return { kind: "event", event: result.event, markets: result.markets };
    }

    return { kind: "market", market: result.markets[0], event: result.event };
  }

  const market = (await searchMarkets(arg, 1, signal))[0];
  return { kind: "market", market, event: null };
}

export async function scoreOneMarket(market, signal = null) {
  assertMarketAllowed(market);
  const shortMarket = isShortCryptoMarket(market);
  const tokens = shortMarket ? pickShortUpDownTokens(market) : pickYesNoTokens(market);
  if (!tokens.yesTokenId) {
    throw new Error(`Market ${market.id} tidak punya token utama.`);
  }

  let yesBook;
  let noBook = null;
  if (shortMarket) {
    [yesBook, noBook] = await Promise.all([
      getOrderBook(tokens.yesTokenId, signal).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      }),
      tokens.noTokenId ? getOrderBook(tokens.noTokenId, signal).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      }) : Promise.resolve(null),
    ]);
  } else {
    yesBook = await getOrderBook(tokens.yesTokenId, signal);
  }
  const scoreMarketInput = shortMarket
    ? { ...market, outcomePrices: [tokens.yesPrice, tokens.noPrice] }
    : market;
  const baseScore = scoreMarket({ market: scoreMarketInput, yesBook });
  const clobMidpoint =
    baseScore.marketProbability == null ? null : baseScore.marketProbability / 100;
  const gammaPrice = Number(tokens.yesPrice);
  const dataWarnings = [];
  const shortBookPrices = shortMarket
    ? {
        up: executableOrderBookPricing(yesBook),
        down: executableOrderBookPricing(noBook),
      }
    : null;

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
    shortBookPrices,
    dataWarnings,
  };
  return { market, yesBook, noBook, score };
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
          return await scoreOneMarket(market, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
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

async function resolveAnalyzeAllEventInput(arg, signal = null) {
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

  return getMarketsFromPolymarketLink(raw, signal);
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
    }, ctx?.signal);

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

export function qwenResultFromShortEvaluation(shortRes) {
  const evaluation = shortRes.evaluation;
  const aiExplanationStatus = shortRes.aiExplanationStatus || evaluation.ai_explanation_status || "unknown";
  const aiModel = shortRes.providerModel || config.qwenShortModel;
  return {
    model: `Terminal Chainlink | ${aiModel}${aiExplanationStatus === "used" ? "" : ` [${aiExplanationStatus}]`}`,
    aiModel,
    aiExplanationStatus,
    aiExplanationError: shortRes.aiExplanationError || evaluation.ai_explanation_error || null,
    usage: shortRes.usage || null,
    analysis: {
      verdict: evaluation.recommendation === "PLAY" ? "VALUE CANDIDATE" : "SKIP",
      confidence: evaluation.confidence,
      estimatedFairProbability: evaluation.estimated_fair_probability,
      primaryOutcomeProbability: evaluation.primary_outcome_probability,
      expectedValueCents: evaluation.expected_value_cents,
      targetPrice: shortRes.targetPrice,
      oraclePrice: shortRes.oraclePrice,
      signalDataAt: shortRes.oraclePublishTime,
      technicalSource: evaluation.technical_source,
      validationIssues: evaluation.validation_issues,
      guardrailBlockers: evaluation.guardrail_blockers,
      rawRecommendation: evaluation.raw_recommendation,
      rawDirection: evaluation.raw_direction,
      rawPrimaryProbability: evaluation.raw_primary_probability,
      rawModelOutput: evaluation.rawText,
      scoutDirection: evaluation.forecast_direction || evaluation.direction,
      scoutRecommendation: evaluation.recommendation,
      forecastDirection: evaluation.forecast_direction,
      deterministicSnapshot: evaluation.deterministic_snapshot,
      aiExplanationStatus,
      aiExplanationError: shortRes.aiExplanationError || evaluation.ai_explanation_error || null,
      entryPricing: evaluation.entry_pricing,
      finalReason: evaluation.reason,
      summary: evaluation.reason || "Deterministic terminal-price evaluation unavailable.",
      bullishCase: [`Terminal UP probability: ${evaluation.primary_outcome_probability ?? "n/a"}%`],
      bearishCase: [`Terminal DOWN probability: ${evaluation.primary_outcome_probability == null ? "n/a" : (100 - evaluation.primary_outcome_probability).toFixed(2)}%`],
    },
  };
}

export function entrySnapshotFromShortResult(shortRes, market) {
  const evaluation = shortRes?.evaluation || {};
  const snapshot = evaluation.deterministic_snapshot || {};
  return {
    marketId: String(market.id),
    question: market.question,
    endDate: market.endDate,
    capturedAt: snapshot.capturedAt || new Date().toISOString(),
    remainingSeconds: evaluation.remaining_ms == null ? snapshot.remainingSeconds ?? null : Number((evaluation.remaining_ms / 1000).toFixed(3)),
    oracleAgeMs: evaluation.oracle_age_ms ?? null,
    marketActive: snapshot.marketActive ?? market.active === true,
    marketClosed: snapshot.marketClosed ?? market.closed === true,
    acceptingOrders: snapshot.acceptingOrders ?? market.acceptingOrders === true,
    feeBufferCents: snapshot.feeBufferCents ?? config.entryFeeBufferCents,
    forecastDirection: evaluation.forecast_direction || "NEUTRAL",
    sides: evaluation.entry_pricing || {},
    actionable: evaluation.actionable === true,
    blockers: evaluation.guardrail_blockers || [],
    timingPhase: evaluation.timing_phase ?? null,
    executionDiagnostics: evaluation.execution_diagnostics || snapshot.execution || null,
  };
}

export async function getFastShortEntrySnapshot(marketId, signal = null) {
  const market = await getMarketById(String(marketId || "").trim(), true, signal);
  if (!market) throw new Error("Market tidak ditemukan.");
  if (market.durationType !== "5m" || !isShortCryptoMarket(market)) {
    throw new Error("Dynamic EV hanya tersedia untuk short crypto market 5 menit.");
  }
  const closesAt = new Date(market.endDate).getTime();
  if (market.closed || !market.active || !market.acceptingOrders || !Number.isFinite(closesAt) || closesAt <= Date.now()) {
    throw new Error("Market sudah tutup atau tidak menerima order.");
  }
  const scored = await scoreOneMarket(market, signal);
  const shortRes = await evaluateShortMarketCondition({
    signal,
    marketId: scored.market.id,
    asset: shortCryptoAsset(scored.market.question),
    marketQuestion: scored.market.question,
    upTokenAsk: scored.score.shortBookPrices?.up.vwapAsk ?? scored.score.shortBookPrices?.up.bestAsk,
    downTokenAsk: scored.score.shortBookPrices?.down.vwapAsk ?? scored.score.shortBookPrices?.down.bestAsk,
    upTokenMidpoint: scored.score.shortBookPrices?.up.midpoint,
    downTokenMidpoint: scored.score.shortBookPrices?.down.midpoint,
    upExecution: scored.score.shortBookPrices?.up,
    downExecution: scored.score.shortBookPrices?.down,
    refreshMarketPrices: () => refreshShortExecutionSnapshot(scored.market.id, scored.score, signal),
    marketActive: scored.market.active,
    marketClosed: scored.market.closed,
    acceptingOrders: scored.market.acceptingOrders,
    durationType: scored.market.durationType,
    startDate: scored.market.startDate,
    endDate: scored.market.endDate,
    resolutionSource: scored.market.resolutionSource,
    includeAiExplanation: false,
  });
  return entrySnapshotFromShortResult(shortRes, scored.market);
}

async function resolveEventInput(arg, signal = null) {
  const session = getEventSession(arg);
  if (session) {
    const refreshed = await Promise.all(
      session.markets.map((market) => getMarketById(market.id, true, signal).catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      }))
    );
    return eventResultFromSession({ ...session, markets: refreshed.filter(Boolean) });
  }
  return resolveAnalyzeAllEventInput(arg, signal);
}

async function deepAnalyzeMarket({ market, query, setStep, ctx, signal = null, returnDetails = false }) {
  throwIfAborted(signal);
  setStep("Fetching CLOB orderbook");
  const scored = await scoreOneMarket(market, signal);

  throwIfAborted(signal);
  const shortMarket = isShortCryptoMarket(scored.market);
  let qwenResult;
  let researchContext = "";

  if (shortMarket) {
    setStep(`Running ${config.qwenShortModel} short-market explanation pipeline`);
    const asset = shortCryptoAsset(scored.market.question);
    const shortRes = await evaluateShortMarketCondition({
      signal,
      marketId: scored.market.id,
      asset,
      marketQuestion: scored.market.question,
      upTokenAsk: scored.score.shortBookPrices?.up.vwapAsk ?? scored.score.shortBookPrices?.up.bestAsk,
      downTokenAsk: scored.score.shortBookPrices?.down.vwapAsk ?? scored.score.shortBookPrices?.down.bestAsk,
      upTokenMidpoint: scored.score.shortBookPrices?.up.midpoint,
      downTokenMidpoint: scored.score.shortBookPrices?.down.midpoint,
      upExecution: scored.score.shortBookPrices?.up,
      downExecution: scored.score.shortBookPrices?.down,
      refreshMarketPrices: () => refreshShortExecutionSnapshot(scored.market.id, scored.score, signal),
      marketActive: scored.market.active,
      marketClosed: scored.market.closed,
      acceptingOrders: scored.market.acceptingOrders,
      durationType: scored.market.durationType,
      startDate: scored.market.startDate,
      endDate: scored.market.endDate,
      resolutionSource: scored.market.resolutionSource,
    });
    qwenResult = qwenResultFromShortEvaluation(shortRes);
  } else {
    setStep("Fetching external research context");
    researchContext = await buildResearchContext({ market: scored.market, signal });
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
  let actionable = false;
  
  if (shortMarket && qwenResult?.analysis) {
    const scoutDirection = String(qwenResult.analysis.scoutDirection || "").toUpperCase();
    const scoutRec = String(qwenResult.analysis.scoutRecommendation || "").toUpperCase();
    
    if (scoutDirection === "NEUTRAL") {
      finalPrediction = "=";
    } else if (scoutDirection === "UP" || scoutDirection === "YES") {
      finalPrediction = String(scored.score?.primaryOutcomeLabel || "UP").toUpperCase();
    } else if (scoutDirection === "DOWN" || scoutDirection === "NO") {
      finalPrediction = String(scored.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    } else {
      finalPrediction = "=";
    }
    actionable = scoutRec === "PLAY" && finalPrediction !== "=";
  } else {
    const confidence = Number(qwenResult?.analysis?.confidence);
    finalPrediction = predictionFromValidatedAnalysis(qwenResult?.analysis, scored.score);
    actionable = finalPrediction !== "=";
    if (finalPrediction === "=" && qwenResult?.analysis && (!Number.isFinite(confidence) || confidence < config.minQwenConfidence)) {
      qwenResult.analysis.finalReason = `[OVERRIDE] Confidence tidak valid atau terlalu rendah (${Number.isFinite(confidence) ? confidence : "n/a"}% < ${config.minQwenConfidence}%). ${qwenResult.analysis.finalReason || ""}`;
    }
  }

  const executionTime = ctx?.commandStartTime ? Math.round((Date.now() - ctx.commandStartTime) / 1000) : null;
  const entryPricing = entryPricingForPrediction(qwenResult?.analysis, actionable ? finalPrediction : "=");
  const fullAnalysisMarkdown = formatAnalysis({ market: scored.market, score: scored.score, qwenResult, finalPrediction, analysisTime: executionTime });

  if (!signal?.aborted) {
    const analyzedEventId = addAnalyzedEvent({
      market_id: scored.market.id,
      question: scored.market.question,
      url: scored.market.url,
      prediction: finalPrediction,
      actionable,
      analysis_conclusion: fullAnalysisMarkdown,
      qwen_confidence: String(qwenResult?.analysis?.confidence ?? ""),
      data_confidence: String(scored.score?.confidenceScore ?? ""),
      execution_time: executionTime,
      fair_probability: entryPricing.fairProbability,
      max_entry_price: entryPricing.maxEntryPrice,
      signal_data_at: qwenResult?.analysis?.signalDataAt || null,
    });
    if (analyzedEventId == null) throw new Error("Hasil analisis gagal disimpan ke history.");
  }

  if (returnDetails) {
    return {
      result: fullAnalysisMarkdown,
      confidence: qwenResult?.analysis?.confidence ?? null,
      direction: qwenResult?.analysis?.forecastDirection || qwenResult?.analysis?.scoutDirection || finalPrediction,
      probability: qwenResult?.analysis?.primaryOutcomeProbability ?? qwenResult?.analysis?.estimatedFairProbability ?? null,
      analysis: qwenResult?.analysis || null,
      aiExplanationStatus: qwenResult?.aiExplanationStatus || null,
    };
  }
  return fullAnalysisMarkdown;
}

export async function analyzeShortMarketForWeb(marketId, signal = null) {
  const target = { kind: "market", market: await getMarketById(String(marketId || "").trim(), true, signal) };
  const market = requireShortAnalysisMarket(target);
  return deepAnalyzeMarket({
    market,
    query: String(marketId),
    setStep: () => {},
    ctx: { commandStartTime: Date.now() },
    signal,
    returnDetails: true,
  });
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
  setStep("Fetching external research context");
  const eventResearchContext = await buildResearchContext({
    event: result.event,
    markets: result.markets,
    signal,
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
  setStep("Fetching external research context for best market");
  const bestResearchContext = await buildResearchContext({ market: best.market, signal });

  throwIfAborted(signal);
  
  const isShortCryptoMarketBest = isShortCryptoMarket(best.market);
  let bestQwen;

  if (isShortCryptoMarketBest) {
    setStep(`Running ${config.qwenShortModel} short-market explanation pipeline for best candidate`);
    const asset = shortCryptoAsset(best.market.question);
    const shortRes = await evaluateShortMarketCondition({
      signal,
      marketId: best.market.id,
      asset,
      marketQuestion: best.market.question,
      upTokenAsk: best.score.shortBookPrices?.up.vwapAsk ?? best.score.shortBookPrices?.up.bestAsk,
      downTokenAsk: best.score.shortBookPrices?.down.vwapAsk ?? best.score.shortBookPrices?.down.bestAsk,
      upTokenMidpoint: best.score.shortBookPrices?.up.midpoint,
      downTokenMidpoint: best.score.shortBookPrices?.down.midpoint,
      upExecution: best.score.shortBookPrices?.up,
      downExecution: best.score.shortBookPrices?.down,
      refreshMarketPrices: () => refreshShortExecutionSnapshot(best.market.id, best.score, signal),
      marketActive: best.market.active,
      marketClosed: best.market.closed,
      acceptingOrders: best.market.acceptingOrders,
      durationType: best.market.durationType,
      startDate: best.market.startDate,
      endDate: best.market.endDate,
      resolutionSource: best.market.resolutionSource,
    });
    bestQwen = qwenResultFromShortEvaluation(shortRes);
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
  let bestActionable = false;

  if (isShortCryptoMarketBest && bestQwen?.analysis) {
    const scoutDirection = String(bestQwen.analysis.scoutDirection || "").toUpperCase();
    const scoutRecommendation = String(bestQwen.analysis.scoutRecommendation || "").toUpperCase();
    if (scoutDirection === "NEUTRAL") {
      bestFinalPrediction = "=";
    } else if (scoutDirection === "UP" || scoutDirection === "YES") {
      bestFinalPrediction = String(best.score?.primaryOutcomeLabel || "UP").toUpperCase();
    } else if (scoutDirection === "DOWN" || scoutDirection === "NO") {
      bestFinalPrediction = String(best.score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    } else {
      bestFinalPrediction = "=";
    }
    bestActionable = scoutRecommendation === "PLAY" && bestFinalPrediction !== "=";
    if (!bestActionable) bestFinalPrediction = "=";
  } else {
    const confidence = Number(bestQwen?.analysis?.confidence);
    bestFinalPrediction = predictionFromValidatedAnalysis(bestQwen?.analysis, best.score);
    bestActionable = bestFinalPrediction !== "=";
    if (bestFinalPrediction === "=" && bestQwen?.analysis && (!Number.isFinite(confidence) || confidence < config.minQwenConfidence)) {
      bestQwen.analysis.finalReason = `[OVERRIDE] Confidence tidak valid atau terlalu rendah (${Number.isFinite(confidence) ? confidence : "n/a"}% < ${config.minQwenConfidence}%). ${bestQwen.analysis.finalReason || ""}`;
    }
  }

  const executionTime = ctx?.commandStartTime ? Math.round((Date.now() - ctx.commandStartTime) / 1000) : null;
  const entryPricing = entryPricingForPrediction(bestQwen?.analysis, bestActionable ? bestFinalPrediction : "=");
  const fullAnalysisMarkdownBest = formatAnalysis({ market: best.market, score: best.score, qwenResult: bestQwen, finalPrediction: bestFinalPrediction, analysisTime: executionTime });

  if (!signal?.aborted) {
    addAnalyzedEvent({
      market_id: best.market.id,
      question: best.market.question,
      url: best.market.url,
      prediction: bestFinalPrediction,
      actionable: bestActionable,
      analysis_conclusion: fullAnalysisMarkdownBest,
      qwen_confidence: String(bestQwen?.analysis?.confidence ?? ""),
      data_confidence: String(best.score?.confidenceScore ?? ""),
      execution_time: executionTime,
      fair_probability: entryPricing.fairProbability,
      max_entry_price: entryPricing.maxEntryPrice,
      signal_data_at: bestQwen?.analysis?.signalDataAt || null,
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
  if (!guard.allowed) return menuAnswer(guard.message, { status: "rejected", reason: "rate_limit" });

  try {
  if (command === "/start" || command === "/help") {
    return menuAnswer(formatHelp());
  }

  if (command === "/version") {
    return menuAnswer(`Bot version: ${SEARCH_ENGINE_VERSION}`);
  }

  if (command === "/resolve") {
    const progressMessage = await ctx.sendMessage("Mengecek hasil resmi market di Polymarket...", menuKeyboard());
    const resultText = await resolvePendingEvents({ signal: ctx?.signal });
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
    
    const markets = await searchMarkets(query, 5, ctx?.signal);
    return menuAnswer(formatSearchResults(markets));
  }

  if (command === "/top") {
    const mode = ["volume", "liquidity", "new", "ending"].includes(arg) ? arg : "volume";
    return menuAnswer(formatTopMarkets(await listTopMarkets({ mode, limit: 10, signal: ctx?.signal })));
  }

  if (command === "/book") {
    const usage = "Pakai format: /book <marketId atau link Polymarket>\n\nContoh: /book 2169995";
    if (!arg || (!isShortMarketId(arg) && !looksLikeUrl(arg))) return menuAnswer(usage);
    const market = await resolveMarketInput(arg, ctx?.signal);
    const tokens = isShortCryptoMarket(market) ? pickShortUpDownTokens(market) : pickYesNoTokens(market);
    if (!tokens.yesTokenId) {
      return menuAnswer("Market ditemukan, tapi token utama tidak tersedia.");
    }
    const book = await getOrderBook(tokens.yesTokenId, ctx?.signal);
    return menuAnswer(formatBook(book));
  }


  if (command === "/analyzequeue") {
    if (!arg) return menuAnswer("Format: /analyzequeue <url1>,<url2>...");
    
    const urls = arg.split(",").map(s => s.trim()).filter(Boolean);
    if (!urls.length) return menuAnswer("Tidak ada URL/ID market yang dikirim.");

    const queueResults = [];
    const output = await runWithProgress(
      ctx,
      `Menganalisis ${urls.length} market dari antrian`,
      async (setStep, signal) => {
        const results = [];
        for (let i = 0; i < urls.length; i++) {
          throwIfAborted(signal);
          const url = urls[i];
          let lastError = null;
          for (let attempt = 1; attempt <= 2; attempt++) {
            setStep(`[Queue ${i + 1}/${urls.length}] Resolving market${attempt > 1 ? " (retry)" : ""}...`);
            try {
              const target = await resolveAnalyzeInput(url, signal);
              if (target.kind === "market" && !target.market) throw new Error("Market tidak ditemukan.");

              setStep(`[Queue ${i + 1}/${urls.length}] Analyzing: ${target.market.question}`);
              const markdown = await deepAnalyzeMarket({ market: target.market, query: url, setStep, ctx, signal });

              if (markdown && ctx && typeof ctx.sendMessage === "function") {
                await ctx.sendMessage(markdown, menuKeyboard()).catch(() => {});
              }

              queueResults.push({ input: url, marketId: String(target.market.id), status: "success", attempts: attempt });
              results.push(`✅ Selesai: ${target.market.question}`);
              lastError = null;
              break;
            } catch (err) {
              if (signal?.aborted) throw err;
              lastError = err;
            }
          }
          if (lastError) {
            queueResults.push({ input: url, status: "error", attempts: 2, error: lastError.message || String(lastError) });
            results.push(`❌ Gagal (${url.slice(-15)}...): ${lastError.message}`);
          }
        }
        return `✅ Antrian Selesai Diproses!\n\n${results.join("\\n")}`;
      },
      { estimateSeconds: urls.length * 20, mode: "deep" }
    );
    return menuAnswer(output, { status: "completed", type: "analysis_queue", items: queueResults });
  }

  if (["/quickscan", "/top3", "/eventscan", "/eventtop"].includes(command)) {
    if (!arg) return menuAnswer(`Pakai format: ${command} <link, slug, atau session event>`);
    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving event input");
      const result = await resolveEventInput(arg, ctx?.signal);
      if (!result?.markets?.length) return "Event tidak ditemukan atau tidak punya market aktif.";
      const limit = command === "/top3" || command === "/eventtop" ? 3 : 8;
      return quickScanEvent({ result, query: arg, setStep, ctx, limit, signal: ctx?.signal });
    });
    return menuAnswer(output);
  }

  if (command === "/analyzeall" || command === "/eventall") {
    if (!arg) return menuAnswer(`Pakai format: ${command} <link, slug, atau session event>`);
    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving event input");
      const result = await resolveEventInput(arg, ctx?.signal);
      if (!result?.markets?.length) return "Event tidak ditemukan atau tidak punya market aktif.";
      return analyzeAllEvent({ result, query: arg, setStep, ctx, signal: ctx?.signal });
    });
    return menuAnswer(output);
  }

  if (command === "/eventmarket") {
    const [sessionId, marketId] = arg.split(/\s+/);
    const session = getEventSession(sessionId);
    const sessionMarket = session?.markets?.find((item) => String(item.id) === String(marketId));
    if (!sessionMarket) return menuAnswer("Session atau market event tidak ditemukan/kedaluwarsa.");
    const market = await getMarketById(marketId, true, ctx?.signal);
    if (!market) return menuAnswer("Market event tidak dapat dimuat ulang.");
    const output = await runWithProgress(ctx, market.question, (setStep) =>
      deepAnalyzeMarket({ market, query: `${sessionId} ${marketId}`, setStep, ctx, signal: ctx?.signal })
    );
    return menuAnswer(output);
  }

  if (command === "/shortanalyze") {
    if (!arg) {
      return menuAnswer("Pakai format: /shortanalyze <market ID atau link fixed-window crypto Up or Down>");
    }

    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving short-market input");
      const target = await resolveAnalyzeInput(arg, ctx?.signal);
      const market = requireShortAnalysisMarket(target);
      return deepAnalyzeMarket({ market, query: arg, setStep, ctx, signal: ctx?.signal });
    });
    return menuAnswer(output);
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

      const result = await getMarketsFromPolymarketLink(arg, ctx?.signal);
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
      const target = preResolvedTarget || (await resolveAnalyzeInput(arg, ctx?.signal));
      if (target.kind === "market" && !target.market) return "Market tidak ditemukan.";

      if (target.kind === "event") {
        return bestCandidateAnalysis({ result: target, query: arg, setStep, ctx, signal: ctx?.signal });
      }

      return deepAnalyzeMarket({ market: target.market, query: arg, setStep, ctx, signal: ctx?.signal });
    });

    return menuAnswer(output);
  }

  if (command === "/analyzebest" || command === "/eventbest") {
    if (!arg) {
      return menuAnswer(
        "Pakai format: /analyzebest <link event atau slug event>\n\nContoh: /analyzebest colombia-presidential-election"
      );
    }

    const output = await runWithProgress(ctx, arg, async (setStep) => {
      setStep("Resolving event input");
      const result = await resolveEventInput(arg, ctx?.signal);
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
    const nickname = parts.slice(1).join(" ").slice(0, 40);
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return menuAnswer("⚠️ Alamat wallet tidak valid. Format: 0x diikuti 40 karakter hex (0-9a-f).");
    }
    const normalized = address.toLowerCase();
    const cfg = getTrackerConfig();
    const wallets = cfg.wallets;
    if (!wallets.find(w => String(w.address || "").toLowerCase() === normalized)) {
      wallets.push({ address: normalized, nickname });
      setTrackerConfig(cfg.minUsd, wallets);
      return menuAnswer(`✅ Wallet ${normalized} (${nickname || "Tanpa Nama"}) berhasil ditambahkan ke Tracker.`);
    } else {
      return menuAnswer(`⚠️ Wallet ${normalized} sudah ada di Tracker.`);
    }
  }

  if (command === "/del") {
    if (!arg) return menuAnswer("Format: /del <alamat_wallet>\nContoh: /del 0x123...");
    const address = arg.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return menuAnswer("⚠️ Alamat wallet tidak valid. Format: 0x diikuti 40 karakter hex (0-9a-f).");
    }
    const cfg = getTrackerConfig();
    const originalLength = cfg.wallets.length;
    const wallets = cfg.wallets.filter(w => String(w.address || "").toLowerCase() !== address);
    if (wallets.length < originalLength) {
      setTrackerConfig(cfg.minUsd, wallets);
      return menuAnswer(`✅ Wallet ${address} berhasil dihapus dari Tracker.`);
    } else {
      return menuAnswer(`⚠️ Wallet ${address} tidak ditemukan di Tracker.`);
    }
  }

  if (command === "/sniffer") {
    if (arg === "on") {
      try {
        const active = await setSnifferState(true);
        if (!active) return "⚠️ Sniffer tidak berhasil diaktifkan.";
        const health = getSnifferWsStatus();
        if (health.state === "CONNECTED") {
          return "✅ *LIVE WHALE SNIFFER DIAKTIFKAN*\nBot sekarang memantau Polymarket 24/7.";
        }
        return `⚠️ Sniffer aktif tetapi koneksi masih ${health.state}. Data dapat terdegradasi sampai koneksi pulih.`;
      } catch {
        return "❌ Sniffer gagal diaktifkan. Proses tetap berjalan; periksa status koneksi lalu coba lagi.";
      }
    } else if (arg === "off") {
      try {
        await setSnifferState(false);
        return "⏸️ *LIVE WHALE SNIFFER DIMATIKAN*\nPemantauan dihentikan.";
      } catch {
        return "⚠️ Sniffer gagal dimatikan sepenuhnya. Periksa status koneksi.";
      }
    } else {
      const state = getSnifferState() ? "ON ✅" : "OFF ⏸️";
      return `📡 *Status Sniffer saat ini: ${state}*\nGunakan \`/sniffer on\` atau \`/sniffer off\` untuk mengatur.`;
    }
  }

  if (command === "/shortcondition" || command === "/shortvibe") {
    if (!isShortMarketId(arg)) {
      return menuAnswer("Pakai format: /shortcondition <marketId>. Metadata durasi, waktu selesai, outcome, dan resolution source wajib tersedia agar analisis tidak menebak.");
    }
    return runWithProgress(ctx, "Checking short market condition...", async (setStep, signal) => {
      const requestSignal = signal || ctx?.signal;
      setStep("Fetching verified short-market metadata");
      const market = await getMarketById(arg, true, requestSignal);
      if (!isShortCryptoMarket(market)) throw new Error("Market ID bukan fixed-window crypto Up or Down market.");
      const scored = await scoreOneMarket(market, requestSignal);
      const result = await evaluateShortMarketCondition({
        signal: requestSignal,
        marketId: market.id,
        asset: shortCryptoAsset(market.question),
        marketQuestion: market.question,
        upTokenAsk: scored.score.shortBookPrices?.up.vwapAsk ?? scored.score.shortBookPrices?.up.bestAsk,
        downTokenAsk: scored.score.shortBookPrices?.down.vwapAsk ?? scored.score.shortBookPrices?.down.bestAsk,
        upTokenMidpoint: scored.score.shortBookPrices?.up.midpoint,
        downTokenMidpoint: scored.score.shortBookPrices?.down.midpoint,
        upExecution: scored.score.shortBookPrices?.up,
        downExecution: scored.score.shortBookPrices?.down,
        refreshMarketPrices: () => refreshShortExecutionSnapshot(market.id, scored.score, requestSignal),
        marketActive: market.active,
        marketClosed: market.closed,
        acceptingOrders: market.acceptingOrders,
        durationType: market.durationType,
        startDate: market.startDate,
        endDate: market.endDate,
        resolutionSource: market.resolutionSource,
      });
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

    const recentTrades = getRecentResolvedOutcomes({ days: 60 });
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
    console.log(`\n[Hot Niche Alert] Market: ${payload.marketInfo.question}`);
  }
});
