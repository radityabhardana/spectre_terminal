import Database from "better-sqlite3";
import { config } from "./config.js";
import { databasePath } from "./database-path.js";

const db = new Database(databasePath);
export { databasePath };
export const ANALYSIS_STRATEGY_VERSION = "chainlink-terminal-value-v3";

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analyzed_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    question TEXT NOT NULL,
    url TEXT NOT NULL,
    prediction TEXT,
    status TEXT NOT NULL DEFAULT 'belum selesai',
    result TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS prediction_reflections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    question TEXT NOT NULL,
    prediction TEXT NOT NULL,
    actual_outcome TEXT NOT NULL,
    reflection_note TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    username TEXT,
    email TEXT,
    password TEXT,
    avatar_url TEXT
  );

  CREATE TABLE IF NOT EXISTS trade_requests (
    idempotency_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trade_executions (
    analysis_id INTEGER PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    market_id TEXT NOT NULL,
    size_usdc REAL,
    status TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN analysis_conclusion TEXT").run();
} catch (e) {
  // column might already exist
}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN actual_outcome TEXT").run();
} catch (e) {
  // column might already exist
}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN qwen_confidence TEXT").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN data_confidence TEXT").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN execution_time INTEGER").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN strategy_version TEXT").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN fair_probability REAL").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN max_entry_price REAL").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN signal_data_at TEXT").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE analyzed_events ADD COLUMN actionable INTEGER NOT NULL DEFAULT 0").run();
} catch (e) {}

try {
  db.prepare("ALTER TABLE trade_executions ADD COLUMN size_usdc REAL").run();
} catch (e) {}

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

export function reserveTradeExecutions(idempotencyKey, trades) {
  const reserve = db.transaction(() => {
    const now = new Date().toISOString();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const existingExposure = Number(db.prepare(`
      SELECT COALESCE(SUM(size_usdc), 0) AS total
      FROM trade_executions
      WHERE created_at >= ?
    `).get(since)?.total || 0);
    const requestedExposure = trades.reduce((sum, trade) => sum + Number(trade.sizeUsdc || 0), 0);
    if (existingExposure + requestedExposure > config.maxDailyTradeUsdc) {
      const error = new Error(`24-hour trade cap of ${config.maxDailyTradeUsdc} USDC exceeded`);
      error.code = "TRADE_DAILY_CAP";
      throw error;
    }
    db.prepare("INSERT INTO trade_requests (idempotency_key, created_at) VALUES (?, ?)").run(idempotencyKey, now);
    const insert = db.prepare(`
      INSERT INTO trade_executions (analysis_id, idempotency_key, market_id, size_usdc, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reserved', ?, ?)
    `);
    for (const trade of trades) insert.run(trade.analysisId, idempotencyKey, trade.marketId, trade.sizeUsdc, now, now);
  });
  try {
    reserve();
    return true;
  } catch (error) {
    if (String(error.code || "").startsWith("SQLITE_CONSTRAINT")) return false;
    throw error;
  }
}

export function completeTradeExecution(analysisId, status, result) {
  const info = db.prepare(`
    UPDATE trade_executions
    SET status = ?, result_json = ?, updated_at = ?
    WHERE analysis_id = ? AND status = 'reserved'
  `).run(status, JSON.stringify(result ?? null), new Date().toISOString(), analysisId);
  return info.changes > 0;
}

export function getAnalyzedEvents(limit = 100, startDate = null, endDate = null) {
  try {
    let query = `
      SELECT a.*, 
        CASE WHEN EXISTS (
          SELECT 1 FROM prediction_reflections p WHERE p.market_id = a.market_id
        ) THEN 1 ELSE 0 END as has_reflection
      FROM analyzed_events a
    `;
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

export function saveReflection(reflection) {
  try {
    const createdAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO prediction_reflections (market_id, question, prediction, actual_outcome, reflection_note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reflection.market_id, reflection.question, reflection.prediction, reflection.actual_outcome, reflection.reflection_note, createdAt);
    return info.lastInsertRowid;
  } catch (error) {
    console.error("[Storage] saveReflection error:", error.message);
    return null;
  }
}

export function getRecentReflections(limit = 5) {
  try {
    return db.prepare(`
      SELECT p.*
      FROM prediction_reflections p
      WHERE EXISTS (
        SELECT 1 FROM analyzed_events a
        WHERE a.market_id = p.market_id
          AND a.strategy_version = ?
          AND a.actionable = 1
          AND a.result = 'kalah'
      )
      ORDER BY p.id DESC LIMIT ?
    `).all(ANALYSIS_STRATEGY_VERSION, limit);
  } catch (error) {
    console.error("[Storage] getRecentReflections error:", error.message);
    return [];
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

export function getReflectionByMarketId(marketId) {
  try {
    return db.prepare('SELECT * FROM prediction_reflections WHERE market_id = ? ORDER BY id DESC LIMIT 1').get(marketId);
  } catch (error) {
    console.error("[Storage] getReflectionByMarketId error:", error.message);
    return null;
  }
}

export function getAllReflections() {
  try {
    return db.prepare('SELECT * FROM prediction_reflections ORDER BY id DESC').all();
  } catch (error) {
    console.error("[Storage] getAllReflections error:", error.message);
    return [];
  }
}
