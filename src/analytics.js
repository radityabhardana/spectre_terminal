import Database from "better-sqlite3";
import { databasePath } from "./database-path.js";

const db = new Database(databasePath);
export { databasePath };

export function getShadowTrades({ days = 30 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return db.prepare(`
      SELECT * FROM analyzed_events
      WHERE created_at >= ?
      ORDER BY created_at DESC
    `).all(since);
  } catch {
    return [];
  }
}

export function calculateKelly({
  edge,
  confidence,
  bankroll = 1000,
  recentTrades = [],
  baseMultiplier = 0.25,
} = {}) {
  const p = Math.min(0.95, Math.max(0.05, 0.5 + edge / 2));
  const q = 1 - p;
  const fullKelly = Math.max(0, p - q);

  const adjustments = [];
  let kelly = fullKelly * baseMultiplier;
  adjustments.push({ type: "base", multiplier: baseMultiplier, reason: `Quarter Kelly (${(baseMultiplier * 100).toFixed(0)}%)` });

  const confidenceFactor = (confidence || 50) / 100;
  kelly *= confidenceFactor;
  adjustments.push({ type: "confidence", multiplier: confidenceFactor, reason: `Confidence ${confidence}%` });

  const resolved = recentTrades.filter(t => ["menang", "kalah"].includes(String(t.result || "").toLowerCase()));
  const drawdown = calculateDrawdown(resolved);
  if (drawdown > 0.05) {
    const drawdownFactor = Math.max(0.5, 1 - drawdown * 3);
    kelly *= drawdownFactor;
    adjustments.push({ type: "drawdown", multiplier: drawdownFactor, reason: `Drawdown ${(drawdown * 100).toFixed(1)}%` });
  }

  const streak = getCurrentStreak(resolved);
  if (streak.type === "loss" && streak.count >= 2) {
    const lossFactor = Math.max(0.5, 1 - streak.count * 0.1);
    kelly *= lossFactor;
    adjustments.push({ type: "loss_streak", multiplier: lossFactor, reason: `Loss streak (${streak.count})` });
  }
  if (streak.type === "win" && streak.count >= 3) {
    const winFactor = Math.min(1.25, 1 + streak.count * 0.05);
    kelly *= winFactor;
    adjustments.push({ type: "win_streak", multiplier: winFactor, reason: `Win streak (${streak.count})` });
  }

  if (resolved.length < 10) {
    const sampleFactor = 0.5 + (resolved.length / 10) * 0.5;
    kelly *= sampleFactor;
    adjustments.push({ type: "sample_size", multiplier: sampleFactor, reason: `Hanya ${resolved.length} data historis` });
  }

  kelly = Math.max(0, Math.min(0.25, kelly));

  return {
    kelly: Math.round(kelly * 10000) / 10000,
    kellyPct: (kelly * 100).toFixed(1),
    positionSize: Math.round(bankroll * kelly * 100) / 100,
    bankroll,
    adjustments,
    risk: { drawdown, streak },
  };
}

export function formatKellyResult(kellyResult) {
  const { kelly, kellyPct, positionSize, bankroll, adjustments, risk } = kellyResult;

  let text = `📐 *Kelly Position Sizing*\n\n`;
  text += `💰 *Modal:* $${bankroll.toLocaleString()}\n`;
  text += `🎯 *Kelly Fraction:* ${kellyPct}%\n`;
  text += `📊 *Ukuran Bet:* $${positionSize.toFixed(2)}\n\n`;

  text += `*Faktor Penyesuaian:*\n`;
  for (const adj of adjustments) {
    const mult = (adj.multiplier * 100).toFixed(0) + "%";
    text += `  • ${adj.reason}: ×${mult}\n`;
  }

  if (risk.drawdown > 0) {
    text += `\n⚠️ *Drawdown saat ini:* ${(risk.drawdown * 100).toFixed(1)}%\n`;
  }
  if (risk.streak.count > 0) {
    const streakEmoji = risk.streak.type === "win" ? "🔥" : "❄️";
    text += `${streakEmoji} *Streak:* ${risk.streak.type} ${risk.streak.count}x\n`;
  }

  return text.trim();
}

function calculateDrawdown(trades) {
  const resolved = trades.filter(t => ["menang", "kalah"].includes(String(t.result || "").toLowerCase()));
  if (!resolved.length) return 0;

  let capital = 1000;
  let peak = 1000;
  let maxDD = 0;

  for (const t of resolved) {
    capital = t.result?.toLowerCase() === "menang" ? capital * 1.05 : capital * 0.95;
    if (capital > peak) peak = capital;
    const dd = (peak - capital) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD;
}

function getCurrentStreak(trades) {
  const sorted = trades
    .filter(t => ["menang", "kalah"].includes(String(t.result || "").toLowerCase()))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!sorted.length) return { type: "none", count: 0 };

  const first = sorted[0].result;
  let count = 0;
  for (const t of sorted) {
    if (t.result === first) count++;
    else break;
  }

  return { type: first?.toLowerCase() === "menang" ? "win" : "loss", count };
}
