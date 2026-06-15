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
      INSERT INTO analyzed_events (market_id, question, url, prediction, status, analysis_conclusion, created_at)
      VALUES (?, ?, ?, ?, 'belum selesai', ?, ?)
    `).run(event.market_id, event.question, event.url, event.prediction, event.analysis_conclusion, createdAt);
    return info.lastInsertRowid;
  } catch (error) {
    console.error("[Storage] addAnalyzedEvent error:", error.message);
    return null;
  }
}

export function getAnalyzedEvents(limit = 100) {
  try {
    return db.prepare('SELECT * FROM analyzed_events ORDER BY id DESC LIMIT ?').all(limit);
  } catch (error) {
    console.error("[Storage] getAnalyzedEvents error:", error.message);
    return [];
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
