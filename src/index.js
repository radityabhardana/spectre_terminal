import { assertConfig, config } from "./config.js";
import {
  formatAnalysis,
  formatAnalyzeAllSummary,
  formatBook,
  formatEventChoicePrompt,
  formatEventAnalysis,
  formatHelp,
  formatMarketBubble,
  formatSearchResults,
} from "./format.js";
import {
  getMarketFromPolymarketLink,
  getMarketById,
  getMarketsFromPolymarketLink,
  getOrderBook,
  parsePolymarketLink,
  pickYesNoTokens,
  SEARCH_ENGINE_VERSION,
  searchMarkets,
} from "./polymarket.js";
import { askQwen, askQwenEvent } from "./qwen.js";
import { scoreMarket } from "./scoring.js";
import { appendAnalysisLog } from "./storage.js";
import { TelegramBot } from "./telegram.js";

const MENU_BUTTONS = {
  SEARCH: "Search Market",
  ANALYZE: "Analyze Link / ID",
  BOOK: "Orderbook Check",
  VERSION: "Bot Version",
  HELP: "Help",
  EXAMPLE: "Example Flow",
};

function menuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: MENU_BUTTONS.SEARCH }, { text: MENU_BUTTONS.ANALYZE }],
        [{ text: MENU_BUTTONS.BOOK }, { text: MENU_BUTTONS.EXAMPLE }],
        [{ text: MENU_BUTTONS.VERSION }, { text: MENU_BUTTONS.HELP }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      is_persistent: true,
    },
  };
}

function commandValueFromSource(sourceInput, fallbackSlug = "") {
  const input = String(sourceInput || "").trim();
  if (slugLike(input)) return input;

  const parsed = parsePolymarketLink(input);
  if (parsed?.slug) return parsed.slug;

  return fallbackSlug || input;
}

function eventChoiceKeyboard({ event, markets, sourceInput }) {
  const commandValue = commandValueFromSource(sourceInput, event?.slug || "");
  const top = [...markets]
    .sort((a, b) => b.liquidity + b.volume - (a.liquidity + a.volume))
    .slice(0, 8);

  const rows = [
    [
      { text: `/analyzebest ${commandValue}` },
      { text: `/analyzeall ${commandValue}` },
    ],
  ];

  for (let i = 0; i < top.length; i += 2) {
    const left = top[i];
    const right = top[i + 1];
    const row = [{ text: `/analyze ${left.id}` }];
    if (right) row.push({ text: `/analyze ${right.id}` });
    rows.push(row);
  }

  rows.push([{ text: "/help" }]);

  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: true,
      is_persistent: false,
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
  if (trimmed === MENU_BUTTONS.SEARCH) return "/search";
  if (trimmed === MENU_BUTTONS.ANALYZE) return "/analyze";
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
    throw new Error(`Market ${market.id} tidak punya token YES.`);
  }

  const yesBook = await getOrderBook(tokens.yesTokenId);
  const score = scoreMarket({ market, yesBook });
  return { market, yesBook, score };
}

