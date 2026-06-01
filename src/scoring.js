function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function bestBidAsk(book) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];

  const bestBid = bids
    .map((x) => numberOrNull(x.price))
    .filter((x) => x != null)
    .sort((a, b) => b - a)[0];
  const bestAsk = asks
    .map((x) => numberOrNull(x.price))
    .filter((x) => x != null)
    .sort((a, b) => a - b)[0];

  return { bestBid, bestAsk };
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
  const { bestBid, bestAsk } = bestBidAsk(yesBook);
  const midpoint =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : numberOrNull(market.outcomePrices[0]);

  const marketProbability = midpoint != null ? midpoint * 100 : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
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

  let verdict = "SKIP";
  if (confidenceScore >= 70 && spreadRisk !== "High" && resolutionRisk !== "High") {
    verdict = "WATCHLIST";
  }
  if (marketProbability != null && marketProbability <= 25 && confidenceScore >= 55) {
    verdict = "HIGH RISK UNDERDOG";
  }

  return {
    bestBid,
    bestAsk,
    spread,
    spreadPercent,
    marketProbability,
    estimatedFairProbability,
    edgeScore,
    confidenceScore,
    underdogScore,
    liquidityRisk,
    spreadRisk,
    resolutionRisk,
    verdict,
  };
}
