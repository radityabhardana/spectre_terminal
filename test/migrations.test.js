import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { RETIRED_TABLES, SCHEMA_VERSION, migrateDatabase, verifyDatabase } from "../src/migrations.js";

function tempDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "razor-migration-"));
  const databasePath = path.join(directory, "database.db");
  return { directory, databasePath, db: new Database(databasePath) };
}

function createLegacySchema(db) {
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, saved_at INTEGER NOT NULL);
    CREATE TABLE analysis_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE analyzed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id TEXT NOT NULL,
      question TEXT NOT NULL,
      url TEXT NOT NULL,
      prediction TEXT,
      status TEXT NOT NULL DEFAULT 'belum selesai',
      result TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      analysis_conclusion TEXT,
      actual_outcome TEXT,
      qwen_confidence TEXT,
      data_confidence TEXT,
      execution_time INTEGER,
      strategy_version TEXT,
      fair_probability REAL,
      max_entry_price REAL,
      signal_data_at TEXT,
      actionable INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE prediction_reflections (id INTEGER PRIMARY KEY, reflection_note TEXT);
    CREATE TABLE trade_requests (idempotency_key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE trade_executions (analysis_id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE shadow_balance (id INTEGER PRIMARY KEY, balance REAL);
    CREATE TABLE shadow_bets (id INTEGER PRIMARY KEY);
    CREATE TABLE price_alerts (id INTEGER PRIMARY KEY);
    CREATE TABLE user_profile (id INTEGER PRIMARY KEY, password TEXT);
  `);
  db.prepare("INSERT INTO analysis_log (created_at, data) VALUES (?, ?)").run("2026-08-10T00:00:00.000Z", "{}");
  db.prepare(`
    INSERT INTO analyzed_events (market_id, question, url, prediction, status, result, created_at, actual_outcome, actionable)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("market-1", "Will BTC rise?", "https://polymarket.com/event/market-1", "UP", "selesai", "menang", "2026-08-10T00:00:00.000Z", "Up", 1);
  db.prepare("INSERT INTO prediction_reflections (id, reflection_note) VALUES (1, 'retired')").run();
}

function replaceAnalyzedEventsSchema(db, {
  idDefinition = "INTEGER PRIMARY KEY AUTOINCREMENT",
  predictionDefinition = "TEXT",
  actualOutcomeDefinition = "TEXT",
  tableConstraint = "",
} = {}) {
  db.exec(`
    DROP INDEX IF EXISTS idx_analyzed_events_created_at;
    ALTER TABLE analyzed_events RENAME TO analyzed_events_previous;
    CREATE TABLE analyzed_events (
      id ${idDefinition},
      market_id TEXT NOT NULL,
      question TEXT NOT NULL,
      url TEXT NOT NULL,
      prediction ${predictionDefinition},
      status TEXT NOT NULL DEFAULT 'belum selesai',
      result TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      analysis_conclusion TEXT,
      actual_outcome ${actualOutcomeDefinition},
      qwen_confidence TEXT,
      data_confidence TEXT,
      execution_time INTEGER,
      strategy_version TEXT,
      fair_probability REAL,
      max_entry_price REAL,
      signal_data_at TEXT,
      actionable INTEGER NOT NULL DEFAULT 0
      ${tableConstraint}
    );
    DROP TABLE analyzed_events_previous;
    CREATE INDEX idx_analyzed_events_created_at ON analyzed_events (created_at);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

test("legacy migration verifies a backup, drops retired tables, and preserves canonical history", async () => {
  const fixture = tempDatabase();
  try {
    createLegacySchema(fixture.db);
    const result = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "backups"),
      now: () => new Date("2026-08-10T01:02:03.000Z"),
    });

    assert.equal(result.fromVersion, 0);
    assert.equal(result.toVersion, SCHEMA_VERSION);
    assert.equal(result.migrated, true);
    assert.ok(result.backupPath);
    assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM analyzed_events").get().count, 1);
    assert.equal(fixture.db.prepare("SELECT result FROM analyzed_events WHERE market_id = ?").get("market-1").result, "menang");

    const activeTables = new Set(fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of RETIRED_TABLES) assert.equal(activeTables.has(table), false, `${table} must be dropped`);

    const backup = new Database(result.backupPath, { readonly: true });
    try {
      assert.equal(backup.pragma("quick_check", { simple: true }), "ok");
      assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM prediction_reflections").get().count, 1);
    } finally {
      backup.close();
    }
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("fresh databases receive only the canonical schema without a backup", async () => {
  const fixture = tempDatabase();
  try {
    const result = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "backups"),
    });
    assert.equal(result.backupPath, null);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a failed backup leaves the legacy database untouched", async () => {
  const fixture = tempDatabase();
  try {
    createLegacySchema(fixture.db);
    await assert.rejects(
      migrateDatabase(fixture.db, {
        databasePath: fixture.databasePath,
        backupDirectory: path.join(fixture.directory, "backups"),
        backupDatabase: async () => { throw new Error("backup failed"); },
      }),
      /backup failed/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM prediction_reflections").get().count, 1);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an incompatible legacy canonical table is rejected before destructive changes", async () => {
  const fixture = tempDatabase();
  try {
    fixture.db.exec(`
      CREATE TABLE cache (key TEXT PRIMARY KEY);
      CREATE TABLE prediction_reflections (id INTEGER PRIMARY KEY, reflection_note TEXT);
      INSERT INTO prediction_reflections (id, reflection_note) VALUES (1, 'retired');
    `);
    await assert.rejects(
      migrateDatabase(fixture.db, { databasePath: fixture.databasePath }),
      /incompatible with a safe migration/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM prediction_reflections").get().count, 1);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a drifted current schema is rejected even when user_version matches", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    fixture.db.exec("DROP INDEX idx_analyzed_events_created_at");

    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
    await assert.rejects(
      migrateDatabase(fixture.db, { databasePath: fixture.databasePath }),
      /schema verification failed/,
    );
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current schema rejects required extension columns without defaults", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    fixture.db.exec("ALTER TABLE analyzed_events ADD COLUMN required_extra TEXT NOT NULL");
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current schema rejects unique or partial canonical indexes", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    fixture.db.exec(`
      DROP INDEX idx_analyzed_events_created_at;
      CREATE UNIQUE INDEX idx_analyzed_events_created_at ON analyzed_events (created_at);
    `);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });

    fixture.db.exec(`
      DROP INDEX idx_analyzed_events_created_at;
      CREATE INDEX idx_analyzed_events_created_at ON analyzed_events (created_at) WHERE actionable = 1;
    `);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current schema rejects incorrect required defaults", async () => {
  const fixture = tempDatabase();
  try {
    createLegacySchema(fixture.db);
    fixture.db.exec(`
      ALTER TABLE analyzed_events RENAME TO analyzed_events_legacy;
      CREATE TABLE analyzed_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        market_id TEXT NOT NULL,
        question TEXT NOT NULL,
        url TEXT NOT NULL,
        prediction TEXT,
        status TEXT NOT NULL DEFAULT 'wrong',
        result TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        analysis_conclusion TEXT,
        actual_outcome TEXT,
        qwen_confidence TEXT,
        data_confidence TEXT,
        execution_time INTEGER,
        strategy_version TEXT,
        fair_probability REAL,
        max_entry_price REAL,
        signal_data_at TEXT,
        actionable INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_analyzed_events_created_at ON analyzed_events (created_at);
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current schema rejects NOT NULL drift on a known nullable column", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    replaceAnalyzedEventsSchema(fixture.db, { actualOutcomeDefinition: "TEXT NOT NULL" });
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current schema rejects unexpected defaults on known columns", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    replaceAnalyzedEventsSchema(fixture.db, { predictionDefinition: "TEXT DEFAULT 'UNKNOWN'" });
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("current schema rejects composite primary-key drift", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    replaceAnalyzedEventsSchema(fixture.db, {
      idDefinition: "INTEGER",
      tableConstraint: ", PRIMARY KEY (id, market_id)",
    });
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
