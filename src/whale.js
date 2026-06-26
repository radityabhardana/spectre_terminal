/**
 * whale.js — Whale Tracking & Internal Arbitrage Scanner
 * Ditiru dari CloddsBot:
 *   - src/skills/bundled/whale-tracking/
 *   - src/skills/bundled/opportunity/ (internal arb detection)
 *   - src/arbitrage/index.ts
 *
 * Semua endpoint yang dipakai: Polymarket CLOB & Gamma — gratis, public.
 * Tidak perlu API key apapun.
 */

import { getCache, setCache } from "./storage.js";
import { config } from "./config.js";
import { ethers } from "ethers";
import { ClobClient } from "@polymarket/clob-client";

const CLOB_URL = config.clobUrl || "https://clob.polymarket.com";
const GAMMA_URL = config.gammaUrl || "https://gamma-api.polymarket.com";

// Auto-generated API client for Whale Tracker
let clobClientInstance = null;

async function getClobClient() {
  if (clobClientInstance) return clobClientInstance;
  try {
    const wallet = ethers.Wallet.createRandom();
    const tempClient = new ClobClient(CLOB_URL, 137, wallet);
    const creds = await tempClient.createApiKey();
    clobClientInstance = new ClobClient(CLOB_URL, 137, wallet, creds);
    console.log("✅ [WhaleTracker] Auto-generated stealth API credentials.");
    return clobClientInstance;
  } catch (e) {
    console.error("❌ [WhaleTracker] Failed to auto-generate API key:", e.message);
    return null;
  }
}

// ─── Internal Arbitrage (YES + NO < 1) ────────────────────────────────────

/**
 * Cek internal arbitrage: kalau YES price + NO price < threshold,
 * berarti ada guaranteed profit peluang.
 *
 * Ported dari CloddsBot opportunity skill — "Internal" type arbitrage.
 */
export async function scanInternalArbitrage({ markets, minGap = 0.03 } = {}) {
  const opportunities = [];

  for (const market of markets) {
    try {
      if (!market.clobTokenIds || market.clobTokenIds.length < 2) continue;

      const [yesTokenId, noTokenId] = market.clobTokenIds;

      const [yesBook, noBook] = await Promise.all([
        fetchBook(yesTokenId),
        fetchBook(noTokenId),
      ]);

      const yesMid = getMidPrice(yesBook);
      const noMid = getMidPrice(noBook);

      if (yesMid == null || noMid == null) continue;

      const total = yesMid + noMid;
      const gap = 1 - total; // kalau positif = ada peluang

      if (gap >= minGap) {
        opportunities.push({
          type: "internal_arb",
          market_id: market.id,
          question: market.question,
          url: market.url,
          yes_price: yesMid,
          no_price: noMid,
          total,
          gap,
          gap_pct: (gap * 100).toFixed(2),
          // Profit per $100: beli YES + NO = total * 100, dapat $100 saat resolved
          profit_per_100: ((1 / total - 1) * 100).toFixed(2),
        });
      }
    } catch {
      // skip market yang error
    }
  }

  return opportunities.sort((a, b) => b.gap - a.gap);
}

// ─── Whale Tracker ─────────────────────────────────────────────────────────

/**
 * Ambil trade terbaru dari CLOB API dan filter berdasarkan ukuran minimum.
 * Ported dari CloddsBot whale-tracking skill (versi polling, bukan WebSocket).
 */
export async function fetchWhaleTradesForMarket(conditionId, { minSizeUsdc = 500, limit = 100 } = {}) {
  try {
    const cacheKey = `whale:trades:${conditionId}:${limit}`;
    const cached = getCache(cacheKey, 60); // cache 60 detik
    if (cached) return cached;

    const client = await getClobClient();
    if (!client) return [];

    const data = await client.getTrades({ market: conditionId });
    const trades = Array.isArray(data) ? data : (data.data ?? data.trades ?? []);

    const whales = trades
      .map(t => {
        const price = Number(t.price ?? t.matchedPrice ?? 0);
        const size = Number(t.size ?? t.matchedSize ?? 0);
        const sizeUsdc = price * size;
        return {
          id: t.id || t.tradeId || t.transaction_hash,
          side: t.side ?? t.takerSide ?? "UNKNOWN",
          price,
          size,
          sizeUsdc,
          timestamp: t.timestamp ?? t.createdAt ?? "",
          maker: t.makerAddress ?? t.maker ?? "",
          taker: t.takerAddress ?? t.taker ?? "",
        };
      })
      .filter(t => t.sizeUsdc >= minSizeUsdc)
      .sort((a, b) => b.sizeUsdc - a.sizeUsdc);

    setCache(cacheKey, whales);
    return whales;
  } catch(e) {
    console.error(`Error fetchWhaleTradesForMarket:`, e.message);
    return [];
  }
}

/**
 * Scan whale trades dari beberapa top markets sekaligus.
 */
