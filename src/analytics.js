/**
 * analytics.js — Performance Analytics & Backtest Engine
 * Ditiru dari CloddsBot:
 *   - src/skills/bundled/analytics/
 *   - src/skills/bundled/backtest/
 *   - src/skills/bundled/metrics/
 *   - src/trading/kelly.ts
 *
 * Semua data diambil dari SQLite local — 0 biaya API.
 */

import Database from "better-sqlite3";
import path from "node:path";

const db = new Database(path.join(process.cwd(), "data", "database.db"));

// ─── Shadow Bot Stats ──────────────────────────────────────────────────────

/**
 * Ambil semua shadow trades dari DB.
 * Ported dari CloddsBot analytics skill — getSummary().
 */
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

// ─── Performance Metrics ────────────────────────────────────────────────────

/**
 * Hitung performance metrics dari historis analisis.
 * Ported dari CloddsBot analytics + backtest skills.
 */
export function calculatePerformanceMetrics(trades) {
  const resolved = trades.filter(t => t.status !== "belum selesai");
  const total = resolved.length;

  if (total === 0) {
    return {
      total: 0,
      resolved: 0,
      winRate: null,
      lossRate: null,
      avgConfidence: null,
      sharpeRatio: null,
      maxStreak: { wins: 0, losses: 0 },
      byCategory: {},
    };
  }

  const wins = resolved.filter(t => t.result?.toLowerCase() === "menang").length;
  const losses = resolved.filter(t => t.result?.toLowerCase() === "kalah").length;
  const winRate = wins / total;
  const lossRate = losses / total;

  // Confidence average dari qwen_confidence field
  const confidenceValues = resolved
    .map(t => parseConfidence(t.qwen_confidence))
    .filter(v => v != null);
  const avgConfidence = confidenceValues.length > 0
    ? confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length
    : null;

  // Streak calculation (ported dari CloddsBot kelly.ts recordTrade logic)
  let currentWinStreak = 0;
  let currentLossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  const chronological = [...resolved].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const t of chronological) {
    if (t.result?.toLowerCase() === "menang") {
      currentWinStreak++;
      currentLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    } else if (t.result?.toLowerCase() === "kalah") {
      currentLossStreak++;
      currentWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    }
  }

  // Sharpe Ratio (simplified — menggunakan win/loss sebagai return stream)
  // Diasumsikan: menang = +1, kalah = -1 (binary)
  const returns = chronological.map(t => t.result?.toLowerCase() === "menang" ? 1 : -1);
  const sharpeRatio = calculateSharpe(returns);

  // By category (dari question text, keyword matching)
  const byCategory = groupByCategory(resolved);

  return {
    total,
    resolved,
    totalAll: trades.length,
    pending: trades.length - total,
    wins,
    losses,
    winRate: winRate * 100,
    lossRate: lossRate * 100,
    avgConfidence,
    sharpeRatio,
    maxStreak: { wins: maxWinStreak, losses: maxLossStreak },
    byCategory,
  };
}

// ─── Kelly Criterion ────────────────────────────────────────────────────────

/**
 * Dynamic Kelly Criterion — ditiru PENUH dari CloddsBot src/trading/kelly.ts
 * Hitung ukuran bet optimal berdasarkan edge, confidence, dan historis performa.
 */
