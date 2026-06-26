/**
 * arbitrage.js — Cross-Platform Arbitrage Service
 * Ditiru LANGSUNG dari CloddsBot src/arbitrage/index.ts
 *
 * Deteksi harga berbeda untuk market yang sama di:
 *  - Polymarket (Gamma API — gratis)
 *  - Manifold Markets (API gratis, public)
 *
 * Plus: Internal Arbitrage (YES + NO < 100¢) dari satu platform.
 * Semua endpoint gratis, tidak perlu API key.
 */

import { getCache, setCache } from "./storage.js";
import { config } from "./config.js";

const GAMMA_URL = config.gammaUrl || "https://gamma-api.polymarket.com";
const CLOB_URL = config.clobUrl || "https://clob.polymarket.com";
const MANIFOLD_URL = "https://api.manifold.markets/v0";

// ─── Jaccard similarity (ported from CloddsBot arbitrage/index.ts) ─────────

function questionSimilarity(q1, q2) {
  const normalize = s =>
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(w => w.length > 2);

  const words1 = new Set(normalize(q1));
  const words2 = new Set(normalize(q2));
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ─── Price fetchers ────────────────────────────────────────────────────────

async function fetchPolymarketPrice(tokenId) {
  try {
    const cacheKey = `arb:poly:price:${tokenId}`;
    const cached = getCache(cacheKey, 30);
    if (cached != null) return cached;

    const res = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;

    const data = await res.json();
    const bids = Array.isArray(data.bids) ? data.bids : [];
    const asks = Array.isArray(data.asks) ? data.asks : [];

    const bestBid = bids.map(b => Number(b.price)).filter(isFinite).sort((a, b) => b - a)[0];
    const bestAsk = asks.map(a => Number(a.price)).filter(isFinite).sort((a, b) => a - b)[0];

    if (bestBid == null && bestAsk == null) return null;
    const mid = bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : bestBid ?? bestAsk;

    setCache(cacheKey, mid);
    return mid;
  } catch {
    return null;
  }
}

async function fetchManifoldPrice(question) {
  try {
    const cacheKey = `arb:manifold:search:${question.slice(0, 40)}`;
    const cached = getCache(cacheKey, 120);
    if (cached) return cached;

    const url = `${MANIFOLD_URL}/search-markets?term=${encodeURIComponent(question)}&limit=5`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;

    const markets = await res.json();
    if (!Array.isArray(markets) || !markets.length) return null;

    // Pilih market dengan similarity tertinggi
    let best = null;
    let bestScore = 0;

    for (const m of markets) {
      if (m.isResolved || m.isClosed) continue;
      const score = questionSimilarity(question, m.question);
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }

    if (!best || bestScore < 0.4) return null;

    const result = {
      question: best.question,
      probability: best.probability ?? null,
      volume: best.volume ?? 0,
      id: best.id,
      url: best.url,
      similarity: bestScore,
    };

    setCache(cacheKey, result);
    return result;
  } catch {
    return null;
  }
}

// ─── Internal Arbitrage (YES + NO < 100¢) ─────────────────────────────────

export async function detectInternalArbitrage(markets, { minGap = 0.03 } = {}) {
  const opportunities = [];

  const batchSize = 10;
  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);

    await Promise.all(
      batch.map(async market => {
        try {
          if (!market.clobTokenIds || market.clobTokenIds.length < 2) return;

          const [yesPrice, noPrice] = await Promise.all([
            fetchPolymarketPrice(market.clobTokenIds[0]),
            fetchPolymarketPrice(market.clobTokenIds[1]),
          ]);

          if (yesPrice == null || noPrice == null) return;

          const total = yesPrice + noPrice;
          const gap = 1 - total;

          if (gap >= minGap) {
            opportunities.push({
              type: "internal",
              market_id: market.id,
              question: market.question,
              url: market.url,
              yes_price: yesPrice,
              no_price: noPrice,
              total,
              gap,
              gap_pct: gap * 100,
              // Ported dari CloddsBot opportunity skill: profit = (1/total - 1) * 100
              profit_per_100: (1 / total - 1) * 100,
              score: calculateOpportunityScore({
                edgePct: gap * 100,
                liquidity: market.liquidity,
                confidence: 1.0, // internal arb = 100% match
              }),
            });
          }
        } catch {
          // skip
        }
      })
    );
  }

  return opportunities.sort((a, b) => b.gap_pct - a.gap_pct);
}