export async function scanWhaleActivity({ markets, minSizeUsdc = 500, limit = 50 } = {}) {
  const allWhales = [];

  for (const market of markets.slice(0, 50)) { // max 50 markets
    const conditionId = market.conditionId || market.id;
    if (!conditionId) continue;

    const trades = await fetchWhaleTradesForMarket(conditionId, { minSizeUsdc, limit });
    for (const t of trades) {
      allWhales.push({
        ...t,
        market_id: market.id,
        market_question: market.question,
        market_url: market.url,
      });
    }
  }

  return allWhales.sort((a, b) => b.sizeUsdc - a.sizeUsdc);
}

/**
 * Ambil profil whale (top traders) dari Polymarket Leaderboard.
 * Ported dari CloddsBot copy-trading skill — findBestAddressesToCopy.
 */
export async function fetchTopTraders({ limit = 10, minVolume = 10000 } = {}) {
  try {
    const cacheKey = `whale:toptraders:${limit}`;
    const cached = getCache(cacheKey, 3600); // cache 1 jam
    if (cached) return cached;

    // Polymarket CLOB leaderboard endpoint (public)
    const url = `${CLOB_URL}/leaderboard?limit=${limit}&sort=volume&order=desc`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];

    const data = await res.json();
    const traders = Array.isArray(data) ? data : (data.data ?? []);

    const result = traders
      .filter(t => Number(t.volume ?? t.totalVolume ?? 0) >= minVolume)
      .map(t => ({
        address: t.address ?? t.walletAddress ?? "",
        volume: Number(t.volume ?? t.totalVolume ?? 0),
        pnl: Number(t.pnl ?? t.realizedPnl ?? 0),
        winRate: Number(t.winRate ?? t.win_rate ?? 0),
        tradeCount: Number(t.tradeCount ?? t.trades ?? 0),
      }))
      .slice(0, limit);

    setCache(cacheKey, result);
    return result;
  } catch {
    return [];
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function fetchBook(tokenId) {
  try {
    const url = `${CLOB_URL}/book?token_id=${tokenId}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function getMidPrice(book) {
  if (!book) return null;
  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];

  const bestBid = bids.map(b => Number(b.price)).filter(isFinite).sort((a, b) => b - a)[0];
  const bestAsk = asks.map(a => Number(a.price)).filter(isFinite).sort((a, b) => a - b)[0];

  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  return bestBid ?? bestAsk ?? null;
}

// ─── Formatters ────────────────────────────────────────────────────────────

export function formatInternalArbitrageResults(opportunities) {
  if (!opportunities.length) return "✅ Tidak ditemukan internal arbitrage saat ini.";

  let text = `⚖️ *Internal Arbitrage Detected (${opportunities.length})*\n`;
  text += `_YES + NO \u003c 100¢ = guaranteed profit_\n\n`;

  for (const opp of opportunities.slice(0, 10)) {
    const totalCents = (opp.total * 100).toFixed(1);
    const yesCents = (opp.yes_price * 100).toFixed(1);
    const noCents = (opp.no_price * 100).toFixed(1);

    text += `🎯 *${opp.question.slice(0, 60)}*\n`;
    text += `  YES: ${yesCents}¢ + NO: ${noCents}¢ = *${totalCents}¢* (gap: ${opp.gap_pct}%)\n`;
    text += `  💰 Profit per $100 bet: $${opp.profit_per_100}\n`;
    text += `  🔗 [Market](${opp.url})\n\n`;
  }

  return text.trim();
}

export function formatWhaleResults(whales, minSizeUsdc = 500) {
  if (!whales.length) return `🐋 Tidak ada whale trade ≥ $${minSizeUsdc.toLocaleString()} ditemukan.`;

  let text = `🐋 *Whale Activity* (≥ $${minSizeUsdc.toLocaleString()})\n\n`;

  for (const w of whales.slice(0, 15)) {
    const side = w.side?.toLowerCase();
    const emoji = side === "buy" ? "🟢 BUY" : side === "sell" ? "🔴 SELL" : "⚪ ?";
    const price = (w.price * 100).toFixed(1) + "¢";
    const size = "$" + w.sizeUsdc.toFixed(0);

    text += `${emoji} *${size}* @ ${price}\n`;
    text += `  📊 ${w.market_question?.slice(0, 55)}\n`;
    if (w.taker) text += `  👤 \`${w.taker.slice(0, 10)}...\`\n`;
    text += "\n";
  }

  return text.trim();
}

export function formatTopTraders(traders) {
  if (!traders.length) return "📭 Data top traders tidak tersedia.";

  let text = `🏆 *Top Polymarket Traders*\n\n`;
  traders.slice(0, 10).forEach((t, i) => {
    const vol = "$" + (t.volume / 1000).toFixed(0) + "K";
    const pnl = (t.pnl >= 0 ? "+" : "") + "$" + (t.pnl / 1000).toFixed(1) + "K";
    const wr = t.winRate ? (t.winRate * 100).toFixed(0) + "%" : "N/A";

    text += `${i + 1}. \`${t.address?.slice(0, 12)}...\`\n`;
    text += `   Vol: ${vol} | PnL: ${pnl} | WR: ${wr}\n\n`;
  });

  return text.trim();
}
