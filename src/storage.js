import Database from "better-sqlite3";
import { config } from "./config.js";
import { databasePath } from "./database-path.js";
import { migrateDatabase } from "./migrations.js";

const db = new Database(databasePath);
export { databasePath };
export const ANALYSIS_STRATEGY_VERSION = "chainlink-terminal-value-v3";

db.pragma('journal_mode = WAL');
await migrateDatabase(db, { databasePath });

export function getCache(key, ttlSeconds = config.cacheTtlSeconds) {
  try {
    const row = db.prepare('SELECT value, saved_at FROM cache WHERE key = ?').get(key);
    if (!row) return null;

    const ageSeconds = (Date.now() - row.saved_at) / 1000;
    if (ageSeconds > ttlSeconds) {
      db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return null;
    }

    return JSON.parse(row.value);
  } catch (error) {
    console.error("[Storage] getCache error:", error.message);
    return null;
  }
}

export function setCache(key, value) {
  try {
    db.prepare(`
      INSERT INTO cache (key, value, saved_at) 
      VALUES (?, ?, ?) 
      ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value, 
        saved_at = excluded.saved_at
    `).run(key, JSON.stringify(value), Date.now());
  } catch (error) {
    console.error("[Storage] setCache error:", error.message);
  }
}

export function deleteCache(key) {
  try {
    return db.prepare('DELETE FROM cache WHERE key = ?').run(key).changes > 0;
  } catch (error) {
    console.error("[Storage] deleteCache error:", error.message);
    return false;
  }
}

export function appendAnalysisLog(entry) {
  try {
    const createdAt = new Date().toISOString();
    const data = JSON.stringify({ at: createdAt, ...entry });
    db.prepare('INSERT INTO analysis_log (created_at, data) VALUES (?, ?)').run(createdAt, data);
  } catch (error) {
    console.error("[Storage] appendAnalysisLog error:", error.message);
  }
}

export function getAnalysisLogs(limit = 50) {
  try {
    const rows = db.prepare('SELECT id, created_at, data FROM analysis_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      data: JSON.parse(r.data)
    }));
  } catch (error) {
    console.error("[Storage] getAnalysisLogs error:", error.message);
    return [];
  }
}

export function addAnalyzedEvent(event) {
  try {
    const createdAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO analyzed_events (market_id, question, url, prediction, actionable, status, analysis_conclusion, qwen_confidence, data_confidence, execution_time, strategy_version, fair_probability, max_entry_price, signal_data_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'belum selesai', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.market_id, event.question, event.url, event.prediction, event.actionable ? 1 : 0, event.analysis_conclusion, event.qwen_confidence ?? null, event.data_confidence ?? null, event.execution_time ?? null, ANALYSIS_STRATEGY_VERSION, event.fair_probability ?? null, event.max_entry_price ?? null, event.signal_data_at || null, createdAt);
    return info.lastInsertRowid;
  } catch (error) {
    console.error("[Storage] addAnalyzedEvent error:", error.message);
    return null;
  }
}

