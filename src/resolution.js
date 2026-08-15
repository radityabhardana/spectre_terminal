import { ANALYSIS_STRATEGY_VERSION, getAnalyzedEventById, getUnresolvedAnalyzedEvents, updateAnalyzedEventStatus } from "./storage.js";
import { getMarketById } from "./polymarket.js";

const NEUTRAL_PREDICTIONS = new Set(["=", "SKIP", "NETRAL", "WATCHLIST"]);

export function winningOutcomeForMarket(market) {
  if (!market?.closed || !Array.isArray(market.outcomes) || !Array.isArray(market.outcomePrices)) return null;
  const prices = market.outcomePrices.map(Number);
  const winners = prices
    .map((price, index) => ({ price, index }))
    .filter(({ price }) => Number.isFinite(price) && price >= 0.99);
  if (winners.length !== 1) return null;
  const winnerIndex = winners[0].index;
  if (!prices.every((price, index) => index === winnerIndex || (Number.isFinite(price) && price <= 0.01))) return null;
  return market.outcomes[winnerIndex] || null;
}

export function classifyOutcome(event, winningOutcome) {
  const prediction = String(event?.prediction || "").trim().toUpperCase();
  const outcome = String(winningOutcome || "").trim().toUpperCase();
  if (NEUTRAL_PREDICTIONS.has(prediction)) return "netral";
  if (prediction && prediction === outcome) return "menang";
  if (event?.strategy_version !== ANALYSIS_STRATEGY_VERSION) {
    const legacyMatch = (prediction === "UP" && outcome === "YES")
      || (prediction === "YES" && outcome === "UP")
      || (prediction === "DOWN" && outcome === "NO")
      || (prediction === "NO" && outcome === "DOWN");
    if (legacyMatch) return "menang";
  }
  return "kalah";
}

export async function resolveAnalyzedEvent(event, { market = null, signal = null } = {}) {
  if (!event) return { ok: false, status: 404, error: "Event tidak ditemukan." };
  const resolvedMarket = market || await getMarketById(event.market_id, true, signal);
  if (!resolvedMarket) return { ok: false, status: 404, error: "Data market Polymarket tidak ditemukan." };
  const actualOutcome = winningOutcomeForMarket(resolvedMarket);
  if (!actualOutcome) {
    return { ok: true, status: "belum selesai", result: null, actualOutcome: null, market: resolvedMarket };
  }
  const result = classifyOutcome(event, actualOutcome);
  updateAnalyzedEventStatus(event.id, "selesai", result, actualOutcome);
  return { ok: true, status: "selesai", result, actualOutcome, market: resolvedMarket };
}

export async function resolveAnalyzedEventById(eventId, { signal = null } = {}) {
  return resolveAnalyzedEvent(getAnalyzedEventById(eventId), { signal });
}

export async function resolvePendingEvents({ signal = null } = {}) {
  const unresolved = getUnresolvedAnalyzedEvents();
  if (!unresolved.length) return "Semua hasil analisis sudah terselesaikan atau belum ada history.";

  const lines = ["Mengecek Market Terselesaikan", ""];
  let resolvedCount = 0;
  for (const event of unresolved) {
    if (signal?.aborted) break;
    try {
      const result = await resolveAnalyzedEvent(event, { signal });
      if (result.status !== "selesai") continue;
      resolvedCount += 1;
      lines.push(`Market: ${result.market.question}`);
      lines.push(`Prediksi: ${event.prediction} | Hasil: ${result.actualOutcome} | Status: ${result.result.toUpperCase()}`, "");
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      console.error(`[Resolution] Failed market ${event.market_id}:`, error.message);
    }
  }
  return resolvedCount ? lines.join("\n").trim() : "Belum ada market dengan hasil resmi yang final.";
}
