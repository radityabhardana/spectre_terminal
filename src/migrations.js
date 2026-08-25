import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const SCHEMA_VERSION = 3;
export const RETIRED_TABLES = [
  "trade_requests",
  "trade_executions",
  "prediction_reflections",
  "shadow_balance",
  "shadow_bets",
  "price_alerts",
  "user_profile",
];

const ANALYZED_EVENT_COLUMNS = [
  ["analysis_conclusion", "TEXT"],
  ["actual_outcome", "TEXT"],
  ["qwen_confidence", "TEXT"],
  ["data_confidence", "TEXT"],
  ["execution_time", "INTEGER"],
  ["strategy_version", "TEXT"],
  ["fair_probability", "REAL"],
  ["max_entry_price", "REAL"],
  ["signal_data_at", "TEXT"],
  ["actionable", "INTEGER NOT NULL DEFAULT 0"],
];

const CORE_TABLE_REQUIREMENTS = {
  cache: [
    ["key", "TEXT", false, true],
    ["value", "TEXT", true, false],
    ["saved_at", "INTEGER", true, false],
  ],
  analysis_log: [
    ["id", "INTEGER", false, true],
    ["created_at", "TEXT", true, false],
    ["data", "TEXT", true, false],
  ],
  analyzed_events: [
    ["id", "INTEGER", false, true],
    ["market_id", "TEXT", true, false],
    ["question", "TEXT", true, false],
    ["url", "TEXT", true, false],
    ["prediction", "TEXT", false, false],
    ["status", "TEXT", true, false, "'belum selesai'"],
    ["result", "TEXT", false, false],
    ["created_at", "TEXT", true, false],
    ["resolved_at", "TEXT", false, false],
  ],
};

const FULL_ANALYZED_EVENT_REQUIREMENTS = [
  ...CORE_TABLE_REQUIREMENTS.analyzed_events,
  ...ANALYZED_EVENT_COLUMNS.map(([name, definition]) => [
    name,
    definition.split(/\s+/)[0],
    definition.includes("NOT NULL"),
    false,
    name === "actionable" ? "0" : undefined,
  ]),
];

const SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS = [
  ["id", "INTEGER", false, true], ["market_id", "TEXT", false, false],
  ["market_question", "TEXT", false, false], ["duration_type", "TEXT", false, false],
  ["asset", "TEXT", false, false], ["captured_at", "TEXT", true, false],
  ["created_at", "TEXT", true, false], ["contract_version", "TEXT", true, false],
  ["model_version", "TEXT", true, false], ["payload", "TEXT", true, false],
  ["audit_payload_hash", "TEXT", true, false], ["run_id", "TEXT", false, false],
  ["sequence", "INTEGER", false, false], ["collection_mode", "TEXT", false, false],
  ["scheduled_at", "TEXT", false, false], ["started_at", "TEXT", false, false],
  ["finished_at", "TEXT", false, false], ["attempt_status", "TEXT", false, false],
  ["error_code", "TEXT", false, false],
];
const LEGACY_SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS = SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS.slice(0, 11);
const SHORT_OBSERVATION_RUN_REQUIREMENTS = [
  ["run_id", "TEXT", false, true], ["enrollment_key", "TEXT", true, false],
  ["market_id", "TEXT", true, false], ["market_question", "TEXT", true, false],
  ["asset", "TEXT", true, false], ["duration_type", "TEXT", true, false],
  ["config_json", "TEXT", true, false], ["status", "TEXT", true, false, "'scheduled'"],
  ["next_sequence", "INTEGER", true, false, "0"], ["next_scheduled_at", "TEXT", true, false],
  ["lease_token", "TEXT", false, false], ["lease_owner", "TEXT", false, false],
  ["lease_expires_at", "TEXT", false, false], ["created_at", "TEXT", true, false],
  ["updated_at", "TEXT", true, false], ["started_at", "TEXT", false, false],
  ["completed_at", "TEXT", false, false], ["terminal_at", "TEXT", false, false],
  ["error_code", "TEXT", false, false], ["error_message", "TEXT", false, false],
];
CORE_TABLE_REQUIREMENTS.short_evaluation_snapshots = SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS;
CORE_TABLE_REQUIREMENTS.short_observation_runs = SHORT_OBSERVATION_RUN_REQUIREMENTS;

function tableNames(db) {
  return new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name),
  );
}

function normalizeDefault(value) {
  let normalized = value == null ? null : String(value).trim();
  while (normalized?.startsWith("(") && normalized.endsWith(")")) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function tableMatches(db, table, requirements, knownRequirements = requirements) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all();
  const columns = new Map(actual.map((column) => [column.name, column]));
  if (actual.slice(0, requirements.length).some((column, i) => column.name !== requirements[i][0])) return false;
  const expectedColumnsMatch = requirements.every(([name, type, notNull, primaryKey, defaultValue = null]) => {
    const column = columns.get(name);
    return column
      && String(column.type).toUpperCase() === type
      && column.notnull === Number(notNull)
      && column.pk === (primaryKey ? 1 : 0)
      && normalizeDefault(column.dflt_value) === defaultValue;
  });
  if (!expectedColumnsMatch) return false;

  const knownNames = new Set(knownRequirements.map(([name]) => name));
  return [...columns.values()].every((column) =>
    knownNames.has(column.name)
    || column.notnull !== 1
    || column.dflt_value != null
    || column.pk > 0
  );
}

