import { assertConfig, config } from "./config.js";
import { formatAnalysis, formatBook, formatHelp, formatSearchResults } from "./format.js";
import {
  getMarketById,
  getOrderBook,
  pickYesNoTokens,
  SEARCH_ENGINE_VERSION,
  searchMarkets,
} from "./polymarket.js";
import { askQwen } from "./qwen.js";
import { scoreMarket } from "./scoring.js";
import { appendAnalysisLog } from "./storage.js";
import { TelegramBot } from "./telegram.js";

function parseCommand(text) {
  const [commandWithBot, ...rest] = text.trim().split(/\s+/);
  const command = commandWithBot.split("@")[0].toLowerCase();
  return { command, arg: rest.join(" ").trim() };
}

function isShortMarketId(value) {
  return /^[0-9]{1,10}$/.test(value.trim());
}

async function handleCommand(text) {
  const { command, arg } = parseCommand(text);

  if (command === "/start" || command === "/help") {
    return formatHelp();
  }

  if (command === "/version") {
    return `Bot version: ${SEARCH_ENGINE_VERSION}`;
  }

  if (command === "/search") {
    if (!arg) return "Pakai format: /search <keyword>";
    const markets = await searchMarkets(arg, 5);
    return formatSearchResults(markets);
  }

  if (command === "/book") {
    if (!arg) return "Pakai format: /book <tokenId atau marketId>";
    let tokenId = arg;
    if (isShortMarketId(arg)) {
      const market = await getMarketById(arg);
      const tokens = pickYesNoTokens(market);
      if (!tokens.yesTokenId) {
        return "Market ditemukan, tapi token YES tidak tersedia.";
      }
      tokenId = tokens.yesTokenId;
    }
    const book = await getOrderBook(tokenId);
    return formatBook(book);
  }

  if (command === "/analyze") {
    if (!arg) return "Pakai format: /analyze <keyword atau marketId>";

    const market = isShortMarketId(arg)
      ? await getMarketById(arg)
      : (await searchMarkets(arg, 1))[0];
    if (!market) return "Market tidak ditemukan.";

    const tokens = pickYesNoTokens(market);
    if (!tokens.yesTokenId) {
      return "Market ditemukan, tapi token YES tidak tersedia. Bot skip supaya tidak mengarang data.";
    }

    const yesBook = await getOrderBook(tokens.yesTokenId);
    const score = scoreMarket({ market, yesBook });
    const qwenText = await askQwen({ market, score, orderBook: yesBook });

    appendAnalysisLog({
      query: arg,
      marketId: market.id,
      question: market.question,
      score,
      qwenText,
    });

    return formatAnalysis({ market, score, qwenText });
  }

  return formatHelp();
}

assertConfig();

const bot = new TelegramBot(config.telegramToken, handleCommand);
bot.start();