async function scoreEventMarkets(markets, setStep) {
  const analyzed = [];
  const batchSize = 5;

  for (let index = 0; index < markets.length; index += batchSize) {
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

function progressText({ query, step, elapsedSeconds, estimateSeconds }) {
  const remaining = Math.max(0, estimateSeconds - elapsedSeconds);
  return [
    "ANALISIS SEDANG BERJALAN",
    `Input: ${query}`,
    `Step: ${step}`,
    `Berjalan: ${elapsedSeconds}s`,
    `Estimasi sisa: ${remaining}s`,
    "",
    "Bot sedang ambil market data, cek CLOB orderbook, lalu minta Qwen menyusun analisis.",
  ].join("\n");
}

async function runWithProgress(ctx, query, task) {
  const estimateSeconds = 25;
  const startedAt = Date.now();
  let step = "Resolving market input";

  const progressMessage = await ctx.sendMessage(
    progressText({ query, step, elapsedSeconds: 0, estimateSeconds }),
    menuKeyboard()
  );

  const interval = setInterval(async () => {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    if (elapsedSeconds >= 5 && elapsedSeconds < 10) step = "Fetching Gamma market data";
    else if (elapsedSeconds >= 10 && elapsedSeconds < 15) step = "Checking CLOB orderbook";
    else if (elapsedSeconds >= 15) step = "Waiting for Qwen reasoning";

    try {
      await ctx.sendChatAction("typing");
      if (progressMessage?.message_id) {
        await ctx.editMessageText(
          progressMessage.message_id,
          progressText({ query, step, elapsedSeconds, estimateSeconds })
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
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      await ctx
        .editMessageText(
          progressMessage.message_id,
          [
            "ANALISIS SELESAI",
            `Input: ${query}`,
            `Selesai dalam: ${elapsedSeconds}s`,
            "",
            "Hasil lengkap dikirim di bawah.",
          ].join("\n")
        )
        .catch(() => {});
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

async function handleCommand(text, message, ctx) {
  const { command, arg } = parseCommand(text);

  if (command === "/start" || command === "/help") {
    return menuAnswer(formatHelp());
  }

  if (command === "/version") {
    return menuAnswer(`Bot version: ${SEARCH_ENGINE_VERSION}`);
  }

  if (command === "/example") {
    return menuAnswer(
      [
        "EXAMPLE FLOW",
        "1. Cari market:",
        "/search MicroStrategy sells any Bitcoin",
        "",
        "2. Analisis dari Market ID:",
        "/analyze 2169995",
        "",
        "3. Pilih market dari event (mode pilih):",
        "/analyze https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025",
        "",
        "4. Cari kandidat paling worth it otomatis dari event:",
        "/analyzebest colombia-presidential-election",
        "",
        "4. Atau jelaskan semua pilihan aktif (1 pilihan = 1 bubble):",
        "/analyzeall https://polymarket.com/event/microstrategy-sell-any-bitcoin-in-2025",
      ].join("\n")
    );
  }

  if (command === "/search") {
    if (!arg) return menuAnswer("Pakai format: /search <keyword>\n\nContoh: /search MicroStrategy sells any Bitcoin");
    const markets = await searchMarkets(arg, 5);
    return menuAnswer(formatSearchResults(markets));
  }

  if (command === "/book") {
    if (!arg) return menuAnswer("Pakai format: /book <tokenId, marketId, atau link Polymarket>\n\nContoh: /book 2169995");
    let tokenId = arg;
    if (isShortMarketId(arg) || looksLikeUrl(arg)) {
      const market = await resolveMarketInput(arg);
      const tokens = pickYesNoTokens(market);
      if (!tokens.yesTokenId) {
        return menuAnswer("Market ditemukan, tapi token YES tidak tersedia.");
      }
      tokenId = tokens.yesTokenId;
    }
    const book = await getOrderBook(tokenId);
    return menuAnswer(formatBook(book));
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
        return {
          text: formatEventChoicePrompt({
            event: result.event,
            markets: result.markets,
            sourceInput: arg,
          }),
          options: eventChoiceKeyboard({
            event: result.event,
            markets: result.markets,
            sourceInput: arg,
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
        setStep(`Found ${target.markets.length} active markets in event`);
        const analyzedMarkets = await scoreEventMarkets(target.markets, setStep);
        if (!analyzedMarkets.length) {
          return "Event ditemukan, tapi tidak ada market aktif dengan orderbook yang bisa dianalisis.";
        }

        setStep("Waiting for Qwen event comparison");
        const qwenResult = await askQwenEvent({
          event: target.event,
          analyzedMarkets,
        });

        appendAnalysisLog({
          query: arg,
          eventId: target.event?.id,
          eventTitle: target.event?.title,
          marketCount: analyzedMarkets.length,
          eventAnalysis: analyzedMarkets.map(({ market, score }) => ({
            marketId: market.id,
            question: market.question,
            score,
          })),
          qwen: {
            model: qwenResult.model,
            usage: qwenResult.usage,
            analysis: qwenResult.analysis,
          },
        });

        return formatEventAnalysis({
          event: target.event,
          analyzedMarkets,
          qwenResult,
        });
      }

      setStep("Fetching CLOB orderbook");
      const { market, yesBook, score } = await scoreOneMarket(target.market);

      setStep("Waiting for Qwen reasoning");
      const qwenResult = await askQwen({ market, score, orderBook: yesBook });

      appendAnalysisLog({
        query: arg,
        marketId: market.id,
        question: market.question,
        score,
        qwen: {
          model: qwenResult.model,
          usage: qwenResult.usage,
          analysis: qwenResult.analysis,
        },
      });

      return formatAnalysis({ market, score, qwenResult });
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
      const result = await resolveAnalyzeAllEventInput(arg);
      if (!result || !result.markets?.length) {
        return "Event tidak ditemukan atau tidak punya market aktif yang bisa dianalisis.";
      }

      if (result.kind !== "event" || result.markets.length <= 1) {
        const single = result.markets[0];
        if (!single) return "Tidak ada market aktif untuk dianalisis.";

        setStep("Fetching CLOB orderbook");
        const { market, yesBook, score } = await scoreOneMarket(single);

        setStep("Waiting for Qwen reasoning");
        const qwenResult = await askQwen({ market, score, orderBook: yesBook });
        return formatAnalysis({ market, score, qwenResult });
      }

      setStep(`Scoring ${result.markets.length} active markets`);
      const analyzedMarkets = await scoreEventMarkets(result.markets, setStep);
      if (!analyzedMarkets.length) {
        return "Event ditemukan, tapi tidak ada market aktif dengan orderbook yang valid.";
      }

      setStep("Comparing event markets with Qwen");
      const eventQwen = await askQwenEvent({
        event: result.event,
        analyzedMarkets,
      });

      const best = pickBestEventCandidate(analyzedMarkets, eventQwen);
      if (!best) return "Tidak ada kandidat market yang layak dipilih saat ini.";

      setStep("Deep dive best market with Qwen");
      const bestQwen = await askQwen({
        market: best.market,
        score: best.score,
        orderBook: best.yesBook,
      });

      appendAnalysisLog({
        query: arg,
        mode: "analyzebest",
        eventId: result.event?.id,
        eventTitle: result.event?.title,
        selectedMarketId: best.market.id,
        selectedMarketQuestion: best.market.question,
        selectedScore: best.score,
        qwenEvent: {
          model: eventQwen.model,
          usage: eventQwen.usage,
          analysis: eventQwen.analysis,
        },
        qwenBest: {
          model: bestQwen.model,
          usage: bestQwen.usage,
          analysis: bestQwen.analysis,
        },
      });

      return [
        "BEST CANDIDATE FROM EVENT",
        `Event: ${result.event?.title || "n/a"}`,
        `Selected Market ID: ${best.market.id}`,
        eventQwen.analysis?.bestReason ? `Event reason: ${eventQwen.analysis.bestReason}` : null,
        "",
        formatAnalysis({
          market: best.market,
          score: best.score,
          qwenResult: bestQwen,
        }),
      ]
        .filter((line) => line != null && line !== false)
        .join("\n");
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
      const result = await resolveAnalyzeAllEventInput(arg);
      if (!result || !result.markets?.length) {
        return "Event tidak ditemukan atau tidak punya market aktif yang bisa dianalisis.";
      }

      if (result.kind !== "event" || result.markets.length <= 1) {
        const single = result.markets[0];
        if (!single) return "Tidak ada market aktif untuk dianalisis.";

        setStep("Fetching CLOB orderbook");
        const { market, yesBook, score } = await scoreOneMarket(single);

        setStep("Waiting for Qwen reasoning");
        const qwenResult = await askQwen({ market, score, orderBook: yesBook });

        appendAnalysisLog({
          query: arg,
          marketId: market.id,
          question: market.question,
          score,
          qwen: {
            model: qwenResult.model,
            usage: qwenResult.usage,
            analysis: qwenResult.analysis,
          },
        });

        return formatAnalysis({ market, score, qwenResult });
      }

      setStep(`Found ${result.markets.length} active markets`);
      const analyzedMarkets = await scoreEventMarkets(result.markets, setStep);
      if (!analyzedMarkets.length) {
        return "Event ditemukan, tapi tidak ada market dengan orderbook YES yang bisa dianalisis.";
      }

      const sorted = sortMarketsForAllMode(analyzedMarkets);
      for (let i = 0; i < sorted.length; i += 1) {
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
      }

      appendAnalysisLog({
        query: arg,
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
    });

    return menuAnswer(output);
  }

  return menuAnswer(formatHelp());
}

assertConfig();

const bot = new TelegramBot(config.telegramToken, handleCommand);
bot.start();
