import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const SCHEMA_VERSION = 1;
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
  const columns = new Map(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => [column.name, column]));
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

function legacyCanonicalTablesCompatible(db, tables) {
  return Object.entries(CORE_TABLE_REQUIREMENTS).every(([table, requirements]) => {
    if (!tables.has(table)) return true;
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
  `);

  const columns = new Set(db.prepare("PRAGMA table_info(analyzed_events)").all().map((column) => column.name));
  for (const [name, definition] of ANALYZED_EVENT_COLUMNS) {
    if (!columns.has(name)) db.exec(`ALTER TABLE analyzed_events ADD COLUMN ${name} ${definition}`);
  }
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
    && canonicalIndexPresent(db);
  const retiredAbsent = RETIRED_TABLES.every((table) => !tables.has(table));
  return { ok: version === SCHEMA_VERSION && canonicalPresent && retiredAbsent, version };
}

export async function migrateDatabase(db, {
  databasePath,
  backupDirectory = path.join(path.dirname(databasePath), "backups"),
  now = () => new Date(),
  backupDatabase = defaultBackupDatabase,
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
  })();

  const verification = verifyDatabase(db);
  if (!verification.ok) throw new Error("Database migration verification failed");
  return { fromVersion, toVersion: SCHEMA_VERSION, migrated: true, backupPath };
}
