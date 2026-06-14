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

  CREATE TABLE IF NOT EXISTS shadow_balance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shadow_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL,
    market_url TEXT NOT NULL,
    question TEXT NOT NULL,
    amount REAL NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    pnl REAL DEFAULT 0,
    created_at TEXT NOT NULL,
    resolved_at TEXT
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

  INSERT OR IGNORE INTO shadow_balance (id, balance, updated_at) VALUES (1, 10000, datetime('now'));
`);

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

export function getShadowBalance() {
  try {
    const row = db.prepare('SELECT balance FROM shadow_balance WHERE id = 1').get();
    return row ? row.balance : 10000;
  } catch (error) {
    console.error("[Storage] getShadowBalance error:", error.message);
    return 10000;
  }
}

export function updateShadowBalance(newBalance) {
  try {
    db.prepare('UPDATE shadow_balance SET balance = ?, updated_at = ? WHERE id = 1').run(newBalance, new Date().toISOString());
  } catch (error) {
    console.error("[Storage] updateShadowBalance error:", error.message);
  }
}

export function addShadowBet(bet) {
  try {
    const createdAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO shadow_bets (market_id, market_url, question, amount, side, entry_price, status, pnl, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?)
    `).run(bet.market_id, bet.market_url, bet.question, bet.amount, bet.side, bet.entry_price, createdAt);
    return info.lastInsertRowid;
  } catch (error) {
    console.error("[Storage] addShadowBet error:", error.message);
    return null;
  }
}

export function getShadowBets(status = 'all', limit = 50) {
  try {
    if (status !== 'all') {
      return db.prepare('SELECT * FROM shadow_bets WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit);
    }
    return db.prepare('SELECT * FROM shadow_bets ORDER BY id DESC LIMIT ?').all(limit);
  } catch (error) {
    console.error("[Storage] getShadowBets error:", error.message);
    return [];
  }
}

export function getShadowStats() {
  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM shadow_bets').get();
    const wins = db.prepare('SELECT COUNT(*) as count FROM shadow_bets WHERE status = ? AND pnl > 0').get('resolved');
    const losses = db.prepare('SELECT COUNT(*) as count FROM shadow_bets WHERE status = ? AND pnl <= 0').get('resolved');
    const openCount = db.prepare('SELECT COUNT(*) as count FROM shadow_bets WHERE status = ?').get('open');
    const pnlSum = db.prepare('SELECT COALESCE(SUM(pnl), 0) as total FROM shadow_bets WHERE status = ?').get('resolved');
    const invested = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM shadow_bets').get();
    const openExposure = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM shadow_bets WHERE status = ?').get('open');
    
    const resolvedCount = (wins?.count || 0) + (losses?.count || 0);
    const winRate = resolvedCount > 0 ? ((wins?.count || 0) / resolvedCount * 100) : 0;
    const roi = (invested?.total || 0) > 0 ? ((pnlSum?.total || 0) / (invested?.total || 1) * 100) : 0;
    
    return {
      totalBets: total?.count || 0,
      wins: wins?.count || 0,
      losses: losses?.count || 0,
      openBets: openCount?.count || 0,
      totalPnl: pnlSum?.total || 0,
      winRate: Math.round(winRate * 10) / 10,
      roi: Math.round(roi * 10) / 10,
      openExposure: openExposure?.total || 0
    };
  } catch (error) {
    console.error("[Storage] getShadowStats error:", error.message);
    return { totalBets: 0, wins: 0, losses: 0, openBets: 0, totalPnl: 0, winRate: 0, roi: 0, openExposure: 0 };
  }
}

export function resolveShadowBet(id, pnl, revenue) {
  try {
    const resolvedAt = new Date().toISOString();
    db.prepare('UPDATE shadow_bets SET status = ?, pnl = ?, resolved_at = ? WHERE id = ?').run('resolved', pnl, resolvedAt, id);
    
    if (revenue > 0) {
      const currentBalance = getShadowBalance();
      updateShadowBalance(currentBalance + revenue);
    }
    return true;
  } catch (error) {
    console.error("[Storage] resolveShadowBet error:", error.message);
    return false;
  }
}

export function addAnalyzedEvent(event) {
  try {
    const createdAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO analyzed_events (market_id, question, url, prediction, status, created_at)
      VALUES (?, ?, ?, ?, 'belum selesai', ?)
    `).run(event.market_id, event.question, event.url, event.prediction, createdAt);
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

export function updateAnalyzedEventStatus(id, status, result) {
  try {
    const resolvedAt = new Date().toISOString();
    db.prepare('UPDATE analyzed_events SET status = ?, result = ?, resolved_at = ? WHERE id = ?')
      .run(status, result, resolvedAt, id);
    return true;
  } catch (error) {
    console.error("[Storage] updateAnalyzedEventStatus error:", error.message);
    return false;
  }
}