function canonicalIndexPresent(db) {
  const index = db.prepare("PRAGMA index_list(analyzed_events)").all()
    .find((candidate) => candidate.name === "idx_analyzed_events_created_at");
  if (!index || index.unique !== 0 || index.partial !== 0) return false;
  const columns = db.prepare("PRAGMA index_info(idx_analyzed_events_created_at)").all().map((column) => column.name);
  return columns.length === 1 && columns[0] === "created_at";
}

function indexPresent(db, table, name, unique, columns) {
  const index = db.prepare(`PRAGMA index_list(${table})`).all().find((item) => item.name === name);
  if (!index || index.unique !== Number(unique) || index.partial !== 0) return false;
  const actual = db.prepare(`PRAGMA index_info(${name})`).all().map((item) => item.name);
  return actual.length === columns.length && actual.every((item, i) => item === columns[i]);
}

function snapshotTriggersPresent(db) {
  const triggers = new Map(db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
    .map((item) => [item.name, item]));
  return [
    ["trg_short_evaluation_snapshots_no_update", "before update"],
    ["trg_short_evaluation_snapshots_no_delete", "before delete"],
  ].every(([name, event]) => {
    const sql = String(triggers.get(name)?.sql || "").replace(/\s+/g, " ").toLowerCase();
    return triggers.get(name)?.tbl_name === "short_evaluation_snapshots"
      && sql.includes(`create trigger ${name} ${event} on short_evaluation_snapshots`)
      && sql.includes("raise(abort, 'short evaluation snapshots are append-only')");
  });
}

function runsStructurePresent(db) {
  const sql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'short_observation_runs'").get()?.sql || "")
    .replace(/\s+/g, " ").toLowerCase();
  return sql.includes("check (status in ('scheduled', 'observing', 'completed', 'missed', 'invalid'))")
    && sql.includes("check (next_sequence >= 0)");
}

function legacyCanonicalTablesCompatible(db, tables) {
  return Object.entries(CORE_TABLE_REQUIREMENTS).every(([table, requirements]) => {
    if (!tables.has(table)) return true;
    if (table === "short_observation_runs") return false;
    if (table === "short_evaluation_snapshots") {
      return tableMatches(db, table, LEGACY_SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS, LEGACY_SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS);
    }
    const knownRequirements = table === "analyzed_events" ? FULL_ANALYZED_EVENT_REQUIREMENTS : requirements;
    return tableMatches(db, table, requirements, knownRequirements);
  });
}

