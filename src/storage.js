import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

const dataDir = path.resolve(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, "database.db");
const db = new Database(dbPath);

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
      INSERT INTO analyzed_events (market_id, question, url, prediction, status, analysis_conclusion, qwen_confidence, data_confidence, created_at)
      VALUES (?, ?, ?, ?, 'belum selesai', ?, ?, ?, ?)
    `).run(event.market_id, event.question, event.url, event.prediction, event.analysis_conclusion, event.qwen_confidence || null, event.data_confidence || null, createdAt);
    return info.lastInsertRowid;
  } catch (error) {
    console.error("[Storage] addAnalyzedEvent error:", error.message);
    return null;
  }
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
      conditions.push(`a.created_at >= ?`);
      params.push(`${startDate}T00:00:00.000Z`);
    }
    if (endDate) {
      conditions.push(`a.created_at <= ?`);
      params.push(`${endDate}T23:59:59.999Z`);
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

export function getStats() {
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as total FROM analyzed_events').get();
    const winRow = db.prepare('SELECT COUNT(*) as wins FROM analyzed_events WHERE result = ?').get('menang');
    const lossRow = db.prepare('SELECT COUNT(*) as losses FROM analyzed_events WHERE result = ?').get('kalah');
    return {
      totalAnalyzed: totalRow.total || 0,
      wins: winRow.wins || 0,
      losses: lossRow.losses || 0
    };
  } catch (error) {
    console.error("[Storage] getStats error:", error.message);
    return { totalAnalyzed: 0, wins: 0, losses: 0 };
  }
}

export function updateAnalyzedEventStatus(id, status, result, actualOutcome) {
  try {
    const resolvedAt = new Date().toISOString();
    db.prepare('UPDATE analyzed_events SET status = ?, result = ?, actual_outcome = ?, resolved_at = ? WHERE id = ?')
      .run(status, result, actualOutcome, resolvedAt, id);
    return true;
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
    return db.prepare('SELECT * FROM prediction_reflections ORDER BY id DESC LIMIT ?').all(limit);
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