export function calculateKelly({
  edge,                  // 0-1, selisih fair value vs market price
  confidence,            // 0-100, dari scoring.js
  bankroll = 1000,       // modal simulasi
  recentTrades = [],     // dari getShadowTrades()
  baseMultiplier = 0.25, // quarter Kelly (konservatif)
} = {}) {
  // 1. Full Kelly: f = (p*b - q) / b, binary market b=1
  const p = Math.min(0.95, Math.max(0.05, 0.5 + edge / 2));
  const q = 1 - p;
  const fullKelly = Math.max(0, p - q); // simplified for b=1

  const adjustments = [];
  let kelly = fullKelly * baseMultiplier;
  adjustments.push({ type: "base", multiplier: baseMultiplier, reason: `Quarter Kelly (${(baseMultiplier * 100).toFixed(0)}%)` });

  // 2. Confidence adjustment (dari scoring.js confidenceScore)
  const confidenceFactor = (confidence || 50) / 100;
  kelly *= confidenceFactor;
  adjustments.push({ type: "confidence", multiplier: confidenceFactor, reason: `Confidence ${confidence}%` });

  // 3. Drawdown adjustment (ported dari CloddsBot kelly.ts)
  const resolved = recentTrades.filter(t => t.result !== null && t.status !== "belum selesai");
  const drawdown = calculateDrawdown(resolved);
  if (drawdown > 0.05) {
    const drawdownFactor = Math.max(0.5, 1 - drawdown * 3);
    kelly *= drawdownFactor;
    adjustments.push({ type: "drawdown", multiplier: drawdownFactor, reason: `Drawdown ${(drawdown * 100).toFixed(1)}%` });
  }

  // 4. Win/Loss streak (ported dari CloddsBot kelly.ts)
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

  // 5. Sample size penalty (sedikit data = konservatif)
  if (resolved.length < 10) {
    const sampleFactor = 0.5 + (resolved.length / 10) * 0.5;
    kelly *= sampleFactor;
    adjustments.push({ type: "sample_size", multiplier: sampleFactor, reason: `Hanya ${resolved.length} data historis` });
  }

  // 6. Clamp ke batas aman
  kelly = Math.max(0.01, Math.min(0.25, kelly));

  return {
    kelly: Math.round(kelly * 10000) / 10000,
    kellyPct: (kelly * 100).toFixed(1),
    positionSize: Math.round(bankroll * kelly * 100) / 100,
    bankroll,
    adjustments,
    risk: { drawdown, streak },
  };
}

// ─── Analytics by Category ─────────────────────────────────────────────────

/**
 * Breakdown performa berdasarkan kategori market.
 * Ported dari CloddsBot analytics getAttribution() dan analytics skill.
 */
export function getPerformanceByCategory(trades) {
  return groupByCategory(trades.filter(t => t.status !== "belum selesai" && t.result !== "netral"));
}

/**
 * Analisis performa berdasarkan hari/jam.
 * Ported dari CloddsBot analytics getHourlyPerformance() dan getDayOfWeekPerformance().
 */
export function getTimingAnalysis(trades) {
  const resolved = trades.filter(t => t.status !== "belum selesai" && t.result !== "netral");
  if (!resolved.length) return { hourly: [], daily: [] };

  // Hourly breakdown
  const hourlyMap = {};
  for (const t of resolved) {
    const hour = new Date(t.created_at).getHours();
    if (!hourlyMap[hour]) hourlyMap[hour] = { wins: 0, total: 0 };
    hourlyMap[hour].total++;
    if (t.result?.toLowerCase() === "menang") hourlyMap[hour].wins++;
  }

  const hourly = Object.entries(hourlyMap).map(([hour, data]) => ({
    hour: parseInt(hour),
    winRate: (data.wins / data.total * 100).toFixed(1),
    trades: data.total,
    wins: data.wins,
  })).sort((a, b) => b.winRate - a.winRate);

  // Daily breakdown
  const dayNames = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const dailyMap = {};
  for (const t of resolved) {
    const day = new Date(t.created_at).getDay();
    if (!dailyMap[day]) dailyMap[day] = { wins: 0, total: 0, name: dayNames[day] };
    dailyMap[day].total++;
    if (t.result?.toLowerCase() === "menang") dailyMap[day].wins++;
  }

  const daily = Object.values(dailyMap).map(d => ({
    ...d,
    winRate: (d.wins / d.total * 100).toFixed(1),
  })).sort((a, b) => b.winRate - a.winRate);

  return { hourly, daily };
}

// ─── Backtest Engine ────────────────────────────────────────────────────────

/**
 * Backtest sederhana: simulasikan strategi berbeda di data historis Shadow Bot.
 * Ported dari CloddsBot backtest skill — run() dan getMetrics().
 */
