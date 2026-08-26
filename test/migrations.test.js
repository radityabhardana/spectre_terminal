import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import {
  RETIRED_TABLES,
  SCHEMA_VERSION,
  migrateDatabase,
  rollbackSchemaV4MetadataOnly,
  verifyDatabase,
  verifyV3CompatibleDatabase,
} from "../src/migrations.js";

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

function createPhaseAV2Schema(db) {
  createLegacySchema(db);
  db.exec(`CREATE TABLE short_evaluation_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT, market_question TEXT, duration_type TEXT, asset TEXT,
    captured_at TEXT NOT NULL, created_at TEXT NOT NULL, contract_version TEXT NOT NULL, model_version TEXT NOT NULL,
    payload TEXT NOT NULL, audit_payload_hash TEXT NOT NULL
  ); CREATE TRIGGER phase_a_no_update BEFORE UPDATE ON short_evaluation_snapshots BEGIN SELECT RAISE(ABORT, 'phase a snapshots are append-only'); END;
  CREATE TRIGGER phase_a_no_delete BEFORE DELETE ON short_evaluation_snapshots BEGIN SELECT RAISE(ABORT, 'phase a snapshots are append-only'); END;`);
  db.prepare(`INSERT INTO short_evaluation_snapshots (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("btc-v2", "BTC 15m", "15m", "BTC", "2026-08-24T00:15:00.000Z", "2026-08-24T00:15:01.000Z", "phase-a-v1", "model-a", '{"close":1}', "hash-a");
  db.pragma("user_version = 2");
}

const V3_TABLES = Object.freeze([
  "cache",
  "analysis_log",
  "analyzed_events",
  "short_evaluation_snapshots",
  "short_observation_runs",
]);
const V4_TABLES = Object.freeze(["short_market_registry", "short_market_tokens", "short_market_evidence"]);
const V5_TABLES = Object.freeze([...V4_TABLES, "short_calibration_forecasts"]);
const V4_COLUMN_CONTRACTS = Object.freeze({
  short_market_registry: [
    ["market_id", "TEXT", 1, null, 1], ["event_id", "TEXT", 1, null, 0], ["condition_id", "TEXT", 1, null, 0],
    ["series_id", "TEXT", 1, null, 0], ["asset", "TEXT", 1, null, 0], ["duration_type", "TEXT", 1, null, 0],
    ["start_time_ms", "INTEGER", 1, null, 0], ["end_time_ms", "INTEGER", 1, null, 0],
    ["fingerprint_json", "TEXT", 1, null, 0], ["fingerprint_hash", "TEXT", 1, null, 0],
    ["discovery_payload_hash", "TEXT", 1, null, 0], ["parser_version", "TEXT", 1, null, 0], ["created_at", "TEXT", 1, null, 0],
  ],
  short_market_tokens: [
    ["market_id", "TEXT", 1, null, 1], ["outcome", "TEXT", 1, null, 2],
    ["token_id", "TEXT", 1, null, 0], ["created_at", "TEXT", 1, null, 0],
  ],
  short_market_evidence: [
    ["id", "INTEGER", 0, null, 1], ["candidate_key", "TEXT", 1, null, 0], ["market_id", "TEXT", 0, null, 0],
    ["kind", "TEXT", 1, null, 0], ["source", "TEXT", 1, null, 0], ["status", "TEXT", 1, null, 0],
    ["source_timestamp_ms", "INTEGER", 0, null, 0], ["effective_timestamp_ms", "INTEGER", 0, null, 0],
    ["received_timestamp_ms", "INTEGER", 1, null, 0], ["decimal_value_text", "TEXT", 0, null, 0],
    ["outcome", "TEXT", 0, null, 0], ["reason_code", "TEXT", 0, null, 0],
    ["parser_version", "TEXT", 1, null, 0], ["evaluator_version", "TEXT", 1, null, 0],
    ["canonical_payload", "TEXT", 1, null, 0], ["raw_payload_hash", "TEXT", 0, null, 0],
    ["canonical_hash", "TEXT", 1, null, 0], ["idempotency_key", "TEXT", 1, null, 0], ["created_at", "TEXT", 1, null, 0],
  ],
});

function createPopulatedV3Schema(db) {
  createLegacySchema(db);
  db.exec(`
    DROP TABLE prediction_reflections;
    DROP TABLE trade_requests;
    DROP TABLE trade_executions;
    DROP TABLE shadow_balance;
    DROP TABLE shadow_bets;
    DROP TABLE price_alerts;
    DROP TABLE user_profile;
    CREATE INDEX idx_analyzed_events_created_at ON analyzed_events (created_at);
    CREATE TABLE short_evaluation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT, market_question TEXT,
      duration_type TEXT, asset TEXT, captured_at TEXT NOT NULL, created_at TEXT NOT NULL,
      contract_version TEXT NOT NULL, model_version TEXT NOT NULL, payload TEXT NOT NULL,
      audit_payload_hash TEXT NOT NULL, run_id TEXT, sequence INTEGER, collection_mode TEXT,
      scheduled_at TEXT, started_at TEXT, finished_at TEXT, attempt_status TEXT, error_code TEXT
    );
    CREATE TABLE short_observation_runs (
      run_id TEXT PRIMARY KEY, enrollment_key TEXT NOT NULL, market_id TEXT NOT NULL,
      market_question TEXT NOT NULL, asset TEXT NOT NULL, duration_type TEXT NOT NULL,
      config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'observing', 'completed', 'missed', 'invalid')),
      next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
      next_scheduled_at TEXT NOT NULL, lease_token TEXT, lease_owner TEXT,
      lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, terminal_at TEXT, error_code TEXT, error_message TEXT
    );
    CREATE INDEX idx_short_evaluation_snapshots_market_captured_at ON short_evaluation_snapshots (market_id, captured_at);
    CREATE INDEX idx_short_evaluation_snapshots_created_at ON short_evaluation_snapshots (created_at);
    CREATE UNIQUE INDEX ux_short_evaluation_snapshots_run_sequence ON short_evaluation_snapshots (run_id, sequence);
    CREATE UNIQUE INDEX ux_short_observation_runs_enrollment_key ON short_observation_runs (enrollment_key);
    CREATE UNIQUE INDEX ux_short_observation_runs_enrollment_identity ON short_observation_runs (market_id, duration_type, asset);
    CREATE INDEX idx_short_observation_runs_status_scheduled_at ON short_observation_runs (status, next_scheduled_at);
    CREATE INDEX idx_short_observation_runs_lease_expires_at ON short_observation_runs (status, lease_expires_at);
    CREATE TRIGGER trg_short_evaluation_snapshots_no_update BEFORE UPDATE ON short_evaluation_snapshots BEGIN SELECT RAISE(ABORT, 'short evaluation snapshots are append-only'); END;
    CREATE TRIGGER trg_short_evaluation_snapshots_no_delete BEFORE DELETE ON short_evaluation_snapshots BEGIN SELECT RAISE(ABORT, 'short evaluation snapshots are append-only'); END;
  `);
  db.prepare(`
    INSERT INTO short_observation_runs
      (run_id, enrollment_key, market_id, market_question, asset, duration_type, config_json, status,
       next_sequence, next_scheduled_at, lease_token, lease_owner, lease_expires_at, created_at, updated_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "run-v3-7", "enrollment-v3-7", "market-v3-7", "BTC up?", "BTC", "15m", '{"strict":true}', "observing",
    7, "2026-08-25T12:15:00.000Z", "lease-v3-token", "worker-v3", "2026-08-25T12:16:00.000Z",
    "2026-08-25T12:00:00.000Z", "2026-08-25T12:00:30.000Z", "2026-08-25T12:00:01.000Z",
  );
  db.prepare(`
    INSERT INTO short_evaluation_snapshots
      (id, market_id, market_question, duration_type, asset, captured_at, created_at, contract_version,
       model_version, payload, audit_payload_hash, run_id, sequence, collection_mode, scheduled_at,
       started_at, finished_at, attempt_status, error_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    73, "market-v3-7", "BTC up?", "15m", "BTC", "2026-08-25T12:07:30.000Z", "2026-08-25T12:07:31.000Z",
    "contract-v3", "model-v3", '{"z":1,"decimal":"01.2300","nested":{"ok":true}}',
    "sha256:0123456789abcdef", "run-v3-7", 6, "scheduled", "2026-08-25T12:07:30.000Z",
    "2026-08-25T12:07:30.100Z", "2026-08-25T12:07:30.900Z", "ok", null,
  );
  db.pragma("user_version = 3");
}

function v3MasterSnapshot(db) {
  const tableSet = new Set(V3_TABLES);
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
    .filter((item) => tableSet.has(item.name) || tableSet.has(item.tbl_name));
}

function v3DataSnapshot(db) {
  return Object.fromEntries(V3_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function insertV4Rows(db) {
  db.prepare(`
    INSERT INTO short_market_registry
      (market_id, event_id, condition_id, series_id, asset, duration_type, start_time_ms, end_time_ms,
       fingerprint_json, fingerprint_hash, discovery_payload_hash, parser_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "market-100-a", "event-100", "condition-100-a", "10192", "btc", "15m", 1_787_659_200_000, 1_787_660_100_000,
    '{"asset":"btc","duration":"15m"}', "fingerprint-hash", "discovery-hash", "identity-v1", "2026-08-25T12:00:01.000Z",
  );
  const insertToken = db.prepare("INSERT INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)");
  insertToken.run("market-100-a", "UP", "token-100-a-up", "2026-08-25T12:00:01.000Z");
  insertToken.run("market-100-a", "DOWN", "token-100-a-down", "2026-08-25T12:00:01.000Z");
  db.prepare(`
    INSERT INTO short_market_evidence
      (id, candidate_key, market_id, kind, source, status, source_timestamp_ms, effective_timestamp_ms,
       received_timestamp_ms, decimal_value_text, outcome, reason_code, parser_version, evaluator_version,
       canonical_payload, raw_payload_hash, canonical_hash, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    501, "10192:market-100-a", "market-100-a", "BOUNDARY_TWAP", "RTDS", "OK", 1_787_659_200_000,
    1_787_659_200_000, 1_787_659_200_100, "112345.678901234567890123", null, null, "twap-parser-v1",
    "twap-evaluator-v1", '{"status":"OK"}', "raw-hash", "canonical-hash", "boundary:market-100-a:start", "2026-08-25T12:00:00.100Z",
  );
}

function rewriteSchemaSql(db, type, name, transform) {
  const original = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name)?.sql;
  assert.equal(typeof original, "string");
  const replacement = transform(original);
  assert.notEqual(replacement, original);
  db.unsafeMode(true);
  db.pragma("writable_schema = ON");
  try {
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?").run(replacement, type, name);
  } finally {
    db.pragma("writable_schema = OFF");
    db.unsafeMode(false);
  }
  const schemaVersion = db.pragma("schema_version", { simple: true });
  db.pragma(`schema_version = ${schemaVersion + 1}`);
}

function replaceTokenForeignKeyWithCascade(db) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TRIGGER trg_short_market_tokens_no_update;
    DROP TRIGGER trg_short_market_tokens_no_delete;
    DROP INDEX ux_short_market_tokens_token_id;
    ALTER TABLE short_market_tokens RENAME TO short_market_tokens_original;
    CREATE TABLE short_market_tokens (
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN')),
      token_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (market_id, outcome),
      FOREIGN KEY (market_id) REFERENCES short_market_registry (market_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX ux_short_market_tokens_token_id ON short_market_tokens (token_id);
    CREATE TRIGGER trg_short_market_tokens_no_update BEFORE UPDATE ON short_market_tokens BEGIN SELECT RAISE(ABORT, 'short market tokens are immutable'); END;
    CREATE TRIGGER trg_short_market_tokens_no_delete BEFORE DELETE ON short_market_tokens BEGIN SELECT RAISE(ABORT, 'short market tokens are immutable'); END;
    DROP TABLE short_market_tokens_original;
  `);
  db.pragma("foreign_keys = ON");
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
    if (process.platform !== "win32") assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
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

test("v2 migration preserves Phase A rows, hashes, and immutable triggers", async () => {
  const fixture = tempDatabase();
  try {
    createPhaseAV2Schema(fixture.db);
    const before = fixture.db.prepare("SELECT id, market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash FROM short_evaluation_snapshots").all();
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    assert.deepEqual(fixture.db.prepare("SELECT id, market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash FROM short_evaluation_snapshots").all(), before);
    assert.deepEqual(fixture.db.prepare("SELECT run_id, sequence, collection_mode, scheduled_at, started_at, finished_at, attempt_status, error_code FROM short_evaluation_snapshots").get(), { run_id: null, sequence: null, collection_mode: null, scheduled_at: null, started_at: null, finished_at: null, attempt_status: null, error_code: null });
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name IN ('phase_a_no_update', 'phase_a_no_delete')").get().count, 2);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
  } finally { fixture.db.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("pre-commit verification failure rolls back schema, drops, version, and rows", async () => {
  const fixture = tempDatabase();
  try {
    createLegacySchema(fixture.db);
    await assert.rejects(migrateDatabase(fixture.db, { databasePath: fixture.databasePath, verify: () => ({ ok: false }) }), /Database migration verification failed/);
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM analyzed_events").get().count, 1);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM prediction_reflections").get().count, 1);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'short_observation_runs'").get().count, 0);
    for (const table of V4_TABLES) {
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 0);
    }
  } finally { fixture.db.close(); rmSync(fixture.directory, { recursive: true, force: true }); }
});

test("v3 pre-commit failure rolls back all v4 DDL and preserves user_version and data", async () => {
  const fixture = tempDatabase();
  try {
    createPopulatedV3Schema(fixture.db);
    const masterBefore = v3MasterSnapshot(fixture.db);
    const dataBefore = v3DataSnapshot(fixture.db);
    await assert.rejects(
      migrateDatabase(fixture.db, {
        databasePath: fixture.databasePath,
        verify: (candidate) => {
          assert.equal(candidate.pragma("user_version", { simple: true }), 3);
          return { ok: false };
        },
      }),
      /Database migration verification failed/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 3);
    assert.deepEqual(v3MasterSnapshot(fixture.db), masterBefore);
    assert.deepEqual(v3DataSnapshot(fixture.db), dataBefore);
    for (const table of V4_TABLES) {
      assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 0);
    }
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

test("populated v3 migrates additively with byte-identical v3 data and sqlite_master SQL", async () => {
  const fixture = tempDatabase();
  try {
    createPopulatedV3Schema(fixture.db);
    assert.deepEqual(verifyV3CompatibleDatabase(fixture.db), { ok: true, version: 3 });
    const masterBefore = v3MasterSnapshot(fixture.db);
    const dataBefore = v3DataSnapshot(fixture.db);
    const snapshotBefore = fixture.db.prepare("SELECT id, payload, audit_payload_hash FROM short_evaluation_snapshots WHERE id = 73").get();
    const tablesBefore = new Set(fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));

    const result = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "backups"),
      now: () => new Date("2026-08-25T13:00:00.000Z"),
    });

    assert.equal(result.fromVersion, 3);
    assert.equal(result.toVersion, SCHEMA_VERSION);
    assert.ok(result.backupPath);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
    assert.deepEqual(v3MasterSnapshot(fixture.db), masterBefore);
    assert.deepEqual(v3DataSnapshot(fixture.db), dataBefore);
    const snapshotAfter = fixture.db.prepare("SELECT id, payload, audit_payload_hash FROM short_evaluation_snapshots WHERE id = 73").get();
    assert.deepEqual(snapshotAfter, snapshotBefore);
    assert.equal(Buffer.compare(Buffer.from(snapshotAfter.payload), Buffer.from(snapshotBefore.payload)), 0);
    assert.equal(Buffer.compare(Buffer.from(snapshotAfter.audit_payload_hash), Buffer.from(snapshotBefore.audit_payload_hash)), 0);
    assert.deepEqual(
      fixture.db.prepare("SELECT run_id, status, next_sequence, next_scheduled_at, lease_token, lease_owner, lease_expires_at FROM short_observation_runs").get(),
      dataBefore.short_observation_runs.map(({ run_id, status, next_sequence, next_scheduled_at, lease_token, lease_owner, lease_expires_at }) => ({ run_id, status, next_sequence, next_scheduled_at, lease_token, lease_owner, lease_expires_at }))[0],
    );
    const tablesAfter = new Set(fixture.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    assert.deepEqual([...tablesAfter].filter((table) => !tablesBefore.has(table)).sort(), [...V5_TABLES].sort());
    assert.equal(fixture.db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(fixture.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("v4 tables enforce identity, token, evidence, FK, and immutability contracts", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    for (const [table, expected] of Object.entries(V4_COLUMN_CONTRACTS)) {
      assert.deepEqual(
        fixture.db.prepare(`PRAGMA table_info(${table})`).all().map(({ name, type, notnull, dflt_value, pk }) => [name, type, notnull, dflt_value, pk]),
        expected,
      );
    }
    insertV4Rows(fixture.db);

    assert.throws(() => fixture.db.exec(`
      INSERT INTO short_market_registry
        (market_id, event_id, condition_id, series_id, asset, duration_type, start_time_ms, end_time_ms,
         fingerprint_json, fingerprint_hash, discovery_payload_hash, parser_version, created_at)
      VALUES ('bad-series', 'event', 'condition-bad-series', '10191', 'btc', '15m', 0, 900000, '{}', 'f', 'd', 'p', 'now')
    `), /CHECK constraint failed/);
    assert.throws(() => fixture.db.exec(`
      INSERT INTO short_market_registry
        (market_id, event_id, condition_id, series_id, asset, duration_type, start_time_ms, end_time_ms,
         fingerprint_json, fingerprint_hash, discovery_payload_hash, parser_version, created_at)
      VALUES ('bad-duration', 'event', 'condition-bad-duration', '10192', 'btc', '15m', 0, 899999, '{}', 'f', 'd', 'p', 'now')
    `), /CHECK constraint failed/);
    assert.throws(() => fixture.db.exec(`
      INSERT INTO short_market_registry
        (market_id, event_id, condition_id, series_id, asset, duration_type, start_time_ms, end_time_ms,
         fingerprint_json, fingerprint_hash, discovery_payload_hash, parser_version, created_at)
      VALUES ('duplicate-condition', 'event', 'condition-100-a', '10192', 'btc', '15m', 0, 900000, '{}', 'f', 'd', 'p', 'now')
    `), /registry reinsert is forbidden/);
    assert.throws(() => fixture.db.prepare("INSERT INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)").run("market-100-a", "YES", "bad-token", "now"), /CHECK constraint failed/);
    assert.throws(() => fixture.db.prepare("INSERT INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)").run("missing-market", "UP", "orphan-token", "now"), /FOREIGN KEY constraint failed/);
    assert.throws(() => fixture.db.prepare("INSERT INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)").run("market-100-a", "UP", "token-100-a-down", "now"), /token reinsert is forbidden/);

    const insertEvidence = fixture.db.prepare(`
      INSERT INTO short_market_evidence
        (candidate_key, market_id, kind, source, status, source_timestamp_ms, effective_timestamp_ms,
         received_timestamp_ms, decimal_value_text, outcome, reason_code, parser_version, evaluator_version,
         canonical_payload, raw_payload_hash, canonical_hash, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const base = ["candidate", null, "DISCOVERY", "GAMMA", "OK", null, null, 1, null, null, null, "p1", "e1", "{}", null, "hash", "key", "now"];
    for (const [index, replacement] of [[0, "   "], [2, "UNKNOWN_KIND"], [3, "UNKNOWN_SOURCE"], [4, "UNKNOWN_STATUS"], [9, "SIDEWAYS"]]) {
      const values = [...base]; values[index] = replacement; values[16] = `key-${index}`;
      assert.throws(() => insertEvidence.run(...values), /CHECK constraint failed/);
    }
    const badTimestamp = [...base]; badTimestamp[5] = 1.5; badTimestamp[16] = "key-timestamp";
    assert.throws(() => insertEvidence.run(...badTimestamp), /CHECK constraint failed/);
    const badReceivedTimestamp = [...base]; badReceivedTimestamp[7] = 1.5; badReceivedTimestamp[16] = "key-received-timestamp";
    assert.throws(() => insertEvidence.run(...badReceivedTimestamp), /CHECK constraint failed/);
    const orphan = [...base]; orphan[1] = "missing-market"; orphan[16] = "key-orphan";
    assert.throws(() => insertEvidence.run(...orphan), /FOREIGN KEY constraint failed/);
    assert.equal(insertEvidence.run(...base).changes, 1);
    assert.throws(() => insertEvidence.run(...base), /evidence reinsert is forbidden/);

    assert.throws(() => fixture.db.exec("UPDATE short_market_registry SET event_id = 'changed' WHERE market_id = 'market-100-a'"), /immutable/);
    assert.throws(() => fixture.db.exec("DELETE FROM short_market_registry WHERE market_id = 'market-100-a'"), /immutable/);
    assert.throws(() => fixture.db.exec("UPDATE short_market_tokens SET token_id = 'changed' WHERE market_id = 'market-100-a'"), /immutable/);
    assert.throws(() => fixture.db.exec("DELETE FROM short_market_tokens WHERE market_id = 'market-100-a'"), /immutable/);
    assert.throws(() => fixture.db.exec("UPDATE short_market_evidence SET status = 'DATA_GAP' WHERE id = 501"), /append-only/);
    assert.throws(() => fixture.db.exec("DELETE FROM short_market_evidence WHERE id = 501"), /append-only/);

    for (const table of ["short_market_tokens", "short_market_evidence"]) {
      const foreignKey = fixture.db.prepare(`PRAGMA foreign_key_list(${table})`).get();
      assert.deepEqual({ table: foreignKey.table, from: foreignKey.from, to: foreignKey.to, onUpdate: foreignKey.on_update, onDelete: foreignKey.on_delete }, {
        table: "short_market_registry", from: "market_id", to: "market_id", onUpdate: "NO ACTION", onDelete: "NO ACTION",
      });
    }
    assert.equal(fixture.db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(fixture.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("BEFORE INSERT guards block INSERT OR REPLACE with recursive triggers disabled and preserve original rows", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    insertV4Rows(fixture.db);
    fixture.db.pragma("recursive_triggers = OFF");
    assert.equal(fixture.db.pragma("recursive_triggers", { simple: true }), 0);
    assert.equal(fixture.db.pragma("foreign_keys", { simple: true }), 1);

    const registryBefore = fixture.db.prepare("SELECT rowid AS hidden_rowid, * FROM short_market_registry WHERE market_id = 'market-100-a'").get();
    const tokensBefore = fixture.db.prepare("SELECT rowid AS hidden_rowid, * FROM short_market_tokens WHERE market_id = 'market-100-a' ORDER BY outcome").all();
    const evidenceBefore = fixture.db.prepare("SELECT * FROM short_market_evidence WHERE id = 501").get();
    const registryColumns = ["market_id", "event_id", "condition_id", "series_id", "asset", "duration_type", "start_time_ms", "end_time_ms", "fingerprint_json", "fingerprint_hash", "discovery_payload_hash", "parser_version", "created_at"];
    const evidenceColumns = ["id", "candidate_key", "market_id", "kind", "source", "status", "source_timestamp_ms", "effective_timestamp_ms", "received_timestamp_ms", "decimal_value_text", "outcome", "reason_code", "parser_version", "evaluator_version", "canonical_payload", "raw_payload_hash", "canonical_hash", "idempotency_key", "created_at"];

    const changedRegistry = { ...registryBefore, event_id: "replacement-event" };
    assert.throws(() => fixture.db.prepare(`INSERT OR REPLACE INTO short_market_registry (${registryColumns.join(", ")}) VALUES (${registryColumns.map(() => "?").join(", ")})`).run(...registryColumns.map((column) => changedRegistry[column])), /registry reinsert is forbidden/);
    const conditionReplacement = { ...registryBefore, market_id: "replacement-market", event_id: "replacement-event" };
    assert.throws(() => fixture.db.prepare(`INSERT OR REPLACE INTO short_market_registry (${registryColumns.join(", ")}) VALUES (${registryColumns.map(() => "?").join(", ")})`).run(...registryColumns.map((column) => conditionReplacement[column])), /registry reinsert is forbidden/);
    const rowidRegistryReplacement = {
      ...registryBefore,
      market_id: "rowid-replacement-market",
      event_id: "rowid-replacement-event",
      condition_id: "rowid-replacement-condition",
    };
    assert.throws(() => fixture.db.prepare(`INSERT OR REPLACE INTO short_market_registry (rowid, ${registryColumns.join(", ")}) VALUES (?, ${registryColumns.map(() => "?").join(", ")})`).run(
      registryBefore.hidden_rowid,
      ...registryColumns.map((column) => rowidRegistryReplacement[column]),
    ), /registry reinsert is forbidden/);

    assert.equal(fixture.db.prepare(`INSERT INTO short_market_registry (${registryColumns.join(", ")}) VALUES (${registryColumns.map(() => "?").join(", ")})`).run(
      "second-market", "second-event", "second-condition", "10192", "btc", "15m", 1_787_660_100_000, 1_787_661_000_000,
      registryBefore.fingerprint_json, registryBefore.fingerprint_hash, "d".repeat(64), "identity-v1", "2026-08-25T12:15:01.000Z",
    ).changes, 1);
    assert.throws(() => fixture.db.prepare("INSERT OR REPLACE INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)").run("market-100-a", "UP", "replacement-token", "2026-08-25T12:00:01.000Z"), /token reinsert is forbidden/);
    assert.throws(() => fixture.db.prepare("INSERT OR REPLACE INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)").run("second-market", "UP", "token-100-a-up", "2026-08-25T12:00:01.000Z"), /token reinsert is forbidden/);
    const existingUpToken = tokensBefore.find((token) => token.outcome === "UP");
    assert.throws(() => fixture.db.prepare("INSERT OR REPLACE INTO short_market_tokens (rowid, market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?, ?)").run(
      existingUpToken.hidden_rowid, "second-market", "DOWN", "rowid-replacement-token", "2026-08-25T12:15:01.000Z",
    ), /token reinsert is forbidden/);
    assert.equal(fixture.db.prepare("INSERT INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)").run(
      "second-market", "UP", "normal-fresh-token", "2026-08-25T12:15:01.000Z",
    ).changes, 1);

    const changedEvidence = { ...evidenceBefore, canonical_payload: '{"changed":true}', canonical_hash: "e".repeat(64), idempotency_key: "replacement-evidence-key" };
    assert.throws(() => fixture.db.prepare(`INSERT OR REPLACE INTO short_market_evidence (${evidenceColumns.join(", ")}) VALUES (${evidenceColumns.map(() => "?").join(", ")})`).run(...evidenceColumns.map((column) => changedEvidence[column])), /evidence reinsert is forbidden/);
    const idempotencyReplacement = { ...evidenceBefore, id: 999_501, canonical_payload: '{"changed":true}', canonical_hash: "e".repeat(64) };
    assert.throws(() => fixture.db.prepare(`INSERT OR REPLACE INTO short_market_evidence (${evidenceColumns.join(", ")}) VALUES (${evidenceColumns.map(() => "?").join(", ")})`).run(...evidenceColumns.map((column) => idempotencyReplacement[column])), /evidence reinsert is forbidden/);

    assert.deepEqual(fixture.db.prepare("SELECT rowid AS hidden_rowid, * FROM short_market_registry WHERE market_id = 'market-100-a'").get(), registryBefore);
    assert.deepEqual(fixture.db.prepare("SELECT rowid AS hidden_rowid, * FROM short_market_tokens WHERE market_id = 'market-100-a' ORDER BY outcome").all(), tokensBefore);
    assert.deepEqual(fixture.db.prepare("SELECT * FROM short_market_evidence WHERE id = 501").get(), evidenceBefore);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM short_market_registry WHERE market_id = 'replacement-market'").get().count, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM short_market_registry WHERE market_id = 'rowid-replacement-market'").get().count, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM short_market_tokens WHERE token_id = 'rowid-replacement-token'").get().count, 0);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM short_market_tokens WHERE market_id = 'second-market' AND token_id = 'normal-fresh-token'").get().count, 1);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM short_market_evidence WHERE id = 999501").get().count, 0);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("schema rejects malformed terminal resolution evidence and nonterminal RESOLUTION/OK rows", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    insertV4Rows(fixture.db);
    const insert = fixture.db.prepare(`INSERT INTO short_market_evidence
      (candidate_key, market_id, kind, source, status, source_timestamp_ms, effective_timestamp_ms,
       received_timestamp_ms, decimal_value_text, outcome, reason_code, parser_version, evaluator_version,
       canonical_payload, raw_payload_hash, canonical_hash, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const base = ["resolution-candidate", "market-100-a", "RESOLUTION", "GAMMA", "RESOLVED", null, null, 1_787_660_100_100, null, "UP", null, "parser-v1", "evaluator-v1", "{}", null, "f".repeat(64), "resolution-key", "2026-08-25T12:15:00.100Z"];
    const malformed = [
      [2, "BOUNDARY_TWAP", "wrong-kind"],
      [1, null, "null-market"],
      [9, null, "null-outcome"],
      [3, "RTDS", "wrong-source"],
      [4, "OK", "resolution-ok"],
    ];
    for (const [index, value, suffix] of malformed) {
      const values = [...base]; values[index] = value; values[16] = `resolution-key-${suffix}`;
      assert.throws(() => insert.run(...values), /resolution contract violation/);
    }
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM short_market_evidence WHERE idempotency_key LIKE 'resolution-key-%'").get().count, 0);
    const resolutionTriggerSql = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_short_market_evidence_resolution_contract'").get().sql;
    fixture.db.exec("DROP TRIGGER trg_short_market_evidence_resolution_contract");
    const checkOnlyValues = [...base]; checkOnlyValues[3] = "RTDS"; checkOnlyValues[16] = "resolution-key-check-only";
    assert.throws(() => insert.run(...checkOnlyValues), /CHECK constraint failed/);
    fixture.db.exec(`${resolutionTriggerSql};`);
    assert.equal(insert.run(...base).changes, 1);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("v4 verification rejects new table, CHECK, unique/partial index, immutable insert/update/delete trigger, and FK drift", async (t) => {
  const cases = [
    ["table column", (db) => db.exec("ALTER TABLE short_market_evidence ADD COLUMN unexpected TEXT")],
    ["CHECK clause", (db) => rewriteSchemaSql(db, "table", "short_market_registry", (sql) => sql.replace("series_id = '10192'", "series_id IN ('10192', '10191')"))],
    ["resolution CHECK clause", (db) => rewriteSchemaSql(db, "table", "short_market_evidence", (sql) => sql.replace("status <> 'RESOLVED'", "status = 'RESOLVED'"))],
    ["unique index", (db) => db.exec("DROP INDEX idx_short_market_evidence_candidate_kind; CREATE UNIQUE INDEX idx_short_market_evidence_candidate_kind ON short_market_evidence (candidate_key, kind)")],
    ["partial index", (db) => db.exec("DROP INDEX idx_short_market_evidence_market_kind_effective; CREATE INDEX idx_short_market_evidence_market_kind_effective ON short_market_evidence (market_id, kind, effective_timestamp_ms) WHERE market_id IS NOT NULL")],
    ["extra index", (db) => db.exec("CREATE INDEX idx_short_market_evidence_unapproved ON short_market_evidence (status)")],
    ["trigger SQL", (db) => db.exec("DROP TRIGGER trg_short_market_evidence_no_delete; CREATE TRIGGER trg_short_market_evidence_no_delete BEFORE DELETE ON short_market_evidence BEGIN SELECT RAISE(ABORT, 'wrong'); END")],
    ["reinsert guard SQL", (db) => db.exec("DROP TRIGGER trg_short_market_registry_no_reinsert; CREATE TRIGGER trg_short_market_registry_no_reinsert BEFORE INSERT ON short_market_registry BEGIN SELECT RAISE(ABORT, 'wrong'); END")],
    ["registry rowid guard predicate", (db) => rewriteSchemaSql(db, "trigger", "trg_short_market_registry_no_reinsert", (sql) => sql.replace("rowid = NEW.rowid OR ", ""))],
    ["token rowid guard predicate", (db) => rewriteSchemaSql(db, "trigger", "trg_short_market_tokens_no_reinsert", (sql) => sql.replace("rowid = NEW.rowid OR ", ""))],
    ["resolution guard SQL", (db) => db.exec("DROP TRIGGER trg_short_market_evidence_resolution_contract; CREATE TRIGGER trg_short_market_evidence_resolution_contract BEFORE INSERT ON short_market_evidence BEGIN SELECT RAISE(ABORT, 'wrong'); END")],
    ["cascading FK", (db) => {
      replaceTokenForeignKeyWithCascade(db);
      assert.equal(db.prepare("PRAGMA foreign_key_list(short_market_tokens)").get().on_delete, "CASCADE");
    }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = tempDatabase();
      try {
        await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
        mutate(fixture.db);
        assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });
        await assert.rejects(migrateDatabase(fixture.db, { databasePath: fixture.databasePath }), /schema verification failed/);
      } finally {
        fixture.db.close();
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    });
  }
});

test("accepted pre-guard v4 receives backup-first insert guards without changing rows or user_version", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    insertV4Rows(fixture.db);
    const rowsBefore = Object.fromEntries(V4_TABLES.map((table) => [table, fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    fixture.db.exec(`
      DROP TRIGGER trg_short_market_registry_no_reinsert;
      DROP TRIGGER trg_short_market_tokens_no_reinsert;
      DROP TRIGGER trg_short_market_evidence_no_reinsert;
      DROP TRIGGER trg_short_market_evidence_resolution_contract;
    `);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });

    const result = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "guard-remediation-backups"),
      now: () => new Date("2026-08-25T15:00:00.000Z"),
    });
    assert.deepEqual({ fromVersion: result.fromVersion, toVersion: result.toVersion, migrated: result.migrated }, { fromVersion: SCHEMA_VERSION, toVersion: SCHEMA_VERSION, migrated: true });
    assert.ok(result.backupPath);
    assert.equal(fixture.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
    for (const table of V4_TABLES) assert.deepEqual(fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rowsBefore[table]);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("accepted pre-rowid v4 guards receive backup-first exact rowid predicates without changing rows", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    insertV4Rows(fixture.db);
    const rowsBefore = Object.fromEntries(V4_TABLES.map((table) => [table, fixture.db.prepare(`SELECT rowid AS hidden_rowid, * FROM ${table} ORDER BY rowid`).all()]));
    for (const triggerName of ["trg_short_market_registry_no_reinsert", "trg_short_market_tokens_no_reinsert"]) {
      const currentSql = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName).sql;
      const preRowidSql = currentSql.replace("rowid = NEW.rowid OR ", "");
      assert.notEqual(preRowidSql, currentSql);
      fixture.db.exec(`DROP TRIGGER ${triggerName}; ${preRowidSql};`);
    }
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });

    const result = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "rowid-remediation-backups"),
      now: () => new Date("2026-08-25T15:15:00.000Z"),
    });
    assert.deepEqual({ fromVersion: result.fromVersion, toVersion: result.toVersion, migrated: result.migrated }, { fromVersion: SCHEMA_VERSION, toVersion: SCHEMA_VERSION, migrated: true });
    assert.ok(result.backupPath);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
    for (const table of V4_TABLES) assert.deepEqual(fixture.db.prepare(`SELECT rowid AS hidden_rowid, * FROM ${table} ORDER BY rowid`).all(), rowsBefore[table]);
    for (const triggerName of ["trg_short_market_registry_no_reinsert", "trg_short_market_tokens_no_reinsert"]) {
      assert.match(fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName).sql, /rowid = NEW\.rowid/);
    }
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("pre-CHECK v4 evidence rebuild preserves IDs and hashes while installing exact constraints", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    insertV4Rows(fixture.db);
    const resolutionTriggerSql = fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_short_market_evidence_resolution_contract'").get().sql;
    fixture.db.exec("DROP TRIGGER trg_short_market_evidence_resolution_contract");
    rewriteSchemaSql(fixture.db, "table", "short_market_evidence", (sql) => {
      const marker = ",\n    CHECK (status <> 'RESOLVED'";
      const markerIndex = sql.indexOf(marker);
      assert.ok(markerIndex > 0);
      return `${sql.slice(0, markerIndex)}\n  )`;
    });
    fixture.db.exec(`${resolutionTriggerSql};`);
    const rowsBefore = fixture.db.prepare("SELECT * FROM short_market_evidence ORDER BY id").all();
    const sequenceBefore = fixture.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'short_market_evidence'").get().seq;
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: SCHEMA_VERSION });

    const result = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "check-remediation-backups"),
      now: () => new Date("2026-08-25T15:30:00.000Z"),
    });
    assert.equal(result.migrated, true);
    assert.ok(result.backupPath);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
    assert.deepEqual(fixture.db.prepare("SELECT * FROM short_market_evidence ORDER BY id").all(), rowsBefore);
    assert.equal(fixture.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'short_market_evidence'").get().seq, sequenceBefore);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'short_market_evidence_pre_gate_2'").get().count, 0);
    assert.match(fixture.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'short_market_evidence'").get().sql, /status <> 'RESOLVED'/);
    assert.equal(fixture.db.pragma("ignore_check_constraints", { simple: true }), 0);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("verified backup can replace a migrated database and restore populated v3", async () => {
  const fixture = tempDatabase();
  let db = fixture.db;
  try {
    createPopulatedV3Schema(db);
    const before = v3DataSnapshot(db);
    const result = await migrateDatabase(db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "backups"),
      now: () => new Date("2026-08-25T14:00:00.000Z"),
    });
    assert.ok(result.backupPath);
    insertV4Rows(db);
    db.close();
    rmSync(`${fixture.databasePath}-wal`, { force: true });
    rmSync(`${fixture.databasePath}-shm`, { force: true });
    copyFileSync(result.backupPath, fixture.databasePath);
    db = new Database(fixture.databasePath);
    db.pragma("foreign_keys = ON");
    assert.deepEqual(verifyV3CompatibleDatabase(db), { ok: true, version: 3 });
    assert.deepEqual(v3DataSnapshot(db), before);
    for (const table of V4_TABLES) {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 0);
    }
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    await migrateDatabase(db, { databasePath: fixture.databasePath });
    assert.deepEqual(verifyDatabase(db), { ok: true, version: SCHEMA_VERSION });
  } finally {
    if (db.open) db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("metadata-only v4 to v3 to v4 round trip preserves every v4 row and ID", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    insertV4Rows(fixture.db);
    const rowsBefore = Object.fromEntries(V4_TABLES.map((table) => [table, fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const v3MasterBefore = v3MasterSnapshot(fixture.db);

    assert.deepEqual(rollbackSchemaV4MetadataOnly(fixture.db), { fromVersion: SCHEMA_VERSION, toVersion: 3, rolledBack: true, metadataOnly: true });
    assert.deepEqual(verifyV3CompatibleDatabase(fixture.db), { ok: true, version: 3 });
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: 3 });
    assert.deepEqual(v3MasterSnapshot(fixture.db), v3MasterBefore);
    for (const table of V4_TABLES) assert.deepEqual(fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rowsBefore[table]);

    const upgrade = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "round-trip-backups"),
    });
    assert.equal(upgrade.fromVersion, 3);
    assert.equal(upgrade.toVersion, SCHEMA_VERSION);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: SCHEMA_VERSION });
    for (const table of V4_TABLES) assert.deepEqual(fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rowsBefore[table]);
    assert.equal(fixture.db.prepare("SELECT id FROM short_market_evidence").get().id, 501);
    assert.equal(fixture.db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(fixture.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("metadata-only rollback fails closed on v4 drift without changing user_version", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    fixture.db.exec("DROP TRIGGER trg_short_market_registry_no_update");
    assert.throws(() => rollbackSchemaV4MetadataOnly(fixture.db), /rollback verification failed/);
    assert.equal(fixture.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("re-upgrade fails closed instead of repairing drifted metadata-downgraded v4 tables", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    rollbackSchemaV4MetadataOnly(fixture.db);
    fixture.db.exec("DROP INDEX idx_short_market_evidence_candidate_kind");
    await assert.rejects(
      migrateDatabase(fixture.db, { databasePath: fixture.databasePath }),
      /Existing v4 schema is incompatible with a safe migration/,
    );
    assert.equal(fixture.db.pragma("user_version", { simple: true }), 3);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'idx_short_market_evidence_candidate_kind'").get().count, 0);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("v4 to v5 migration preserves rows, is idempotent, and rejects v5 structure drift", async () => {
  const fixture = tempDatabase();
  try {
    await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    fixture.db.exec(`
      DROP TRIGGER trg_short_calibration_forecasts_no_update;
      DROP TRIGGER trg_short_calibration_forecasts_no_delete;
      DROP INDEX idx_short_calibration_forecasts_market_captured;
      DROP INDEX idx_short_calibration_forecasts_model_version;
      DROP TABLE short_calibration_forecasts;
      PRAGMA user_version = 4;
    `);
    insertV4Rows(fixture.db);
    const before = Object.fromEntries(V4_TABLES.map((table) => [table, fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

    const migrated = await migrateDatabase(fixture.db, {
      databasePath: fixture.databasePath,
      backupDirectory: path.join(fixture.directory, "v5-backups"),
      now: () => new Date("2028-01-01T00:00:00.000Z"),
    });
    assert.deepEqual({ fromVersion: migrated.fromVersion, toVersion: migrated.toVersion, migrated: migrated.migrated }, {
      fromVersion: 4, toVersion: 5, migrated: true,
    });
    assert.ok(migrated.backupPath);
    assert.deepEqual(verifyDatabase(fixture.db), { ok: true, version: 5 });
    for (const table of V4_TABLES) assert.deepEqual(fixture.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table]);

    const rerun = await migrateDatabase(fixture.db, { databasePath: fixture.databasePath });
    assert.deepEqual({ fromVersion: rerun.fromVersion, toVersion: rerun.toVersion, migrated: rerun.migrated, backupPath: rerun.backupPath }, {
      fromVersion: 5, toVersion: 5, migrated: false, backupPath: null,
    });
    fixture.db.exec("DROP INDEX idx_short_calibration_forecasts_model_version");
    assert.deepEqual(verifyDatabase(fixture.db), { ok: false, version: 5 });
    await assert.rejects(migrateDatabase(fixture.db, { databasePath: fixture.databasePath }), /schema verification failed/);
  } finally {
    fixture.db.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