export function getAnalyzedEvents(limit = 100, startDate = null, endDate = null) {
  try {
    let query = `SELECT a.* FROM analyzed_events a`;
    const params = [];
    const conditions = [];

    if (startDate) {
      conditions.push(`substr(a.created_at, 1, 10) >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`substr(a.created_at, 1, 10) <= ?`);
      params.push(endDate);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` ORDER BY a.id DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(query).all(...params);
  } catch (error) {
    console.error("[Storage] getAnalyzedEvents error:", error.message);
    return [];
  }
}

export function getUnresolvedAnalyzedEvents() {
  try {
    return db.prepare("SELECT * FROM analyzed_events WHERE status = 'belum selesai' ORDER BY id ASC").all();
  } catch (error) {
    console.error("[Storage] getUnresolvedAnalyzedEvents error:", error.message);
    return [];
  }
}

export function summarizePlayStats(events, strategyVersion = null) {
  const resolved = (Array.isArray(events) ? events : []).filter((event) =>
    (!strategyVersion || event.strategy_version === strategyVersion)
    && Number(event.actionable) === 1
    && event.status === "selesai"
    && (event.result === "menang" || event.result === "kalah")
  );
  const wins = resolved.filter((event) => event.result === "menang").length;
  const losses = resolved.length - wins;
  return {
    sampleSize: resolved.length,
    wins,
    losses,
    winRate: resolved.length ? Number(((wins / resolved.length) * 100).toFixed(1)) : 0,
  };
}

function getResolvedPlayEvents() {
  return db.prepare(`
    SELECT strategy_version, actionable, status, result
    FROM analyzed_events
    WHERE actionable = 1 AND status = 'selesai' AND result IN ('menang', 'kalah')
    ORDER BY id ASC
  `).all();
}

export function getRecentResolvedOutcomes({ days = 30 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return db.prepare(`
      SELECT market_id, question, url, prediction, status, result, created_at
      FROM analyzed_events
      WHERE created_at >= ? AND status = 'selesai' AND result IN ('menang', 'kalah')
      ORDER BY created_at DESC
    `).all(since);
  } catch (error) {
    console.error("[Storage] getRecentResolvedOutcomes error:", error.message);
    return [];
  }
}

export function getStats() {
  try {
    const playStats = summarizePlayStats(getResolvedPlayEvents());
    const totalRow = db.prepare("SELECT COUNT(*) AS total FROM analyzed_events").get();
    return {
      totalAnalyzed: Number(totalRow?.total || 0),
      sampleSize: playStats.sampleSize,
      wins: playStats.wins,
      losses: playStats.losses,
      winRate: playStats.winRate,
      strategyVersion: ANALYSIS_STRATEGY_VERSION,
    };
  } catch (error) {
    console.error("[Storage] getStats error:", error.message);
    return { totalAnalyzed: 0, sampleSize: 0, wins: 0, losses: 0, winRate: 0 };
  }
}

export function getDashboardMetrics() {
  try {
    const resolvedEvents = getResolvedPlayEvents();
    const playStats = summarizePlayStats(resolvedEvents);
    let currentEquity = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;

    for (const ev of resolvedEvents) {
      if (ev.result === 'menang') {
        currentEquity++;
      } else if (ev.result === 'kalah') {
        currentEquity--;
      }
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      const drawdown = peakEquity - currentEquity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // Financial metrics require fills, fees, and realized PnL, which this schema does not store yet.
    const profitFactor = "N/A";
    const expectancy = "N/A";

    const latestEvent = db.prepare(`
      SELECT question, prediction, analysis_conclusion, qwen_confidence, created_at, resolved_at, status
      FROM analyzed_events
      WHERE actionable = 1 AND UPPER(prediction) IN ('YES', 'UP', 'NO', 'DOWN')
      ORDER BY id DESC LIMIT 1
    `).get();
    
    let signalText = "-";
    let signalDir = "WAITING";
    let conclusion = "Menunggu data...";
    let confluenceScore = "0%";
    let eventName = "-";
    let eventTime = "-";
    
    if (latestEvent) {
      eventName = latestEvent.question;
      if (latestEvent.status === 'selesai' && latestEvent.resolved_at) {
        eventTime = latestEvent.resolved_at;
      } else {
        eventTime = latestEvent.created_at || "-";
      }
      let assetMatch = latestEvent.question.match(/^([A-Z0-9]+)\b/i);
      if (assetMatch) {
          signalText = assetMatch[1].toUpperCase();
          if (signalText === 'WILL') signalText = 'MARKET';
      } else {
          signalText = "MARKET";
      }
      
      if (latestEvent.prediction) {
          const predUpper = latestEvent.prediction.toUpperCase();
          if (predUpper.includes('YES') || predUpper.includes('UP')) signalDir = "LONG";
          else if (predUpper.includes('NO') || predUpper.includes('DOWN')) signalDir = "SHORT";
          else signalDir = "SIGNAL";
      }
      
      if (latestEvent.analysis_conclusion) {
          // Hanya ambil satu kalimat pertama atau teks pendek agar tidak merusak UI
          const fullText = latestEvent.analysis_conclusion.trim();
          let shortText = fullText.split('\n')[0];
          if (shortText.length > 50) shortText = shortText.substring(0, 50) + "...";
          conclusion = shortText;
          if (fullText.includes("KESIMPULAN CEPAT")) {
               const kcMatch = fullText.match(/KESIMPULAN CEPAT\r?\n(.*)/);
               if (kcMatch && kcMatch[1]) {
                    conclusion = kcMatch[1].substring(0, 50) + "...";
               }
          }
      }
      if (latestEvent.qwen_confidence) confluenceScore = latestEvent.qwen_confidence;
      if (!confluenceScore.includes('%')) confluenceScore += '%';
    }

    return {
      profitFactor,
      expectancy,
      maxDrawdown: "N/A",
      winRate: playStats.winRate.toFixed(1),
      sampleSize: playStats.sampleSize,
      strategyVersion: ANALYSIS_STRATEGY_VERSION,
      playStats,
      latestSignal: {
        asset: signalText,
        direction: signalDir,
        conclusion,
        confluenceScore,
        eventName,
        eventTime
      }
    };
  } catch (error) {
    console.error("[Storage] getDashboardMetrics error:", error.message);
    return null;
  }
}

export function updateAnalyzedEventStatus(id, status, result, actualOutcome) {
  try {
    const resolvedAt = new Date().toISOString();
    const info = db.prepare("UPDATE analyzed_events SET status = ?, result = ?, actual_outcome = ?, resolved_at = ? WHERE id = ? AND status != 'selesai'")
      .run(status, result, actualOutcome, resolvedAt, id);
    return info.changes > 0;
  } catch (error) {
    console.error("[Storage] updateAnalyzedEventStatus error:", error.message);
    return false;
  }
}

export function getAnalyzedEventById(id) {
  try {
    return db.prepare('SELECT * FROM analyzed_events WHERE id = ?').get(id);
  } catch (error) {
    console.error("[Storage] getAnalyzedEventById error:", error.message);
    return null;
  }
}

export function getStorageHealth() {
  try {
    return db.prepare("SELECT 1 AS ok").get()?.ok === 1;
  } catch {
    return false;
  }
}