export function runBacktest({
  trades,
  strategy = "kelly",       // "kelly" | "flat" | "conservative"
  initialCapital = 1000,
  betSizeFraction = 0.05,   // default 5% flat
} = {}) {
  const resolved = [...trades]
    .filter(t => t.status !== "belum selesai" && t.result !== null)
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  if (!resolved.length) return null;

  let capital = initialCapital;
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  const equityCurve = [{ date: "start", capital }];

  for (const trade of resolved) {
    const betSize = strategy === "flat"
      ? capital * betSizeFraction
      : strategy === "conservative"
        ? capital * 0.02
        : capital * Math.min(0.10, betSizeFraction); // kelly-ish

    const isWin = trade.result?.toLowerCase() === "menang";
    // Simplified: menang dapat 90% profit (polymarket ~0% fee), kalah rugi bet
    capital = isWin ? capital + betSize * 0.9 : capital - betSize;
    capital = Math.max(0, capital);

    if (capital > peakCapital) peakCapital = capital;
    const drawdown = (peakCapital - capital) / peakCapital;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    equityCurve.push({ date: trade.created_at?.slice(0, 10), capital: Math.round(capital) });
  }

  const wins = resolved.filter(t => t.result?.toLowerCase() === "menang").length;
  const totalReturn = ((capital - initialCapital) / initialCapital) * 100;
  const winRate = wins / resolved.length * 100;
  const profitFactor = wins > 0 && resolved.length - wins > 0
    ? (wins * 0.9) / (resolved.length - wins)
    : null;

  return {
    strategy,
    initialCapital,
    finalCapital: Math.round(capital),
    totalReturn: totalReturn.toFixed(1),
    maxDrawdown: (maxDrawdown * 100).toFixed(1),
    winRate: winRate.toFixed(1),
    profitFactor: profitFactor?.toFixed(2),
    totalTrades: resolved.length,
    wins,
    losses: resolved.length - wins,
    sharpeRatio: calculateSharpe(resolved.map(t => t.result?.toLowerCase() === "menang" ? 1 : -1)).toFixed(2),
    equityCurve,
  };
}

// ─── Formatters ────────────────────────────────────────────────────────────

