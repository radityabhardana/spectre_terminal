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

function modelLine(qwenResult) {
  if (qwenResult?.models) {
    return `Qwen pipeline: fast ${qwenResult.models.fast} -> analyst ${qwenResult.models.analyst} -> final ${qwenResult.models.final}`;
  }
  return `Qwen model: ${qwenResult?.model || "n/a"}`;
}

function researchLines(qwenResult) {
  const research = qwenResult?.researchContext;
  if (!research || research.status === "skipped") return [];

  if (research.status === "error" && research.type !== "crypto") {
    return [
      "RESEARCH CONTEXT",
      `Provider: ${research.provider || "n/a"} (error)`,
      `Detected: ${(research.detectedAssets || []).map((asset) => asset.symbol).join(", ") || "n/a"}`,
      `Error: ${research.error || "n/a"}`,
      "",
    ];
  }

  if (research.type === "crypto") {
    return [
      "RESEARCH CONTEXT",
      `Provider: ${research.provider || "n/a"}`,
      `Status: ${research.status || "n/a"}`,
      `Detected: ${(research.detectedAssets || []).map((asset) => asset.symbol).join(", ") || "n/a"}`,
      `Binance Data: ${research.summary || "n/a"}`,
      research.sentimentSummary ? `Sentiment: ${research.sentimentSummary}` : null,
      research.fundamentalSummary ? `Fundamental: ${research.fundamentalSummary}` : null,
      research.newsSummary ? `News/Catalyst: ${research.newsSummary}` : null,
      research.errors?.length ? `Partial errors: ${research.errors.join("; ")}` : null,
      research.fetchedAt ? `Fetched: ${research.fetchedAt}` : null,
      "",
    ].filter((line) => line != null && line !== false);
  }

  if (research.type === "general") {
    return [
      "RESEARCH CONTEXT",
      `Provider: ${research.provider || "n/a"}`,
      `Status: ${research.status || "n/a"}`,
      `Category: General (Non-Crypto)`,
      research.newsSummary ? `News/Catalyst: ${research.newsSummary}` : null,
      research.errors?.length ? `Partial errors: ${research.errors.join("; ")}` : null,
      research.fetchedAt ? `Fetched: ${research.fetchedAt}` : null,
      "",
    ].filter((line) => line != null && line !== false);
  }

  if (research.type === "sports_ufc") {
    return [
      "RESEARCH CONTEXT",
      `Provider: ${research.provider || "n/a"}`,
      `Status: ${research.status || "n/a"}`,
      `Category: Sports / UFC`,
      `Fighters detected: ${(research.fighters || []).map(f => f.fighter || f.name).join(", ") || "n/a"}`,
      `Matchup Stats: ${research.summary || "n/a"}`,
      research.newsSummary ? `News/Catalyst: ${research.newsSummary}` : null,
      research.fetchedAt ? `Fetched: ${research.fetchedAt}` : null,
      "",
    ].filter((line) => line != null && line !== false);
  }

  return [];
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

function entryVerdictMeaning(verdict) {
  if (verdict === "VALUE CANDIDATE") {
    return "ENTRY CANDIDATE - masih wajib cek manual sebelum action.";
  }
  if (verdict === "HIGH RISK UNDERDOG") {
    return "SPECULATIVE WATCH - peluang kecil/underdog, risiko tinggi.";
  }
  if (verdict === "WATCHLIST") {
    return "WATCHLIST - layak dipantau, belum jadi entry bersih.";
  }
  return "SKIP ENTRY - arah boleh dibaca, tapi kondisi entry ditolak.";
}

export function directionSignal(score) {
  const p = Number(score?.marketProbability);
  const primaryLabel = String(score?.primaryOutcomeLabel || "YES").toUpperCase();
  const secondaryLabel = String(score?.secondaryOutcomeLabel || "NO").toUpperCase();
  if (!Number.isFinite(p)) {
    return {
      side: "N/A",
      primaryLabel,
      secondaryLabel,
      yesConfidence: NaN,
      noConfidence: NaN,
      dominanceGap: NaN,
    };
  }

  const yesConfidence = Math.max(0, Math.min(100, p));
  const noConfidence = Math.max(0, Math.min(100, 100 - p));
  const dominanceGap = Math.abs(yesConfidence - noConfidence);

  if (yesConfidence >= noConfidence + 2) {
    return { side: primaryLabel, primaryLabel, secondaryLabel, yesConfidence, noConfidence, dominanceGap };
  }
  if (noConfidence >= yesConfidence + 2) {
    return { side: secondaryLabel, primaryLabel, secondaryLabel, yesConfidence, noConfidence, dominanceGap };
  }
  return { side: "NETRAL", primaryLabel, secondaryLabel, yesConfidence, noConfidence, dominanceGap };
}

function directionStrength(direction) {
  if (!Number.isFinite(direction.dominanceGap)) return "n/a";
  if (direction.dominanceGap >= 35) return "Strong";
  if (direction.dominanceGap >= 15) return "Medium";
  if (direction.dominanceGap >= 5) return "Weak";
  return "Flat";
}

function confidenceText(value) {
  if (value == null || value === "") return "n/a";
  const num = Number(value);
  if (!Number.isFinite(num)) return "n/a";
  return `${Math.round(num)}/100`;
}

function oneLine(list) {
  if (!Array.isArray(list) || !list.length) return "n/a";
  return String(list[0] || "n/a");
}

export function formatHelp() {
  return [
    "Polymarket Analyzer Bot",
    "Version: public-search-v2-event-wide-analysis-v14-top-market-discovery",
    "",
    "Command:",
    "/top [volume|liquidity|new|ending] - lihat market aktif yang lagi top",
    "/search <keyword> - cari market aktif",
    "/analyze <keyword, marketId, atau link Polymarket> - analisis manual dengan Qwen",
    "/quickscan <link/slug event> - scan cepat event tanpa Qwen",
    "/top3 <link/slug event> - tampilkan 3 pilihan teratas tanpa Qwen",
    "/analyzebest <link/slug event> - pilih kandidat paling worth it dari event",
    "/analyzeall <link event Polymarket> - jelaskan semua pilihan aktif satu per satu",
    "/book <tokenId, marketId, atau link Polymarket> - cek orderbook token CLOB",
    "/example - contoh alur pakai bot",
    "",
    "Qwen pipeline: fast scout -> analyst reviewer -> final judge.",
    "Anti-spam aktif: command umum dan command Qwen punya cooldown supaya token/API tidak cepat habis.",
    "Tombol menu akan muncul di bawah chat setelah /start.",
    "Kamu juga bisa kirim link Polymarket, termasuk route kategori seperti /sports/..., atau Market ID langsung untuk dianalisis.",
    "Bot ini hanya analisis, bukan auto-entry.",
  ].join("\n");
}

function topMetricLine(result, market) {
  if (result.mode === "ending") return `Close: ${formatDateWib(market.endDate)} WIB`;
  if (result.mode === "new") return `Start: ${formatDateWib(market.startDate)} WIB`;
  if (result.mode === "liquidity") return `Liquidity: ${money(market.liquidity)}`;
  return `24h volume: ${money(market.volume24hr || market.volume)}`;
}

export function formatTopMarkets(result) {
  const markets = result?.markets || [];
  if (!markets.length) return "Top market tidak ditemukan.";

  const body = markets
    .map((market, index) =>
      [
        `${index + 1}. ${market.question}`,
        market.eventTitle && market.eventTitle !== market.question ? `Event: ${market.eventTitle}` : null,
        `Market ID: ${market.id || "n/a"}`,
        `Status: ${statusLabel(market)}`,
        market.groupItemTitle ? `Variant: ${market.groupItemTitle}` : null,
        outcomeLine(market),
        topMetricLine(result, market),
        `Liquidity: ${money(market.liquidity)} | Gamma volume: ${money(market.volume)} | 24h: ${money(market.volume24hr || market.volume)}`,
        `Analyze: /analyze ${market.id}`,
        market.url ? `URL: ${market.url}` : null,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .join("\n\n");

  return [
    "TOP MARKETS",
    result.title || "Top active markets",
    `Mode: ${result.mode || "volume"}`,
    "",
    body,
    "",
    "Tips: pakai /top liquidity, /top new, atau /top ending untuk mode lain.",
    "Qwen belum dipakai di sini; ini discovery cepat dari Gamma market data.",
  ].join("\n");
}

function verdictIcon(verdict) {
  if (verdict === "VALUE CANDIDATE") return "VALUE";
  if (verdict === "WATCHLIST") return "WATCH";
  if (verdict === "HIGH RISK UNDERDOG") return "UNDERDOG";
  return "SKIP";
}

export function formatEventHubPrompt({ event, markets }) {
  const top = [...markets]
    .sort((a, b) => b.liquidity + b.volume - (a.liquidity + a.volume))
    .slice(0, 8);

  return [
    "EVENT HUB",
    `Event: ${event?.title || "n/a"}`,
    `Pilihan aktif: ${markets.length}`,
    event?.url ? `URL: ${event.url}` : null,
    "",
    "Mode paling ringan:",
    "Quick Scan - ranking cepat tanpa Qwen.",
    "Top 3 - tampilkan 3 pilihan terbaik versi data market.",
    "",
    "Mode deep:",
    "AI Best - Qwen pilih 1 kandidat lalu deep analyze.",
    "Analyze All - kirim 1 bubble per pilihan, pakai kalau memang mau cek semua.",
    "",
    "Pilihan cepat:",
    ...top.map((market, index) =>
      `${index + 1}. ${market.groupItemTitle || market.question} | ID ${market.id}`
    ),
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
        `Liquidity: ${money(m.liquidity)} | Gamma volume: ${money(m.volume)}`,
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
  const strength = directionStrength(direction);

  // Detect market type for context-aware display
  const researchType = qwenResult?.researchContext?.type || "general";
  const isCryptoMarket = researchType === "crypto";
  const isUfcMarket = researchType === "sports_ufc";
  const isShortCrypto = /(bitcoin|btc|ethereum|eth|doge|dogecoin).*up.or.down/i.test(market.question || "");

  // For short crypto markets, derive shown direction from Qwen fairProb (same logic as index.js)
  let shownDirection = direction.side;
  if (isShortCrypto && qwen.estimatedFairProbability != null) {
    const fairProb = Number(qwen.estimatedFairProbability);
    const primaryLabel = String(score?.primaryOutcomeLabel || "UP").toUpperCase();
    const secondaryLabel = String(score?.secondaryOutcomeLabel || "DOWN").toUpperCase();
    if (Number.isFinite(fairProb)) {
      if (fairProb >= 55) shownDirection = primaryLabel;
      else if (fairProb <= 45) shownDirection = secondaryLabel;
      else shownDirection = "NETRAL";
    }
  }

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
    "KESIMPULAN CEPAT",
    `Arah market: ${shownDirection} (${isShortCrypto ? 'dari Qwen RSI/MACD analysis' : strength})`,
    `Entry status: ${entryVerdictMeaning(verdict)}`,
    `Catatan: Arah market = bacaan probabilitas/sentimen. Entry status = layak masuk atau tidak.`,
    "",
    "ARAH MARKET - SCOUTING",
    `Dominan: ${shownDirection}`,
    `Confidence ${direction.primaryLabel}: ${pct(direction.yesConfidence)} | Confidence ${direction.secondaryLabel}: ${pct(
      direction.noConfidence
    )}`,
    `Gap dominansi: ${points(direction.dominanceGap)} (semakin besar = arah makin tegas)`,
    `Underdog: skor ${score.underdogScore}/10 (${score.underdogScore >= 5 ? `${direction.secondaryLabel} = underdog di market ini (probabilitas rendah)` : 'pasar cukup percaya pada ' + direction.side})`,
    "",
    "SNAPSHOT DATA",
    outcomeLine(market),
    `Realtime Ticker: ${score.primaryTokenId}|${score.secondaryTokenId}|${score.primaryOutcomeLabel}|${score.secondaryOutcomeLabel}|${market.question}|${market.endDate}|${market.groupItemTitle || market.eventTitle || ""}`,
    `Liquidity: ${money(market.liquidity)}`,
    `Gamma volume: ${money(market.volume)}`,
    `Orderbook ${direction.primaryLabel}: bid ${price(score.bestBid)} | ask ${price(score.bestAsk)} | spread ${pct(
      score.spreadPercent
    )}`,
    "",
    ...researchLines(qwenResult),
    "CONFIDENCE & RISK",
    `Data confidence: ${confidenceText(score.confidenceScore)} | Qwen confidence: ${confidenceText(qwen.confidence)}`,
    `Risks: liquidity ${score.liquidityRisk}, spread ${score.spreadRisk}, resolution ${score.resolutionRisk}`,
    score.dataWarnings?.length ? `Data warning: ${score.dataWarnings.join("; ")}` : null,
    `Guardrail: ${blockers}`,
    "",
    "ALASAN SINGKAT",
    `Qwen summary: ${qwen.summary || "n/a"}`,
    // Only show fair probability context for crypto markets
    isCryptoMarket && qwen.estimatedFairProbability != null
      ? `Est. Fair Prob: ${qwen.estimatedFairProbability}% | Market Prob: ${score.marketProbability?.toFixed(1) ?? "n/a"}%`
      : null,
    qwen.expectedValueCents != null ? `Expected Value (EV): ${qwen.expectedValueCents.toFixed(2)} cents per share` : null,
    qwen.positionSizePct != null ? `Kelly Sizing Rec: ${qwen.positionSizePct}% of Portfolio` : null,
    `Bull point: ${oneLine(qwen.bullishCase)}`,
    `Bear point: ${oneLine(qwen.bearishCase)}`,
    qwen.finalReason ? `Final reason: ${qwen.finalReason}` : null,
    "",
    "ENTRY VERDICT",
    entryVerdictMeaning(verdict),
    `Mechanical: ${score.verdict} | Qwen: ${qwen.verdict || "n/a"}`,
    modelLine(qwenResult),
    usageLine(qwenResult),
    "",
    "KESIMPULAN AKHIR",
    isShortCrypto && shownDirection !== 'NETRAL' ? `⚡ Mode Short Market: Sinyal arah diprioritaskan (mengabaikan vonis Netral/SKIP).` : null,
    `Hasil Arah: ${shownDirection === 'NETRAL' ? '=' : shownDirection}`,
    `Data Confidence: ${confidenceText(score.confidenceScore)}`,
    `Qwen Confidence: ${confidenceText(qwen.confidence)}`,
    `Kesimpulan Analisis: ${qwen.summary || "n/a"}`,
    "",
    "Disclaimer: Analisis ini bukan financial advice dan tidak menjamin hasil.",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}

export function formatMarketBubble({ market, score, index, total }) {
  const direction = directionSignal(score);
  const strength = directionStrength(direction);

  return [
    `PILIHAN ${index}/${total}`,
    `Market: ${market.groupItemTitle || market.question}`,
    `Market ID: ${market.id}`,
    `Arah market: ${direction.side} (${strength})`,
    `Confidence ${direction.primaryLabel}: ${pct(direction.yesConfidence)} | ${direction.secondaryLabel}: ${pct(direction.noConfidence)}`,
    `Gap dominansi: ${points(direction.dominanceGap)}`,
    `Data confidence: ${score.confidenceScore}/100`,
    score.underdogScore >= 5
      ? `Underdog: skor ${score.underdogScore}/10 → ${direction.secondaryLabel} dianggap underdog oleh market`
      : `Underdog: skor ${score.underdogScore}/10 → ${direction.side} jadi favorit market`,
    `Orderbook ${direction.primaryLabel}: bid ${price(score.bestBid)} | ask ${price(score.bestAsk)} | spread ${pct(
      score.spreadPercent
    )}`,
    `Risk: liquidity ${score.liquidityRisk}, spread ${score.spreadRisk}, resolution ${score.resolutionRisk}`,
    `Entry: ${verdictIcon(score.verdict)} | ${entryVerdictMeaning(score.verdict)}`,
    `Analyze detail: /analyze ${market.id}`,
  ].join("\n");
}

export function formatEventQuickScan({ event, analyzedMarkets, limit = 8 }) {
  const sorted = sortAnalyzedMarkets(analyzedMarkets, null).slice(0, limit);
  const rows = sorted.flatMap((item, index) => {
    const direction = directionSignal(item.score);
    const strength = directionStrength(direction);
    const label = item.market.groupItemTitle || item.market.question;

    return [
      `${index + 1}. ${label}`,
      `Market ID: ${item.market.id}`,
      `Arah: ${direction.side} (${strength}) | ${direction.primaryLabel} ${pct(direction.yesConfidence)} / ${direction.secondaryLabel} ${pct(direction.noConfidence)}`,
      `Entry: ${entryVerdictMeaning(item.score.verdict)}`,
      `Data: confidence ${confidenceText(item.score.confidenceScore)}, underdog skor ${item.score.underdogScore}/10 (${item.score.underdogScore >= 5 ? direction.secondaryLabel + ' underdog' : direction.side + ' favorit'}), spread ${pct(item.score.spreadPercent)}`,
      `Analyze detail: /analyze ${item.market.id}`,
      "",
    ];
  });

  return [
    "QUICK EVENT SCAN",
    `Event: ${event?.title || "n/a"}`,
    `Market dicek: ${analyzedMarkets.length}`,
    `Ditampilkan: top ${sorted.length}`,
    "",
    ...rows,
    "Catatan: Quick Scan tidak memakai Qwen. Ini ranking cepat dari orderbook, spread, liquidity, dan implied probability.",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
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
      `Orderbook ${String(score.primaryOutcomeLabel || "YES").toUpperCase()}: bid ${price(score.bestBid)} | ask ${price(score.bestAsk)} | spread ${pct(
        score.spreadPercent
      )}`,
      `Liquidity: ${money(market.liquidity)} | Gamma volume: ${money(market.volume)}`,
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
    ...researchLines(qwenResult),
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
    modelLine(qwenResult),
    eventUsageLine(qwenResult),
    "",
    "Disclaimer: Ini bukan financial advice. Untuk event multi-market, ranking berarti watchlist priority, bukan sinyal auto-entry.",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}

export function formatShortCondition({ techData, longShort, fearGreed, evaluation }) {
  const rec     = (evaluation.recommendation || "AVOID").toUpperCase();
  const dir     = (evaluation.direction || "NEUTRAL").toUpperCase();
  const cond    = (evaluation.condition || "UNKNOWN").toUpperCase();
  const recIcon = rec === "PLAY" ? "PLAY" : "AVOID";
  const dirIcon = dir === "UP" ? "UP" : dir === "DOWN" ? "DOWN" : "NEUTRAL";
  const sigs    = evaluation.key_signals || {};
  const td      = techData || {};
  const conf    = evaluation.confidence ? `${evaluation.confidence}/100` : "n/a";

  return [
    "SHORT MARKET VIBE CHECK",
    `${recIcon} | ARAH: ${dirIcon} | Confidence: ${conf}`,
    `Kondisi: ${cond}   Sentimen: ${evaluation.sentiment || "N/A"}`,
    "",
    "── INDIKATOR TEKNIKAL ──────────────────────────",
    td.currentPrice   ? `Harga: $${td.currentPrice} (24h: ${td.priceChange24h}%)` : null,
    td.rsi14 != null  ? `RSI-14: ${td.rsi14} → ${td.rsiSignal}` : null,
    td.macd           ? `MACD: Line:${td.macd.line} Signal:${td.macd.signal} Hist:${td.macd.histogram} → ${td.macd.trend}` : null,
    td.volumeRatio    ? `Volume Ratio: ${td.volumeRatio}x → ${td.volumeSignal}` : null,
    td.recentCandles  ? `Candles (5m): ${td.recentCandles.map(c => c.direction === "UP" ? "UP" : "DN").join(" ")}` : null,
    "",
    "── SENTIMEN & POSITIONING ──────────────────────",
    longShort
      ? `L/S Ratio: ${longShort.ratio} (Long:${longShort.longPct}% Short:${longShort.shortPct}%) → ${longShort.bias}`
      : "L/S Ratio: unavailable",
    fearGreed ? `Fear & Greed: ${fearGreed.value}/100 → ${fearGreed.label}` : "Fear & Greed: unavailable",
    "",
    "── SIGNAL ALIGNMENT ───────────────────────────",
    sigs.rsi_verdict      ? `RSI:     ${sigs.rsi_verdict}` : null,
    sigs.macd_verdict     ? `MACD:    ${sigs.macd_verdict}` : null,
    sigs.volume_verdict   ? `Volume:  ${sigs.volume_verdict}` : null,
    sigs.futures_verdict  ? `Futures: ${sigs.futures_verdict}` : null,
    sigs.alignment_score  ? `Overall: ${sigs.alignment_score}` : null,
    "",
    "── AI ANALYSIS ────────────────────────────────",
    evaluation.reason || "n/a",
    evaluation.risk_warning ? `\nRISK WARNING: ${evaluation.risk_warning}` : null,
    "",
    "Disclaimer: Ini bukan financial advice. Kondisi pasar bisa berubah dalam detik.",
  ]
    .filter((line) => line != null && line !== false)
    .join("\n");
}
