function money(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function pct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}%`;
}

function price(value) {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(3);
}

function probability(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function formatDateWib(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(" pukul ", " ")
    .replace(".", ":")
    .replace(" WIB", "");
}

function statusLabel(market) {
  if (market.closed) return "CLOSED";
  if (market.active && market.acceptingOrders) return "OPEN";
  if (market.active) return "ACTIVE, orders unclear";
  return "INACTIVE";
}

function outcomeLine(market) {
  if (!market.outcomes?.length || !market.outcomePrices?.length) return "Price: n/a";

  const pairs = market.outcomes.map((outcome, index) => {
    const value = market.outcomePrices[index];
    return `${outcome} ${price(value)} (${probability(value)})`;
  });

  return `Price: ${pairs.join(" | ")}`;
}

function hasBlankGroupTitle(markets) {
  return markets.some((market) => market.eventTitle?.includes("___"));
}

export function formatHelp() {
  return [
    "Polymarket Analyzer Bot",
    "Version: public-search-v2",
    "",
    "Command:",
    "/search <keyword> - cari market aktif",
    "/analyze <keyword atau marketId> - analisis manual dengan Qwen",
    "/book <tokenId atau marketId> - cek orderbook token CLOB",
    "",
    "Bot ini hanya analisis, bukan auto-entry.",
  ].join("\n");
}

export function formatSearchResults(markets) {
  if (!markets.length) return "Market tidak ditemukan.";

  const body = markets
    .map((m, index) =>
      [
        `${index + 1}. ${m.question}`,
        m.eventTitle && m.eventTitle !== m.question ? `Group: ${m.eventTitle}` : "",
        `Market ID: ${m.id || "n/a"}`,
        `Status: ${statusLabel(m)}`,
        m.groupItemTitle ? `Variant: ${m.groupItemTitle}` : "",
        `API close/resolution: ${formatDateWib(m.endDate)} WIB`,
        outcomeLine(m),
        `Liquidity: ${money(m.liquidity)} | Volume: ${money(m.volume)}`,
        `Analyze: /analyze ${m.id}`,
        `Book: /book ${m.id}`,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  const note = hasBlankGroupTitle(markets)
    ? "\n\nNote: Group berisi ___ karena Polymarket menggabungkan beberapa market tanggal. Pakai Market ID untuk memilih tanggal spesifik."
    : "";

  return [`SEARCH RESULTS`, `Open markets: ${markets.length}`, "", body + note].join("\n");
}

export function formatBook(book) {
  const bids = Array.isArray(book.bids) ? book.bids.slice(0, 5) : [];
  const asks = Array.isArray(book.asks) ? book.asks.slice(0, 5) : [];

  return [
    "ORDERBOOK",
    `Token: ${book.asset_id || "n/a"}`,
    "",
    "Best Bids:",
    ...bids.map((x) => `- ${x.price} x ${x.size}`),
    "",
    "Best Asks:",
    ...asks.map((x) => `- ${x.price} x ${x.size}`),
  ].join("\n");
}

export function formatAnalysis({ market, score, qwenText }) {
  return [
    "EVENT ANALYSIS",
    `Market: ${market.question}`,
    market.eventTitle && market.eventTitle !== market.question
      ? `Group: ${market.eventTitle}`
      : "",
    `Market ID: ${market.id || "n/a"}`,
    `Status: ${statusLabel(market)}`,
    market.groupItemTitle ? `Variant: ${market.groupItemTitle}` : "",
    `API close/resolution: ${formatDateWib(market.endDate)} WIB`,
    market.url ? `URL: ${market.url}` : "",
    "",
    "MARKET DATA",
    outcomeLine(market),
    `Liquidity: ${money(market.liquidity)}`,
    `Volume: ${money(market.volume)}`,
    `Best Bid: ${price(score.bestBid)}`,
    `Best Ask: ${price(score.bestAsk)}`,
    `Spread: ${pct(score.spreadPercent)}`,
    "",
    "SCORING MEKANIS",
    `Market Implied Probability: ${pct(score.marketProbability)}`,
    `Estimated Fair Probability: ${pct(score.estimatedFairProbability)}`,
    `Edge Score: ${pct(score.edgeScore)}`,
    `Confidence Score: ${score.confidenceScore}/100`,
    `Underdog Score: ${score.underdogScore}/10`,
    `Liquidity Risk: ${score.liquidityRisk}`,
    `Spread Risk: ${score.spreadRisk}`,
    `Resolution Risk: ${score.resolutionRisk}`,
    "",
    "REASONING QWEN",
    qwenText,
    "",
    "FINAL VERDICT",
    score.verdict,
    "",
    "Disclaimer: Analisis ini bukan financial advice dan tidak menjamin hasil.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