// ─── Cross-Platform Arbitrage (Poly vs Manifold) ──────────────────────────

export async function detectCrossPlatformArbitrage(markets, {
  minSpreadPct = 3,
  minSimilarity = 0.85,
} = {}) {
  const opportunities = [];

  for (const market of markets.slice(0, 15)) { // limit untuk performance
    try {
      // Fetch Polymarket YES and NO prices
      if (!market.clobTokenIds?.length || market.clobTokenIds.length < 2) continue;
      const polyYes = await fetchPolymarketPrice(market.clobTokenIds[0]);
      const polyNo = await fetchPolymarketPrice(market.clobTokenIds[1]);
      if (polyYes == null || polyNo == null) continue;

      // Fetch Manifold equivalent
      const manifoldData = await fetchManifoldPrice(market.question);
      if (!manifoldData || manifoldData.probability == null) continue;
      if (manifoldData.similarity < minSimilarity) continue;

      const manifoldYes = manifoldData.probability;
      const manifoldNo = 1 - manifoldData.probability;
      const spread = Math.abs(polyYes - manifoldYes);
      const spreadPct = spread * 100;

      if (spreadPct >= minSpreadPct) {
        const buyPlatform = polyYes < manifoldYes ? "Polymarket" : "Manifold";
        const sellPlatform = polyYes < manifoldYes ? "Manifold" : "Polymarket";
        const buyPrice = Math.min(polyYes, manifoldYes);
        
        // Accurate arbitrage math: buy YES on cheaper platform, buy NO on more expensive platform
        const buyYesCost = polyYes < manifoldYes ? polyYes : manifoldYes;
        const buyNoCost = polyYes < manifoldYes ? manifoldNo : polyNo;
        const totalCost = buyYesCost + buyNoCost;
        
        // Profit per $100 = (Payout / TotalCost) * 100 - 100
        // Payout is always 1.00 (since you hold YES and NO)
        const profitPer100 = totalCost < 1.0 ? (1.0 / totalCost) * 100 - 100 : 0;

        opportunities.push({
          type: "cross_platform",
          question: market.question,
          poly_url: market.url,
          manifold_url: manifoldData.url,
          polyYes,
          polyNo,
          manifoldYes,
          manifoldNo,
          spread,
          spreadPct,
          profitPer100,
          buyPlatform,
          sellPlatform,
          buyPrice,
          matchSimilarity: manifoldData.similarity,
          manifoldQuestion: manifoldData.question,
          score: calculateOpportunityScore({
            edgePct: spreadPct,
            liquidity: market.liquidity,
            confidence: manifoldData.similarity,
          }),
        });
      }
    } catch {
      // skip
    }
  }

  return opportunities.sort((a, b) => b.spreadPct - a.spreadPct);
}

// ─── Full Scanner ──────────────────────────────────────────────────────────

export async function scanAllOpportunities(markets, options = {}) {
  const [internal, crossPlatform] = await Promise.all([
    detectInternalArbitrage(markets, options),
    detectCrossPlatformArbitrage(markets, options),
  ]);

  return {
    internal,
    crossPlatform,
    total: internal.length + crossPlatform.length,
    scannedAt: new Date().toISOString(),
  };
}

// ─── Opportunity Scoring (ported dari CloddsBot opportunity/SKILL.md) ──────

function calculateOpportunityScore({ edgePct, liquidity = 0, confidence = 1 }) {
  // Ported dari CloddsBot opportunity scoring formula:
  // Edge: 35%, Liquidity: 25%, Confidence: 25%, Execution: 15%
  const edgeScore = Math.min(100, edgePct * 10) * 0.35;
  const liqScore = Math.min(100, Math.log10(Math.max(liquidity, 1)) * 20) * 0.25;
  const confScore = confidence * 100 * 0.25;
  const execScore = 70 * 0.15; // assume moderate execution

  let score = edgeScore + liqScore + confScore + execScore;

  // Penalties (dari CloddsBot opportunity SKILL.md)
  if (liquidity < 1000) score -= 5;
  if (confidence < 0.7) score -= 5;

  return Math.round(Math.max(0, Math.min(100, score)));
}

