function money(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function pct(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}%`;
}

function points(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toFixed(1)} poin`;
}

function price(value) {
  if (!Number.isFinite(value)) return "n/a";
  const digits = Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 4 : 3;
  return value
    .toFixed(digits)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

function probability(value) {
  if (!Number.isFinite(value)) return "n/a";
  const percent = value * 100;
  const digits = Math.abs(percent) > 0 && Math.abs(percent) < 1 ? 2 : 1;
  return `${percent.toFixed(digits)}%`;
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

function listLines(items) {
  const rows = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!rows.length) return ["- n/a"];
  return rows.map((item) => `- ${item}`);
}

function usageLine(qwenResult) {
  const usage = qwenResult?.usage;
  if (!usage) return "Qwen usage: API tidak mengembalikan token usage";

  const prompt = usage.prompt_tokens ?? usage.input_tokens;
  const completion = usage.completion_tokens ?? usage.output_tokens;
  const total = usage.total_tokens ?? usage.totalTokens;

  if (total != null) {
    return `Qwen usage: ${total} tokens (input ${prompt ?? "n/a"}, output ${
      completion ?? "n/a"
    })`;
  }

  return `Qwen usage: ${JSON.stringify(usage)}`;
}

function finalVerdict(score, qwenAnalysis) {
  const qwenVerdict = qwenAnalysis?.verdict || score.verdict;
  const hardBlockers = (score.blockers || []).filter(
    (item) => item !== "No measured positive edge"
  );

  if (hardBlockers.length) return "SKIP";
  if (qwenVerdict === "SKIP") return "SKIP";
  if (
    qwenVerdict === "VALUE CANDIDATE" &&
    (score.edgeScore == null || score.edgeScore < 3)
  ) {
    return "WATCHLIST";
  }
  return qwenVerdict;
}

function directionSignal(score) {
  const p = Number(score?.marketProbability);
  if (!Number.isFinite(p)) {
    return {
      side: "N/A",
      yesConfidence: NaN,
      noConfidence: NaN,
      dominanceGap: NaN,
    };
  }

  const yesConfidence = Math.max(0, Math.min(100, p));
  const noConfidence = Math.max(0, Math.min(100, 100 - p));
  const dominanceGap = Math.abs(yesConfidence - noConfidence);

  if (yesConfidence >= noConfidence + 2) {
    return { side: "YES", yesConfidence, noConfidence, dominanceGap };
  }
  if (noConfidence >= yesConfidence + 2) {
    return { side: "NO", yesConfidence, noConfidence, dominanceGap };
  }
  return { side: "NETRAL", yesConfidence, noConfidence, dominanceGap };
}

function oneLine(list) {
  if (!Array.isArray(list) || !list.length) return "n/a";
  return String(list[0] || "n/a");
}

export function formatHelp() {
  return [
    "Polymarket Analyzer Bot",
    "Version: public-search-v2-event-wide-analysis-v3-buttons-best-all",
    "",
    "Command:",
    "/search <keyword> - cari market aktif",
    "/analyze <keyword, marketId, atau link Polymarket> - analisis manual dengan Qwen",
    "/analyzebest <link/slug event> - pilih kandidat paling worth it dari event",
    "/analyzeall <link event Polymarket> - jelaskan semua pilihan aktif satu per satu",
    "/book <tokenId, marketId, atau link Polymarket> - cek orderbook token CLOB",
    "/example - contoh alur pakai bot",
    "",
    "Tombol menu akan muncul di bawah chat setelah /start.",
    "Kamu juga bisa kirim link Polymarket atau Market ID langsung untuk dianalisis.",
    "Bot ini hanya analisis, bukan auto-entry.",
  ].join("\n");
}

function verdictIcon(verdict) {
  if (verdict === "VALUE CANDIDATE") return "VALUE";
  if (verdict === "WATCHLIST") return "WATCH";
  if (verdict === "HIGH RISK UNDERDOG") return "UNDERDOG";
  return "SKIP";
}

export function formatEventChoicePrompt({ event, markets, sourceInput }) {
  const source = String(sourceInput || "").trim();
  const top = [...markets]
    .sort((a, b) => b.liquidity + b.volume - (a.liquidity + a.volume))
    .slice(0, 12);

  const options = top.map((market, index) =>
    [
      `${index + 1}. ${market.groupItemTitle || market.question}`,
      `Market ID: ${market.id}`,
      `Analyze: /analyze ${market.id}`,
    ].join("\n")
  );

  return [
    "EVENT DITEMUKAN - PILIH MODE",
    `Event: ${event?.title || "n/a"}`,
    `Pilihan aktif: ${markets.length}`,
    event?.url ? `URL: ${event.url}` : null,
    "",
    "Pilih satu market:",
    ...options,
    "",
    "Atau pilih kandidat paling worth it dari event:",
    `/analyzebest ${source}`,
    "",
    "Atau jelaskan semua pilihan aktif:",
    `/analyzeall ${source}`,
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}

function marketLabel(market) {
  return market.groupItemTitle || market.question;
}

function eventUsageLine(qwenResult) {
  return usageLine(qwenResult);
}

function qwenRankingById(qwenResult) {
  const map = new Map();
  for (const item of qwenResult?.analysis?.ranking || []) {
    map.set(String(item.marketId), item);
  }
  return map;
}

function hardBlockers(score) {
  return (score.blockers || []).filter((item) => item !== "No measured positive edge");
}

function effectiveBestItem(items, qwenResult) {
  const qwenBestId = String(qwenResult?.analysis?.bestMarketId || "");
  const qwenRank = qwenRankingById(qwenResult);
  const qwenBest = items.find((item) => String(item.market.id) === qwenBestId);
  if (qwenBest && hardBlockers(qwenBest.score).length === 0) return qwenBest;

  for (const rank of qwenResult?.analysis?.ranking || []) {
    const item = items.find((row) => String(row.market.id) === String(rank.marketId));
    if (item && hardBlockers(item.score).length === 0) return item;
  }

  const clean = items.filter((item) => hardBlockers(item.score).length === 0);
  if (!clean.length) return null;

  return clean.sort((a, b) => {
    const aRanked = qwenRank.has(String(a.market.id)) ? 1 : 0;
    const bRanked = qwenRank.has(String(b.market.id)) ? 1 : 0;
    if (aRanked !== bRanked) return bRanked - aRanked;

    const aSpread = Number.isFinite(a.score.spreadPercent) ? a.score.spreadPercent : 99;
    const bSpread = Number.isFinite(b.score.spreadPercent) ? b.score.spreadPercent : 99;
    if (aSpread !== bSpread) return aSpread - bSpread;

    return b.market.liquidity + b.market.volume - (a.market.liquidity + a.market.volume);
  })[0];
}

function sortAnalyzedMarkets(items, qwenResult) {
  const bestMarketId = String(effectiveBestItem(items, qwenResult)?.market.id || "");
  const qwenRank = qwenRankingById(qwenResult);

  return [...items].sort((a, b) => {
    if (String(a.market.id) === bestMarketId) return -1;
    if (String(b.market.id) === bestMarketId) return 1;

    const aRanked = qwenRank.has(String(a.market.id)) ? 1 : 0;
    const bRanked = qwenRank.has(String(b.market.id)) ? 1 : 0;
    if (aRanked !== bRanked) return bRanked - aRanked;

    const aOpen = a.market.acceptingOrders ? 1 : 0;
    const bOpen = b.market.acceptingOrders ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;

    const aSpread = Number.isFinite(a.score.spreadPercent) ? a.score.spreadPercent : 99;
    const bSpread = Number.isFinite(b.score.spreadPercent) ? b.score.spreadPercent : 99;
    if (aSpread !== bSpread) return aSpread - bSpread;

    return b.market.liquidity + b.market.volume - (a.market.liquidity + a.market.volume);
  });
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

export function formatAnalysis({ market, score, qwenResult }) {
  const qwen = qwenResult?.analysis || {};
  const verdict = finalVerdict(score, qwen);
  const blockers = score.blockers?.length ? score.blockers.join("; ") : "Tidak ada hard blocker";
  const direction = directionSignal(score);

  return [
    "MARKET SUMMARY",
    `Market: ${market.question}`,
    market.eventTitle && market.eventTitle !== market.question
      ? `Group: ${market.eventTitle}`
      : null,
    market.selectionNote ? `Selection: ${market.selectionNote}` : null,
    `Market ID: ${market.id || "n/a"}`,
    `Status: ${statusLabel(market)}`,
    market.groupItemTitle ? `Variant: ${market.groupItemTitle}` : null,
    `API close/resolution: ${formatDateWib(market.endDate)} WIB`,
    market.url ? `URL: ${market.url}` : null,
    "",
    "KEPUTUSAN ARAH",
    `Dominan: ${direction.side}`,
    `Confidence YES: ${pct(direction.yesConfidence)} | Confidence NO: ${pct(
      direction.noConfidence
    )}`,
    `Gap dominansi: ${points(direction.dominanceGap)} (semakin besar = arah makin tegas)`,
    `Underdog: ${score.underdogScore}/10`,
    "",
    "SNAPSHOT DATA",
    outcomeLine(market),
    `Liquidity: ${money(market.liquidity)}`,
    `Volume: ${money(market.volume)}`,
    `Orderbook YES: bid ${price(score.bestBid)} | ask ${price(score.bestAsk)} | spread ${pct(
      score.spreadPercent
    )}`,
    "",
    "CONFIDENCE & RISK",
    `Data confidence: ${score.confidenceScore}/100 | Qwen confidence: ${qwen.confidence ?? "n/a"}/100`,
    `Risks: liquidity ${score.liquidityRisk}, spread ${score.spreadRisk}, resolution ${score.resolutionRisk}`,
    `Guardrail: ${blockers}`,
    "",
    "ALASAN SINGKAT",
    `Qwen summary: ${qwen.summary || "n/a"}`,
    `Bull point: ${oneLine(qwen.bullishCase)}`,
    `Bear point: ${oneLine(qwen.bearishCase)}`,
    qwen.finalReason ? `Final reason: ${qwen.finalReason}` : null,
    "",
    "FINAL VERDICT",
    verdict,
    `Mechanical: ${score.verdict} | Qwen: ${qwen.verdict || "n/a"}`,
    `Qwen model: ${qwenResult?.model || "n/a"}`,
    usageLine(qwenResult),
    "",
    "Disclaimer: Analisis ini bukan financial advice dan tidak menjamin hasil.",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}

export function formatMarketBubble({ market, score, index, total }) {
  const direction = directionSignal(score);

  return [
    `PILIHAN ${index}/${total}`,
    `Market: ${market.groupItemTitle || market.question}`,
    `Market ID: ${market.id}`,
    `Dominan: ${direction.side}`,
    `Confidence YES: ${pct(direction.yesConfidence)} | NO: ${pct(direction.noConfidence)}`,
    `Gap dominansi: ${points(direction.dominanceGap)}`,
    `Data confidence: ${score.confidenceScore}/100`,
    `Underdog: ${score.underdogScore}/10`,
    `Orderbook YES: bid ${price(score.bestBid)} | ask ${price(score.bestAsk)} | spread ${pct(
      score.spreadPercent
    )}`,
    `Risk: liquidity ${score.liquidityRisk}, spread ${score.spreadRisk}, resolution ${score.resolutionRisk}`,
    `Verdict: ${verdictIcon(score.verdict)} | ${score.verdict}`,
    `Analyze detail: /analyze ${market.id}`,
  ].join("\n");
}

export function formatAnalyzeAllSummary({ event, analyzedMarkets }) {
  const top = [...analyzedMarkets].sort((a, b) => {
    const aBlock = (a.score.blockers || []).length;
    const bBlock = (b.score.blockers || []).length;
    if (aBlock !== bBlock) return aBlock - bBlock;

    const aSpread = Number.isFinite(a.score.spreadPercent) ? a.score.spreadPercent : 99;
    const bSpread = Number.isFinite(b.score.spreadPercent) ? b.score.spreadPercent : 99;
    if (aSpread !== bSpread) return aSpread - bSpread;

    return b.market.liquidity + b.market.volume - (a.market.liquidity + a.market.volume);
  })[0];

  return [
    "SELESAI - SEMUA PILIHAN SUDAH DIJELASKAN",
    `Event: ${event?.title || "n/a"}`,
    `Total pilihan dianalisis: ${analyzedMarkets.length}`,
    top ? `Top monitor saat ini: ${top.market.groupItemTitle || top.market.question} (ID ${top.market.id})` : null,
    top ? `Quick score: confidence ${top.score.confidenceScore}/100, underdog ${top.score.underdogScore}/10, verdict ${top.score.verdict}` : null,
    "",
    "Kalau mau deep dive satu pilihan dengan Qwen lengkap, pakai:",
    top ? `/analyze ${top.market.id}` : "/search <keyword>",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}

export function formatEventAnalysis({ event, analyzedMarkets, qwenResult }) {
  const sorted = sortAnalyzedMarkets(analyzedMarkets, qwenResult);
  const qwenRank = qwenRankingById(qwenResult);
  const best = effectiveBestItem(analyzedMarkets, qwenResult);
  const bestMarketId = String(best?.market.id || "");
  const qwenBestId = String(qwenResult?.analysis?.bestMarketId || "");
  const qwenBestBlocked =
    qwenBestId &&
    bestMarketId &&
    qwenBestId !== bestMarketId
      ? analyzedMarkets.find((item) => String(item.market.id) === qwenBestId)
      : null;

  const rankingLines = sorted.flatMap((item, index) => {
    const market = item.market;
    const score = item.score;
    const qwenItem = qwenRank.get(String(market.id));
    const isBest = String(market.id) === bestMarketId;

    return [
      `${index + 1}. ${isBest ? "BEST WATCH - " : ""}${marketLabel(market)}`,
      `Market ID: ${market.id}`,
      `Question: ${market.question}`,
      outcomeLine(market),
      `Orderbook YES: bid ${price(score.bestBid)} | ask ${price(score.bestAsk)} | spread ${pct(
        score.spreadPercent
      )}`,
      `Liquidity: ${money(market.liquidity)} | Volume: ${money(market.volume)}`,
      `Bot: data confidence ${score.confidenceScore}/100 | underdog ${score.underdogScore}/10 | ${score.verdict}`,
      qwenItem ? `Qwen: ${qwenItem.verdict} - ${qwenItem.reason}` : "Qwen: tidak diranking khusus",
      `Analyze single: /analyze ${market.id}`,
      "",
    ];
  });

  return [
    "EVENT-WIDE ANALYSIS",
    `Event: ${event?.title || "n/a"}`,
    event?.url ? `URL: ${event.url}` : null,
    `Active markets analyzed: ${analyzedMarkets.length}`,
    "",
    "EVENT SUMMARY",
    qwenResult?.analysis?.eventSummary || "n/a",
    "",
    "MOST WORTH WATCHING",
    best
      ? `${marketLabel(best.market)} (Market ID: ${best.market.id})`
      : "Tidak ada kandidat kuat dari data yang tersedia.",
    qwenResult?.analysis?.bestReason ? `Reason: ${qwenResult.analysis.bestReason}` : null,
    qwenBestBlocked
      ? `Guardrail: Qwen top pick diganti karena ${hardBlockers(qwenBestBlocked.score).join("; ")}.`
      : null,
    "",
    "FULL EVENT RANKING",
    ...rankingLines,
    "AVOID / BE CAREFUL",
    ...listLines(qwenResult?.analysis?.avoid),
    "",
    "MISSING DATA BEFORE ENTRY",
    ...listLines(qwenResult?.analysis?.missingData),
    "",
    "FINAL NOTE",
    qwenResult?.analysis?.finalNote || "Ranking ini berbasis market data, bukan jaminan edge.",
    `Qwen model: ${qwenResult?.model || "n/a"}`,
    eventUsageLine(qwenResult),
    "",
    "Disclaimer: Ini bukan financial advice. Untuk event multi-market, ranking berarti watchlist priority, bukan sinyal auto-entry.",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}
