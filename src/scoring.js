function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function bestBidAsk(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids
    .map((x) => numberOrNull(x.price))
    .filter((x) => x != null && x >= 0 && x <= 1)
    .sort((a, b) => b - a)[0];
  const bestAsk = asks
    .map((x) => numberOrNull(x.price))
    .filter((x) => x != null && x >= 0 && x <= 1)
    .sort((a, b) => a - b)[0];

  let totalBidVolume = 0;
  for (const b of bids) {
    const price = numberOrNull(b.price);
    const size = numberOrNull(b.size);
    if (price != null && price >= 0 && price <= 1 && size != null && size >= 0) totalBidVolume += price * size;
  }

  let totalAskVolume = 0;
  for (const a of asks) {
    const price = numberOrNull(a.price);
    const size = numberOrNull(a.size);
    if (price != null && price >= 0 && price <= 1 && size != null && size >= 0) totalAskVolume += price * size;
  }

  const orderbookImbalance = (totalBidVolume + totalAskVolume > 0)
    ? (totalBidVolume / (totalBidVolume + totalAskVolume)) * 100
    : 50; // default neutral 50%

  return { bestBid, bestAsk, orderbookImbalance, totalBidVolume, totalAskVolume };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function riskFromScore(score) {
  if (score >= 75) return "Low";
  if (score >= 45) return "Medium";
  return "High";
}

export function scoreMarket({ market, yesBook }) {
  const { bestBid, bestAsk, orderbookImbalance, totalBidVolume, totalAskVolume } = bestBidAsk(yesBook);
  const hasTwoSidedBook = bestBid != null && bestAsk != null && bestBid < bestAsk;
  const midpoint =
    hasTwoSidedBook
      ? (bestBid + bestAsk) / 2
      : numberOrNull(market.outcomePrices[0]);

  const marketProbability = midpoint != null ? midpoint * 100 : null;
  const spread = hasTwoSidedBook ? bestAsk - bestBid : null;
  const spreadPercent = spread != null ? spread * 100 : null;

  const liquidityScore = clamp(Math.log10(Math.max(market.liquidity, 1)) * 20, 0, 100);
  const spreadScore =
    spreadPercent == null ? 35 : clamp(100 - spreadPercent * 10, 0, 100);
  const dataCompletenessScore = clamp(
    [
      market.question,
      market.endDate,
      market.description,
      market.clobTokenIds.length,
      yesBook?.bids?.length,
      yesBook?.asks?.length,
    ].filter(Boolean).length * 16.7,
    0,
    100
  );
  const rulesClarityScore = market.description.length > 120 ? 70 : 45;
  const catalystScore = market.endDate ? 55 : 30;

  const confidenceScore = Math.round(
    dataCompletenessScore * 0.25 +
      liquidityScore * 0.2 +
      spreadScore * 0.2 +
      rulesClarityScore * 0.2 +
      catalystScore * 0.15
  );

  const liquidityRisk = riskFromScore(liquidityScore);
  const spreadRisk = riskFromScore(spreadScore);
  const resolutionRisk = rulesClarityScore >= 65 ? "Medium" : "High";

  // No external fair-value model exists yet, so default to market probability.
  // This prevents the bot from inventing a positive edge from formatting rules.
  const estimatedFairProbability = marketProbability;
  const edgeScore =
    estimatedFairProbability != null && marketProbability != null
      ? estimatedFairProbability - marketProbability
      : null;

  const underdogBase =
    marketProbability != null && marketProbability <= 35
      ? clamp((35 - marketProbability) / 35 * 100, 0, 100)
      : 0;
  const underdogScore = Number(
    (
      (underdogBase * 0.25 +
        Math.max(edgeScore || 0, 0) * 3 +
        liquidityScore * 0.15 +
        catalystScore * 0.15 +
        (100 - (resolutionRisk === "High" ? 70 : 35)) * 0.15) /
      10
    ).toFixed(1)
  );

  const blockers = [];
  if (market.closed) blockers.push("Market closed");
  if (!market.acceptingOrders) blockers.push("Orders not clearly open");
  if (!hasTwoSidedBook) blockers.push("Orderbook is not two-sided");
  if (spreadRisk === "High") blockers.push("Spread risk high");
  if (resolutionRisk === "High") blockers.push("Resolution risk high");
  if (edgeScore == null || edgeScore <= 0) blockers.push("No measured positive edge");

  let verdict = "SKIP";
  if (
    market.active &&
    !market.closed &&
    confidenceScore >= 65 &&
    spreadRisk !== "High" &&
    resolutionRisk !== "High"
  ) {
    verdict = "WATCHLIST";
  }
  if (
    edgeScore != null &&
    edgeScore >= 8 &&
    confidenceScore >= 70 &&
    spreadRisk !== "High" &&
    resolutionRisk !== "High"
  ) {
    verdict = "VALUE CANDIDATE";
  }
  if (
    marketProbability != null &&
    marketProbability <= 25 &&
    confidenceScore >= 55 &&
    spreadRisk !== "High"
  ) {
    verdict = "HIGH RISK UNDERDOG";
  }
  if (market.closed || !market.acceptingOrders) verdict = "SKIP";

  return {
    bestBid,
    bestAsk,
    hasTwoSidedBook,
    spread,
    spreadPercent,
    marketProbability,
    estimatedFairProbability,
    edgeScore,
    confidenceScore,
    underdogScore,
    orderbookImbalance,
    totalBidVolume,
    totalAskVolume,
    liquidityRisk,
    spreadRisk,
    resolutionRisk,
    blockers,
    verdict,
  };
}