// ─── Formatters ────────────────────────────────────────────────────────────

export function formatOpportunityScan({ internal, crossPlatform, scannedAt }) {
  if (!internal.length && !crossPlatform.length) {
    return `🔍 *Opportunity Scan*\nTidak ditemukan peluang arbitrase saat ini.\n_Scan: ${new Date(scannedAt).toLocaleTimeString("id-ID")}_`;
  }

  let text = `🎯 *Opportunity Scan* — ${new Date(scannedAt).toLocaleTimeString("id-ID")}\n\n`;

  if (internal.length) {
    text += `⚖️ *Internal Arbitrage (${internal.length})*\n`;
    text += `_YES + NO \u003c 100¢ = guaranteed profit_\n\n`;

    for (const opp of internal.slice(0, 5)) {
      const totalC = (opp.total * 100).toFixed(1);
      const profitFmt = opp.profit_per_100.toFixed(2);
      text += `🏆 Score ${opp.score}/100\n`;
      text += `*${opp.question.slice(0, 55)}*\n`;
      text += `YES ${(opp.yes_price * 100).toFixed(1)}¢ + NO ${(opp.no_price * 100).toFixed(1)}¢ = *${totalC}¢*\n`;
      if (opp.profit_per_100 > 0) {
        text += `💰 Profit/\\$100: *\\$${profitFmt}* (gap ${opp.gap_pct.toFixed(2)}%)\n`;
      } else {
        text += `⏳ Peluang Belum Matang (Hanya Watchlist)\n`;
      }
      text += `🔗 [Buka Market](${opp.url})\n\n`;
    }
  }

  if (crossPlatform.length) {
    text += `🔄 *Cross-Platform (${crossPlatform.length})*\n`;
    text += `_Harga berbeda antara Polymarket & Manifold_\n\n`;

    for (const opp of crossPlatform.slice(0, 5)) {
      text += `🏆 Score ${opp.score}/100 | Spread *${opp.spreadPct.toFixed(1)}%*\n`;
      text += `*${opp.question.slice(0, 55)}*\n`;
      text += `🔹 Polymarket: YES ${(opp.polyYes * 100).toFixed(1)}¢ | NO ${(opp.polyNo * 100).toFixed(1)}¢\n`;
      text += `🔸 Manifold: YES ${(opp.manifoldYes * 100).toFixed(1)}¢ | NO ${(opp.manifoldNo * 100).toFixed(1)}¢\n`;
      const buyYesPlatform = opp.buyPlatform;
      const buyNoPlatform = opp.sellPlatform;
      const buyYesPrice = (opp.buyPrice * 100).toFixed(1);
      const buyNoPrice = opp.sellPlatform === "Manifold" ? (opp.manifoldNo * 100).toFixed(1) : (opp.polyNo * 100).toFixed(1);

      text += `📉 Beli YES di ${buyYesPlatform} @ ${buyYesPrice}¢\n`;
      text += `📉 Beli NO di ${buyNoPlatform} @ ${buyNoPrice}¢\n`;
      if (opp.profitPer100 > 0) {
        text += `💰 Profit/\\$100: *\\$${opp.profitPer100.toFixed(2)}*\n`;
      } else {
        text += `⏳ Peluang Belum Matang (Hanya Watchlist)\n`;
      }
      text += `🔗 [Buka Polymarket](${opp.poly_url})\n`;
      text += `🔗 [Buka Manifold](${opp.manifold_url})\n\n`;
    }
  }

  return text.trim();
}

export function formatInternalArbCompact(opportunities) {
  if (!opportunities.length) return null;
  const best = opportunities[0];
  return `⚖️ Internal Arb: YES ${(best.yes_price*100).toFixed(1)}¢ + NO ${(best.no_price*100).toFixed(1)}¢ = ${(best.total*100).toFixed(1)}¢ → profit $${best.profit_per_100.toFixed(2)}/\\$100`;
}