function createCanonicalSchema(db) {
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

    CREATE TABLE IF NOT EXISTS short_evaluation_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, market_id TEXT, market_question TEXT,
      duration_type TEXT, asset TEXT, captured_at TEXT NOT NULL, created_at TEXT NOT NULL,
      contract_version TEXT NOT NULL, model_version TEXT NOT NULL, payload TEXT NOT NULL,
      audit_payload_hash TEXT NOT NULL, run_id TEXT, sequence INTEGER, collection_mode TEXT,
      scheduled_at TEXT, started_at TEXT, finished_at TEXT, attempt_status TEXT, error_code TEXT
    );

    CREATE TABLE IF NOT EXISTS short_observation_runs (
      run_id TEXT PRIMARY KEY, enrollment_key TEXT NOT NULL, market_id TEXT NOT NULL,
      market_question TEXT NOT NULL, asset TEXT NOT NULL, duration_type TEXT NOT NULL,
      config_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'observing', 'completed', 'missed', 'invalid')),
      next_sequence INTEGER NOT NULL DEFAULT 0 CHECK (next_sequence >= 0),
      next_scheduled_at TEXT NOT NULL, lease_token TEXT, lease_owner TEXT,
      lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, terminal_at TEXT, error_code TEXT, error_message TEXT
    );
  `);

  const columns = new Set(db.prepare("PRAGMA table_info(analyzed_events)").all().map((column) => column.name));
  for (const [name, definition] of ANALYZED_EVENT_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE analyzed_events ADD COLUMN ${name} ${definition}`);
  }
  const snapshotColumns = new Set(db.prepare("PRAGMA table_info(short_evaluation_snapshots)").all().map((column) => column.name));
  for (const [name, type] of SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS.slice(11)) {
    if (!snapshotColumns.has(name)) db.exec(`ALTER TABLE short_evaluation_snapshots ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_short_evaluation_snapshots_market_captured_at ON short_evaluation_snapshots (market_id, captured_at);
    CREATE INDEX IF NOT EXISTS idx_short_evaluation_snapshots_created_at ON short_evaluation_snapshots (created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_short_evaluation_snapshots_run_sequence ON short_evaluation_snapshots (run_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_short_observation_runs_enrollment_key ON short_observation_runs (enrollment_key);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_short_observation_runs_enrollment_identity ON short_observation_runs (market_id, duration_type, asset);
    CREATE INDEX IF NOT EXISTS idx_short_observation_runs_status_scheduled_at ON short_observation_runs (status, next_scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_short_observation_runs_lease_expires_at ON short_observation_runs (status, lease_expires_at);
    CREATE TRIGGER IF NOT EXISTS trg_short_evaluation_snapshots_no_update BEFORE UPDATE ON short_evaluation_snapshots BEGIN SELECT RAISE(ABORT, 'short evaluation snapshots are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trg_short_evaluation_snapshots_no_delete BEFORE DELETE ON short_evaluation_snapshots BEGIN SELECT RAISE(ABORT, 'short evaluation snapshots are append-only'); END;
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_analyzed_events_created_at ON analyzed_events (created_at)");
}

function backupFilename(now) {
  return `database-pre-v${SCHEMA_VERSION}-${now.toISOString().replace(/[:.]/g, "-")}.db`;
}

async function defaultBackupDatabase(db, destination) {
  await db.backup(destination);
}

function verifyBackup(backupPath) {
  const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
  try {
    if (backup.pragma("quick_check", { simple: true }) !== "ok") {
      throw new Error("Database backup failed integrity verification");
    }
  } finally {
    backup.close();
  }
}

export function verifyDatabase(db) {
  if (db.pragma("quick_check", { simple: true }) !== "ok") {
    return { ok: false, version: db.pragma("user_version", { simple: true }) };
  }
  const version = db.pragma("user_version", { simple: true });
  const tables = tableNames(db);
  const canonicalPresent = tableMatches(db, "cache", CORE_TABLE_REQUIREMENTS.cache)
    && tableMatches(db, "analysis_log", CORE_TABLE_REQUIREMENTS.analysis_log)
    && tableMatches(db, "analyzed_events", FULL_ANALYZED_EVENT_REQUIREMENTS)
    && canonicalIndexPresent(db)
    && tableMatches(db, "short_evaluation_snapshots", SHORT_EVALUATION_SNAPSHOT_REQUIREMENTS)
    && indexPresent(db, "short_evaluation_snapshots", "idx_short_evaluation_snapshots_market_captured_at", false, ["market_id", "captured_at"])
    && indexPresent(db, "short_evaluation_snapshots", "idx_short_evaluation_snapshots_created_at", false, ["created_at"])
    && indexPresent(db, "short_evaluation_snapshots", "ux_short_evaluation_snapshots_run_sequence", true, ["run_id", "sequence"])
    && snapshotTriggersPresent(db)
    && tableMatches(db, "short_observation_runs", SHORT_OBSERVATION_RUN_REQUIREMENTS)
    && runsStructurePresent(db)
    && indexPresent(db, "short_observation_runs", "ux_short_observation_runs_enrollment_key", true, ["enrollment_key"])
    && indexPresent(db, "short_observation_runs", "ux_short_observation_runs_enrollment_identity", true, ["market_id", "duration_type", "asset"])
    && indexPresent(db, "short_observation_runs", "idx_short_observation_runs_status_scheduled_at", false, ["status", "next_scheduled_at"])
    && indexPresent(db, "short_observation_runs", "idx_short_observation_runs_lease_expires_at", false, ["status", "lease_expires_at"]);
  const retiredAbsent = RETIRED_TABLES.every((table) => !tables.has(table));
  return { ok: version === SCHEMA_VERSION && canonicalPresent && retiredAbsent, version };
}

export async function migrateDatabase(db, {
  databasePath,
  backupDirectory = path.join(path.dirname(databasePath), "backups"),
  now = () => new Date(),
  backupDatabase = defaultBackupDatabase,
  verify = verifyDatabase,
} = {}) {
  if (!databasePath) throw new Error("databasePath is required for migration safety");

  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(`Database schema v${fromVersion} is newer than supported v${SCHEMA_VERSION}`);
  }
  if (fromVersion === SCHEMA_VERSION) {
    const verification = verifyDatabase(db);
    if (!verification.ok) throw new Error("Database schema verification failed");
    return { fromVersion, toVersion: SCHEMA_VERSION, migrated: false, backupPath: null };
  }

  const existingTables = tableNames(db);
  if (!legacyCanonicalTablesCompatible(db, existingTables)) {
    throw new Error("Legacy canonical schema is incompatible with a safe migration");
  }
  let backupPath = null;
  if (existingTables.size > 0) {
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(backupDirectory, 0o700);
    backupPath = path.join(backupDirectory, backupFilename(now()));
    await backupDatabase(db, backupPath);
    fs.chmodSync(backupPath, 0o600);
    verifyBackup(backupPath);
  }

  db.transaction(() => {
    createCanonicalSchema(db);
    for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    if (!verify(db).ok) throw new Error("Database migration verification failed");
  })();

  const verification = verifyDatabase(db);
  if (!verification.ok) throw new Error("Database migration verification failed");
  return { fromVersion, toVersion: SCHEMA_VERSION, migrated: true, backupPath };
}