export function formatAnalyticsSummary(metrics, period = "30 hari") {
  if (!metrics || metrics.resolved === 0) {
    return `📊 *Analytics (${period})*\n\nBelum ada data resolved. Mulai analisis market dengan /analyze lalu cek hasilnya setelah event selesai.`;
  }

  const { total, totalAll, pending, wins, losses, winRate, lossRate, avgConfidence, sharpeRatio, maxStreak } = metrics;

  let text = `📊 *Performance Analytics — ${period}*\n\n`;
  text += `📈 *Total Analisis:* ${totalAll} (${total} resolved, ${pending} pending)\n`;
  text += `✅ *Menang:* ${wins} | ❌ *Kalah:* ${losses}\n`;
  text += `🎯 *Win Rate:* ${winRate?.toFixed(1)}%\n`;

  if (avgConfidence != null) {
    text += `🧠 *Avg AI Confidence:* ${avgConfidence.toFixed(0)}%\n`;
  }
  if (sharpeRatio != null) {
    text += `📐 *Sharpe Ratio:* ${sharpeRatio.toFixed(2)}\n`;
  }

  text += `\n🔥 *Streak Terpanjang:*\n`;
  text += `• Win streak: ${maxStreak.wins} | Loss streak: ${maxStreak.losses}\n`;

  return text.trim();
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

export function formatBacktestResult(result) {
  if (!result) return "❌ Tidak cukup data untuk backtest.";

  const returnEmoji = parseFloat(result.totalReturn) >= 0 ? "📈" : "📉";
  const pfText = result.profitFactor ? ` | PF: ${result.profitFactor}` : "";

  let text = `📈 *Backtest — Strategi: ${result.strategy}*\n\n`;
  text += `💰 Modal awal: $${result.initialCapital.toLocaleString()} → $${result.finalCapital.toLocaleString()}\n`;
  text += `${returnEmoji} *Total Return:* ${result.totalReturn}%\n`;
  text += `📉 *Max Drawdown:* ${result.maxDrawdown}%\n`;
  text += `🎯 *Win Rate:* ${result.winRate}% (${result.wins}W / ${result.losses}L)${pfText}\n`;
  text += `📐 *Sharpe:* ${result.sharpeRatio}\n`;
  text += `🔢 *Total trades:* ${result.totalTrades}\n`;

  return text.trim();
}

export function formatTimingAnalysis({ hourly, daily }) {
  if (!hourly.length && !daily.length) return "❌ Belum cukup data untuk analisis timing.";

  let text = "⏰ *Timing Analysis*\n\n";

  if (hourly.length) {
    text += "*Best Hours:*\n";
    for (const h of hourly.slice(0, 5)) {
      text += `• Pukul ${String(h.hour).padStart(2, "0")}:00 → WR ${h.winRate}% (${h.trades} trades)\n`;
    }
  }

  if (daily.length) {
    text += "\n*Best Days:*\n";
    for (const d of daily.slice(0, 5)) {
      text += `• Hari ${d.name} → WR ${d.winRate}% (${d.total} trades)\n`;
    }
  }

  return text.trim();
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function parseConfidence(str) {
  if (str == null) return null;
  const match = String(str).match(/(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function calculateDrawdown(trades) {
  const resolved = trades.filter(t => t.status !== "belum selesai");
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
  const sorted = [...trades].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!sorted.length) return { type: "none", count: 0 };

  const first = sorted[0].result;
  let count = 0;
  for (const t of sorted) {
    if (t.result === first) count++;
    else break;
  }

  return { type: first?.toLowerCase() === "menang" ? "win" : "loss", count };
}

function calculateSharpe(returns) {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return 0;
  return mean / stdDev;
}

function groupByCategory(trades) {
  const keywords = {
    "Politik": ["election", "president", "congress", "senate", "vote", "trump", "biden", "republican", "democrat"],
    "Kripto": ["btc", "bitcoin", "eth", "ethereum", "crypto", "defi", "sol", "bnb", "doge", "dogecoin"],
    "Sports": ["nba", "nfl", "ufc", "mma", "football", "basketball", "tennis", "soccer"],
    "Ekonomi": ["fed", "rate", "gdp", "inflation", "recession", "economy"],
    "Teknologi": ["openai", "gpt", "ai", "apple", "google", "meta", "tech"],
  };

  const byCategory = {};

  for (const trade of trades) {
    const qRaw = trade.question || "";
    const q = qRaw.toLowerCase();
    
    let found = "Lainnya";
    let subCat = null;

    // Cek short-term crypto (BTC 5 min, dll)
    const m = qRaw.match(/^([a-zA-Z]+)\s+Up or Down/i);
    if (m) {
      found = "Kripto";
      const coin = m[1].toUpperCase();
      let shortCoin = coin;
      if (coin === "BITCOIN") shortCoin = "BTC";
      else if (coin === "ETHEREUM") shortCoin = "ETH";
      else if (coin === "DOGECOIN") shortCoin = "DOGE";
      else if (coin === "SOLANA") shortCoin = "SOL";

      const timeMatch = qRaw.match(/(\d{1,2}:\d{2}[AP]M)\s*-\s*(\d{1,2}:\d{2}[AP]M)/i);
      if (timeMatch) {
        const parseTime = (t) => {
          const hm = t.match(/(\d+):(\d+)([AP]M)/i);
          if (!hm) return 0;
          let h = parseInt(hm[1], 10);
          let min = parseInt(hm[2], 10);
          if (hm[3].toUpperCase() === 'PM' && h < 12) h += 12;
          if (hm[3].toUpperCase() === 'AM' && h === 12) h = 0;
          return h * 60 + min;
        };
        const diff = parseTime(timeMatch[2]) - parseTime(timeMatch[1]);
        const duration = diff > 0 ? diff : (diff + 24 * 60);
        subCat = `${shortCoin} ${duration} min`;
      } else {
        subCat = `${shortCoin} Short-term`;
      }
    } else {
      for (const [cat, kwds] of Object.entries(keywords)) {
        if (kwds.some(k => q.includes(k))) { found = cat; break; }
      }
    }

    if (!byCategory[found]) byCategory[found] = { wins: 0, total: 0, sub: {} };
    byCategory[found].total++;
    const isWin = trade.result?.toLowerCase() === "menang";
    if (isWin) byCategory[found].wins++;

    if (subCat) {
      if (!byCategory[found].sub[subCat]) byCategory[found].sub[subCat] = { wins: 0, total: 0 };
      byCategory[found].sub[subCat].total++;
      if (isWin) byCategory[found].sub[subCat].wins++;
    }
  }

  return Object.fromEntries(
    Object.entries(byCategory).map(([cat, data]) => [
      cat,
      { 
        ...data, 
        winRate: data.total > 0 ? (data.wins / data.total * 100).toFixed(1) : "N/A"
      },
    ])
  );
}

