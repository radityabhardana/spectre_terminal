import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const SCHEMA_VERSION = 5;
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

const SHORT_MARKET_REGISTRY_REQUIREMENTS = [
  ["market_id", "TEXT", true, 1],
  ["event_id", "TEXT", true, 0],
  ["condition_id", "TEXT", true, 0],
  ["series_id", "TEXT", true, 0],
  ["asset", "TEXT", true, 0],
  ["duration_type", "TEXT", true, 0],
  ["start_time_ms", "INTEGER", true, 0],
  ["end_time_ms", "INTEGER", true, 0],
  ["fingerprint_json", "TEXT", true, 0],
  ["fingerprint_hash", "TEXT", true, 0],
  ["discovery_payload_hash", "TEXT", true, 0],
  ["parser_version", "TEXT", true, 0],
  ["created_at", "TEXT", true, 0],
];

const SHORT_MARKET_TOKEN_REQUIREMENTS = [
  ["market_id", "TEXT", true, 1],
  ["outcome", "TEXT", true, 2],
  ["token_id", "TEXT", true, 0],
  ["created_at", "TEXT", true, 0],
];

const SHORT_MARKET_EVIDENCE_REQUIREMENTS = [
  ["id", "INTEGER", false, 1],
  ["candidate_key", "TEXT", true, 0],
  ["market_id", "TEXT", false, 0],
  ["kind", "TEXT", true, 0],
  ["source", "TEXT", true, 0],
  ["status", "TEXT", true, 0],
  ["source_timestamp_ms", "INTEGER", false, 0],
  ["effective_timestamp_ms", "INTEGER", false, 0],
  ["received_timestamp_ms", "INTEGER", true, 0],
  ["decimal_value_text", "TEXT", false, 0],
  ["outcome", "TEXT", false, 0],
  ["reason_code", "TEXT", false, 0],
  ["parser_version", "TEXT", true, 0],
  ["evaluator_version", "TEXT", true, 0],
  ["canonical_payload", "TEXT", true, 0],
  ["raw_payload_hash", "TEXT", false, 0],
  ["canonical_hash", "TEXT", true, 0],
  ["idempotency_key", "TEXT", true, 0],
  ["created_at", "TEXT", true, 0],
];

const SHORT_CALIBRATION_FORECAST_REQUIREMENTS = [
  ["id", "INTEGER", false, 1],
  ["market_id", "TEXT", true, 0],
  ["evaluation_snapshot_id", "INTEGER", true, 0],
  ["opening_evidence_id", "INTEGER", true, 0],
  ["captured_timestamp_ms", "INTEGER", true, 0],
  ["oracle_timestamp_ms", "INTEGER", true, 0],
  ["remaining_ms", "INTEGER", true, 0],
  ["probability_up_ppm", "INTEGER", true, 0],
  ["model_version", "TEXT", true, 0],
  ["feature_contract_version", "TEXT", true, 0],
  ["features_json", "TEXT", true, 0],
  ["features_hash", "TEXT", true, 0],
  ["decision_json", "TEXT", true, 0],
  ["decision_hash", "TEXT", true, 0],
  ["idempotency_key", "TEXT", true, 0],
  ["created_at", "TEXT", true, 0],
];

const SHORT_MARKET_REGISTRY_SQL = `
  CREATE TABLE IF NOT EXISTS short_market_registry (
    market_id TEXT NOT NULL PRIMARY KEY,
    event_id TEXT NOT NULL,
    condition_id TEXT NOT NULL,
    series_id TEXT NOT NULL CHECK (series_id = '10192'),
    asset TEXT NOT NULL CHECK (asset = 'btc'),
    duration_type TEXT NOT NULL CHECK (duration_type = '15m'),
    start_time_ms INTEGER NOT NULL CHECK (typeof(start_time_ms) = 'integer'),
    end_time_ms INTEGER NOT NULL CHECK (typeof(end_time_ms) = 'integer'),
    fingerprint_json TEXT NOT NULL,
    fingerprint_hash TEXT NOT NULL,
    discovery_payload_hash TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (end_time_ms - start_time_ms = 900000)
  )`;

const SHORT_MARKET_TOKENS_SQL = `
  CREATE TABLE IF NOT EXISTS short_market_tokens (
    market_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('UP', 'DOWN')),
    token_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (market_id, outcome),
    FOREIGN KEY (market_id) REFERENCES short_market_registry (market_id)
  )`;

const PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL = `
  CREATE TABLE IF NOT EXISTS short_market_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_key TEXT NOT NULL CHECK (length(trim(candidate_key)) > 0),
    market_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('DISCOVERY', 'BOUNDARY_TWAP', 'ORDER_BOOK', 'FEE_POLICY', 'RESOLUTION')),
    source TEXT NOT NULL CHECK (source IN ('GAMMA', 'RTDS', 'CHAINLINK', 'CHAINLINK_FALLBACK', 'POLYMARKET_CLOB', 'CLOB_MARKET_RESOLVED', 'OBSERVER')),
    status TEXT NOT NULL CHECK (status IN ('OK', 'DATA_GAP', 'QUARANTINED', 'UNRESOLVED', 'RESOLVED')),
    source_timestamp_ms INTEGER CHECK (source_timestamp_ms IS NULL OR typeof(source_timestamp_ms) = 'integer'),
    effective_timestamp_ms INTEGER CHECK (effective_timestamp_ms IS NULL OR typeof(effective_timestamp_ms) = 'integer'),
    received_timestamp_ms INTEGER NOT NULL CHECK (typeof(received_timestamp_ms) = 'integer'),
    decimal_value_text TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('UP', 'DOWN')),
    reason_code TEXT,
    parser_version TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    raw_payload_hash TEXT,
    canonical_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (market_id) REFERENCES short_market_registry (market_id)
  )`;

const SHORT_MARKET_EVIDENCE_SQL = `
  CREATE TABLE IF NOT EXISTS short_market_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_key TEXT NOT NULL CHECK (length(trim(candidate_key)) > 0),
    market_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('DISCOVERY', 'BOUNDARY_TWAP', 'ORDER_BOOK', 'FEE_POLICY', 'RESOLUTION')),
    source TEXT NOT NULL CHECK (source IN ('GAMMA', 'RTDS', 'CHAINLINK', 'CHAINLINK_FALLBACK', 'POLYMARKET_CLOB', 'CLOB_MARKET_RESOLVED', 'OBSERVER')),
    status TEXT NOT NULL CHECK (status IN ('OK', 'DATA_GAP', 'QUARANTINED', 'UNRESOLVED', 'RESOLVED')),
    source_timestamp_ms INTEGER CHECK (source_timestamp_ms IS NULL OR typeof(source_timestamp_ms) = 'integer'),
    effective_timestamp_ms INTEGER CHECK (effective_timestamp_ms IS NULL OR typeof(effective_timestamp_ms) = 'integer'),
    received_timestamp_ms INTEGER NOT NULL CHECK (typeof(received_timestamp_ms) = 'integer'),
    decimal_value_text TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('UP', 'DOWN')),
    reason_code TEXT,
    parser_version TEXT NOT NULL,
    evaluator_version TEXT NOT NULL,
    canonical_payload TEXT NOT NULL,
    raw_payload_hash TEXT,
    canonical_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (market_id) REFERENCES short_market_registry (market_id),
    CHECK (status <> 'RESOLVED' OR (kind = 'RESOLUTION' AND market_id IS NOT NULL AND outcome IS NOT NULL AND outcome IN ('UP', 'DOWN') AND source IN ('CLOB_MARKET_RESOLVED', 'GAMMA'))),
    CHECK (kind <> 'RESOLUTION' OR status IN ('DATA_GAP', 'QUARANTINED', 'UNRESOLVED', 'RESOLVED'))
  )`;

const SHORT_CALIBRATION_FORECASTS_SQL = `
  CREATE TABLE IF NOT EXISTS short_calibration_forecasts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id TEXT NOT NULL REFERENCES short_market_registry (market_id),
    evaluation_snapshot_id INTEGER NOT NULL REFERENCES short_evaluation_snapshots (id),
    opening_evidence_id INTEGER NOT NULL REFERENCES short_market_evidence (id),
    captured_timestamp_ms INTEGER NOT NULL,
    oracle_timestamp_ms INTEGER NOT NULL,
    remaining_ms INTEGER NOT NULL CHECK (remaining_ms > 0),
    probability_up_ppm INTEGER NOT NULL CHECK (probability_up_ppm BETWEEN 0 AND 1000000),
    model_version TEXT NOT NULL,
    feature_contract_version TEXT NOT NULL,
    features_json TEXT NOT NULL,
    features_hash TEXT NOT NULL,
    decision_json TEXT NOT NULL,
    decision_hash TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (evaluation_snapshot_id, model_version)
  )`;

const PRE_GUARD_SHORT_CALIBRATION_FORECAST_REQUIREMENTS = SHORT_CALIBRATION_FORECAST_REQUIREMENTS.map((column) =>
  column[0] === "opening_evidence_id" ? [column[0], column[1], false, column[3]] : column);
const SHORT_CALIBRATION_FORECAST_COLUMNS = Object.freeze(SHORT_CALIBRATION_FORECAST_REQUIREMENTS.map(([name]) => name));
const PRE_GUARD_SHORT_CALIBRATION_FORECASTS_SQL = SHORT_CALIBRATION_FORECASTS_SQL
  .replace("opening_evidence_id INTEGER NOT NULL", "opening_evidence_id INTEGER NULL");

const V4_INDEXES = Object.freeze([
  Object.freeze({ table: "short_market_registry", name: "ux_short_market_registry_condition_id", unique: true, columns: ["condition_id"], sql: "CREATE UNIQUE INDEX IF NOT EXISTS ux_short_market_registry_condition_id ON short_market_registry (condition_id)" }),
  Object.freeze({ table: "short_market_tokens", name: "ux_short_market_tokens_token_id", unique: true, columns: ["token_id"], sql: "CREATE UNIQUE INDEX IF NOT EXISTS ux_short_market_tokens_token_id ON short_market_tokens (token_id)" }),
  Object.freeze({ table: "short_market_evidence", name: "ux_short_market_evidence_idempotency_key", unique: true, columns: ["idempotency_key"], sql: "CREATE UNIQUE INDEX IF NOT EXISTS ux_short_market_evidence_idempotency_key ON short_market_evidence (idempotency_key)" }),
  Object.freeze({ table: "short_market_evidence", name: "idx_short_market_evidence_market_kind_effective", unique: false, columns: ["market_id", "kind", "effective_timestamp_ms"], sql: "CREATE INDEX IF NOT EXISTS idx_short_market_evidence_market_kind_effective ON short_market_evidence (market_id, kind, effective_timestamp_ms)" }),
  Object.freeze({ table: "short_market_evidence", name: "idx_short_market_evidence_candidate_kind", unique: false, columns: ["candidate_key", "kind"], sql: "CREATE INDEX IF NOT EXISTS idx_short_market_evidence_candidate_kind ON short_market_evidence (candidate_key, kind)" }),
]);

const V4_BASE_TRIGGERS = Object.freeze([
  Object.freeze({ table: "short_market_registry", name: "trg_short_market_registry_no_update", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_registry_no_update BEFORE UPDATE ON short_market_registry BEGIN SELECT RAISE(ABORT, 'short market registry is immutable'); END" }),
  Object.freeze({ table: "short_market_registry", name: "trg_short_market_registry_no_delete", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_registry_no_delete BEFORE DELETE ON short_market_registry BEGIN SELECT RAISE(ABORT, 'short market registry is immutable'); END" }),
  Object.freeze({ table: "short_market_tokens", name: "trg_short_market_tokens_no_update", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_tokens_no_update BEFORE UPDATE ON short_market_tokens BEGIN SELECT RAISE(ABORT, 'short market tokens are immutable'); END" }),
  Object.freeze({ table: "short_market_tokens", name: "trg_short_market_tokens_no_delete", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_tokens_no_delete BEFORE DELETE ON short_market_tokens BEGIN SELECT RAISE(ABORT, 'short market tokens are immutable'); END" }),
  Object.freeze({ table: "short_market_evidence", name: "trg_short_market_evidence_no_update", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_evidence_no_update BEFORE UPDATE ON short_market_evidence BEGIN SELECT RAISE(ABORT, 'short market evidence is append-only'); END" }),
  Object.freeze({ table: "short_market_evidence", name: "trg_short_market_evidence_no_delete", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_evidence_no_delete BEFORE DELETE ON short_market_evidence BEGIN SELECT RAISE(ABORT, 'short market evidence is append-only'); END" }),
]);
const V4_INSERT_GUARD_TRIGGERS = Object.freeze([
  Object.freeze({ table: "short_market_registry", name: "trg_short_market_registry_no_reinsert", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_registry_no_reinsert BEFORE INSERT ON short_market_registry WHEN EXISTS (SELECT 1 FROM short_market_registry WHERE rowid = NEW.rowid OR market_id = NEW.market_id OR condition_id = NEW.condition_id) BEGIN SELECT RAISE(ABORT, 'short market registry reinsert is forbidden'); END" }),
  Object.freeze({ table: "short_market_tokens", name: "trg_short_market_tokens_no_reinsert", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_tokens_no_reinsert BEFORE INSERT ON short_market_tokens WHEN EXISTS (SELECT 1 FROM short_market_tokens WHERE rowid = NEW.rowid OR (market_id = NEW.market_id AND outcome = NEW.outcome) OR token_id = NEW.token_id) BEGIN SELECT RAISE(ABORT, 'short market token reinsert is forbidden'); END" }),
  Object.freeze({ table: "short_market_evidence", name: "trg_short_market_evidence_no_reinsert", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_evidence_no_reinsert BEFORE INSERT ON short_market_evidence WHEN EXISTS (SELECT 1 FROM short_market_evidence WHERE id = NEW.id OR idempotency_key = NEW.idempotency_key) BEGIN SELECT RAISE(ABORT, 'short market evidence reinsert is forbidden'); END" }),
  Object.freeze({ table: "short_market_evidence", name: "trg_short_market_evidence_resolution_contract", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_evidence_resolution_contract BEFORE INSERT ON short_market_evidence WHEN (NEW.status = 'RESOLVED' AND (NEW.kind <> 'RESOLUTION' OR NEW.market_id IS NULL OR NEW.outcome IS NULL OR NEW.outcome NOT IN ('UP', 'DOWN') OR NEW.source NOT IN ('CLOB_MARKET_RESOLVED', 'GAMMA'))) OR (NEW.kind = 'RESOLUTION' AND NEW.status NOT IN ('DATA_GAP', 'QUARANTINED', 'UNRESOLVED', 'RESOLVED')) BEGIN SELECT RAISE(ABORT, 'short market evidence resolution contract violation'); END" }),
]);
const V4_TRIGGERS = Object.freeze([...V4_BASE_TRIGGERS, ...V4_INSERT_GUARD_TRIGGERS]);
const PRE_ROWID_V4_INSERT_GUARD_TRIGGERS = Object.freeze([
  Object.freeze({ table: "short_market_registry", name: "trg_short_market_registry_no_reinsert", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_registry_no_reinsert BEFORE INSERT ON short_market_registry WHEN EXISTS (SELECT 1 FROM short_market_registry WHERE market_id = NEW.market_id OR condition_id = NEW.condition_id) BEGIN SELECT RAISE(ABORT, 'short market registry reinsert is forbidden'); END" }),
  Object.freeze({ table: "short_market_tokens", name: "trg_short_market_tokens_no_reinsert", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_market_tokens_no_reinsert BEFORE INSERT ON short_market_tokens WHEN EXISTS (SELECT 1 FROM short_market_tokens WHERE (market_id = NEW.market_id AND outcome = NEW.outcome) OR token_id = NEW.token_id) BEGIN SELECT RAISE(ABORT, 'short market token reinsert is forbidden'); END" }),
  V4_INSERT_GUARD_TRIGGERS[2],
  V4_INSERT_GUARD_TRIGGERS[3],
]);
const PRE_ROWID_V4_TRIGGERS = Object.freeze([...V4_BASE_TRIGGERS, ...PRE_ROWID_V4_INSERT_GUARD_TRIGGERS]);
const V4_TABLE_NAMES = Object.freeze(["short_market_registry", "short_market_tokens", "short_market_evidence"]);
const V5_INDEXES = Object.freeze([
  Object.freeze({ table: "short_calibration_forecasts", name: "idx_short_calibration_forecasts_market_captured", unique: false, columns: ["market_id", "captured_timestamp_ms"], sql: "CREATE INDEX IF NOT EXISTS idx_short_calibration_forecasts_market_captured ON short_calibration_forecasts (market_id, captured_timestamp_ms)" }),
  Object.freeze({ table: "short_calibration_forecasts", name: "idx_short_calibration_forecasts_model_version", unique: false, columns: ["model_version"], sql: "CREATE INDEX IF NOT EXISTS idx_short_calibration_forecasts_model_version ON short_calibration_forecasts (model_version)" }),
]);
const V5_BASE_TRIGGERS = Object.freeze([
  Object.freeze({ table: "short_calibration_forecasts", name: "trg_short_calibration_forecasts_no_update", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_calibration_forecasts_no_update BEFORE UPDATE ON short_calibration_forecasts BEGIN SELECT RAISE(ABORT, 'short calibration forecasts are append-only'); END" }),
  Object.freeze({ table: "short_calibration_forecasts", name: "trg_short_calibration_forecasts_no_delete", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_calibration_forecasts_no_delete BEFORE DELETE ON short_calibration_forecasts BEGIN SELECT RAISE(ABORT, 'short calibration forecasts are append-only'); END" }),
  Object.freeze({ table: "short_calibration_forecasts", name: "trg_short_calibration_forecasts_no_reinsert", sql: "CREATE TRIGGER IF NOT EXISTS trg_short_calibration_forecasts_no_reinsert BEFORE INSERT ON short_calibration_forecasts WHEN EXISTS (SELECT 1 FROM short_calibration_forecasts AS existing WHERE (existing.id = NEW.id OR existing.idempotency_key = NEW.idempotency_key OR (existing.evaluation_snapshot_id = NEW.evaluation_snapshot_id AND existing.model_version = NEW.model_version)) AND NOT (existing.id IS NEW.id AND existing.market_id IS NEW.market_id AND existing.evaluation_snapshot_id IS NEW.evaluation_snapshot_id AND existing.opening_evidence_id IS NEW.opening_evidence_id AND existing.captured_timestamp_ms IS NEW.captured_timestamp_ms AND existing.oracle_timestamp_ms IS NEW.oracle_timestamp_ms AND existing.remaining_ms IS NEW.remaining_ms AND existing.probability_up_ppm IS NEW.probability_up_ppm AND existing.model_version IS NEW.model_version AND existing.feature_contract_version IS NEW.feature_contract_version AND existing.features_json IS NEW.features_json AND existing.features_hash IS NEW.features_hash AND existing.decision_json IS NEW.decision_json AND existing.decision_hash IS NEW.decision_hash AND existing.idempotency_key IS NEW.idempotency_key AND existing.created_at IS NEW.created_at)) BEGIN SELECT RAISE(ABORT, 'short calibration forecast reinsert is forbidden'); END" }),
]);
const PRE_REINSERT_V5_FORECAST_TRIGGERS = Object.freeze(V5_BASE_TRIGGERS.slice(0, 2));

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
      && column.pk === Number(primaryKey)
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

function canonicalSchemaSql(value) {
  return String(value || "")
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
}

function schemaSqlMatches(db, type, name, expectedSql) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);
  return canonicalSchemaSql(row?.sql) === canonicalSchemaSql(expectedSql);
}

function exactTableMatches(db, table, requirements, expectedSql) {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all();
  return actual.length === requirements.length
    && tableMatches(db, table, requirements, requirements)
    && schemaSqlMatches(db, "table", table, expectedSql);
}

function exactV4IndexesPresent(db) {
  const expectedByTable = new Map([
    ["short_market_registry", [
      { name: "sqlite_autoindex_short_market_registry_1", unique: true, partial: false, origin: "pk", columns: ["market_id"], sql: null },
      ...V4_INDEXES.filter((item) => item.table === "short_market_registry").map((item) => ({ ...item, partial: false, origin: "c" })),
    ]],
    ["short_market_tokens", [
      { name: "sqlite_autoindex_short_market_tokens_1", unique: true, partial: false, origin: "pk", columns: ["market_id", "outcome"], sql: null },
      ...V4_INDEXES.filter((item) => item.table === "short_market_tokens").map((item) => ({ ...item, partial: false, origin: "c" })),
    ]],
    ["short_market_evidence", V4_INDEXES.filter((item) => item.table === "short_market_evidence").map((item) => ({ ...item, partial: false, origin: "c" }))],
  ]);

  return [...expectedByTable].every(([table, expected]) => {
    const actual = db.prepare(`PRAGMA index_list(${table})`).all();
    if (actual.length !== expected.length) return false;
    return expected.every((requirement) => {
      const index = actual.find((item) => item.name === requirement.name);
      if (!index
          || index.unique !== Number(requirement.unique)
          || index.partial !== Number(requirement.partial)
          || index.origin !== requirement.origin) return false;
      const columns = db.prepare(`PRAGMA index_info(${requirement.name})`).all().map((item) => item.name);
      if (columns.length !== requirement.columns.length || columns.some((item, i) => item !== requirement.columns[i])) return false;
      if (requirement.sql && !schemaSqlMatches(db, "index", requirement.name, requirement.sql)) return false;
      if (!requirement.sql) {
        const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(requirement.name)?.sql;
        if (sql !== null) return false;
      }
      return true;
    });
  });
}

function exactV4ForeignKeysPresent(db) {
  const expected = new Map([
    ["short_market_registry", []],
    ["short_market_tokens", [{ table: "short_market_registry", from: "market_id", to: "market_id" }]],
    ["short_market_evidence", [{ table: "short_market_registry", from: "market_id", to: "market_id" }]],
  ]);
  return [...expected].every(([table, requirements]) => {
    const actual = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    return actual.length === requirements.length && requirements.every((requirement, index) => {
      const foreignKey = actual[index];
      return foreignKey.id === index
        && foreignKey.seq === 0
        && foreignKey.table === requirement.table
        && foreignKey.from === requirement.from
        && foreignKey.to === requirement.to
        && foreignKey.on_update === "NO ACTION"
        && foreignKey.on_delete === "NO ACTION"
        && foreignKey.match === "NONE";
    });
  });
}

function exactV4TriggersPresent(db, expectedTriggers = V4_TRIGGERS) {
  const tableSet = new Set(V4_TABLE_NAMES);
  const actual = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
    .filter((item) => tableSet.has(item.tbl_name));
  if (actual.length !== expectedTriggers.length) return false;
  return expectedTriggers.every((requirement) => {
    const trigger = actual.find((item) => item.name === requirement.name);
    return trigger?.tbl_name === requirement.table
      && canonicalSchemaSql(trigger.sql) === canonicalSchemaSql(requirement.sql);
  });
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

function createV4Schema(db) {
  db.exec(`${SHORT_MARKET_REGISTRY_SQL};\n${SHORT_MARKET_TOKENS_SQL};\n${SHORT_MARKET_EVIDENCE_SQL};`);
  for (const index of V4_INDEXES) db.exec(`${index.sql};`);
  for (const trigger of V4_TRIGGERS) db.exec(`${trigger.sql};`);
}

function createV5Schema(db) {
  db.exec(`${SHORT_CALIBRATION_FORECASTS_SQL};`);
  for (const index of V5_INDEXES) db.exec(`${index.sql};`);
  for (const trigger of V5_BASE_TRIGGERS) db.exec(`${trigger.sql};`);
}

function rebuildV5ForecastTable(db) {
  if (db.prepare("SELECT 1 FROM short_calibration_forecasts WHERE opening_evidence_id IS NULL LIMIT 1").get()) {
    throw new Error("Cannot enforce opening evidence on existing null forecast rows");
  }
  for (const trigger of V5_BASE_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  for (const index of V5_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
  db.exec("ALTER TABLE short_calibration_forecasts RENAME TO short_calibration_forecasts_legacy");
  db.exec(`${SHORT_CALIBRATION_FORECASTS_SQL};`);
  db.exec(`INSERT INTO short_calibration_forecasts (${SHORT_CALIBRATION_FORECAST_COLUMNS.join(", ")})
    SELECT ${SHORT_CALIBRATION_FORECAST_COLUMNS.join(", ")} FROM short_calibration_forecasts_legacy`);
  db.exec("DROP TABLE short_calibration_forecasts_legacy");
  for (const index of V5_INDEXES) db.exec(`${index.sql};`);
  for (const trigger of V5_BASE_TRIGGERS) db.exec(`${trigger.sql};`);
}

function ensureV5ForecastTriggers(db) {
  for (const trigger of V5_BASE_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    db.exec(`${trigger.sql};`);
  }
}

function replaceV4InsertGuards(db) {
  for (const trigger of V4_INSERT_GUARD_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  for (const trigger of V4_INSERT_GUARD_TRIGGERS) db.exec(`${trigger.sql};`);
}

function rebuildPreGate2EvidenceTable(db) {
  const forecastRows = tableNames(db).has("short_calibration_forecasts")
    ? db.prepare("SELECT * FROM short_calibration_forecasts ORDER BY id").all()
    : null;
  if (forecastRows) {
    for (const trigger of V5_BASE_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    for (const index of V5_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index.name}`);
    db.exec("DROP TABLE short_calibration_forecasts");
  }
  const previousSequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'short_market_evidence'").get()?.seq ?? null;
  for (const trigger of V4_TRIGGERS.filter((item) => item.table === "short_market_evidence")) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  }
  for (const index of V4_INDEXES.filter((item) => item.table === "short_market_evidence")) {
    db.exec(`DROP INDEX IF EXISTS ${index.name}`);
  }
  db.exec("ALTER TABLE short_market_evidence RENAME TO short_market_evidence_pre_gate_2");
  db.exec(`${SHORT_MARKET_EVIDENCE_SQL};`);
  const columns = SHORT_MARKET_EVIDENCE_REQUIREMENTS.map(([name]) => name);
  const previousIgnoreChecks = db.pragma("ignore_check_constraints", { simple: true });
  db.pragma("ignore_check_constraints = ON");
  try {
    db.exec(`INSERT INTO short_market_evidence (${columns.join(", ")}) SELECT ${columns.join(", ")} FROM short_market_evidence_pre_gate_2`);
  } finally {
    db.pragma(`ignore_check_constraints = ${previousIgnoreChecks ? "ON" : "OFF"}`);
  }
  db.exec("DROP TABLE short_market_evidence_pre_gate_2");
  if (previousSequence != null) {
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'short_market_evidence'").get();
    if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'short_market_evidence'").run(previousSequence);
    else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('short_market_evidence', ?)").run(previousSequence);
  }
  createV4Schema(db);
  if (forecastRows) {
    createV5Schema(db);
    const columns = SHORT_CALIBRATION_FORECAST_REQUIREMENTS.map(([name]) => name);
    const placeholders = columns.map(() => "?").join(", ");
    const insert = db.prepare(`INSERT INTO short_calibration_forecasts (${columns.join(", ")}) VALUES (${placeholders})`);
    for (const row of forecastRows) insert.run(...columns.map((column) => row[column]));
  }
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

function v3StructurePresent(db) {
  return tableMatches(db, "cache", CORE_TABLE_REQUIREMENTS.cache)
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
}

function retiredTablesAbsent(db) {
  const tables = tableNames(db);
  return RETIRED_TABLES.every((table) => !tables.has(table));
}

function v4StructureVariantPresent(db, expectedEvidenceSql, expectedTriggers) {
  return v3StructurePresent(db)
    && retiredTablesAbsent(db)
    && !tableNames(db).has("short_market_evidence_pre_gate_2")
    && exactTableMatches(db, "short_market_registry", SHORT_MARKET_REGISTRY_REQUIREMENTS, SHORT_MARKET_REGISTRY_SQL)
    && exactTableMatches(db, "short_market_tokens", SHORT_MARKET_TOKEN_REQUIREMENTS, SHORT_MARKET_TOKENS_SQL)
    && exactTableMatches(db, "short_market_evidence", SHORT_MARKET_EVIDENCE_REQUIREMENTS, expectedEvidenceSql)
    && exactV4IndexesPresent(db)
    && exactV4ForeignKeysPresent(db)
    && exactV4TriggersPresent(db, expectedTriggers)
    && db.prepare("PRAGMA foreign_key_check").all().length === 0;
}

function v4StructurePresent(db) {
  return v4StructureVariantPresent(db, SHORT_MARKET_EVIDENCE_SQL, V4_TRIGGERS);
}

function exactV5IndexesPresent(db) {
  if (!exactV4IndexesPresent(db)) return false;
  const actual = db.prepare("PRAGMA index_list(short_calibration_forecasts)").all();
  const expected = [
    { name: "sqlite_autoindex_short_calibration_forecasts_1", unique: true, partial: false, origin: "u", columns: ["idempotency_key"] },
    { name: "sqlite_autoindex_short_calibration_forecasts_2", unique: true, partial: false, origin: "u", columns: ["evaluation_snapshot_id", "model_version"] },
    ...V5_INDEXES.map((item) => ({ ...item, partial: false, origin: "c" })),
  ];
  if (actual.length !== expected.length) return false;
  return expected.every((requirement) => {
    const index = actual.find((item) => item.name === requirement.name);
    if (!index
        || index.unique !== Number(requirement.unique)
        || index.partial !== Number(requirement.partial)
        || index.origin !== requirement.origin) return false;
    const columns = db.prepare(`PRAGMA index_info(${requirement.name})`).all().map((item) => item.name);
    return columns.length === requirement.columns.length
      && columns.every((item, indexPosition) => item === requirement.columns[indexPosition])
      && (!requirement.sql || schemaSqlMatches(db, "index", requirement.name, requirement.sql));
  });
}

function exactV5ForeignKeysPresent(db) {
  if (!exactV4ForeignKeysPresent(db)) return false;
  const actual = db.prepare("PRAGMA foreign_key_list(short_calibration_forecasts)").all();
  const expected = [
    { table: "short_market_registry", from: "market_id", to: "market_id" },
    { table: "short_evaluation_snapshots", from: "evaluation_snapshot_id", to: "id" },
    { table: "short_market_evidence", from: "opening_evidence_id", to: "id" },
  ];
  return actual.length === expected.length && expected.every((requirement) => actual.some((foreignKey) => (
    foreignKey.table === requirement.table
      && foreignKey.from === requirement.from
      && foreignKey.to === requirement.to
      && foreignKey.on_update === "NO ACTION"
      && foreignKey.on_delete === "NO ACTION"
      && foreignKey.match === "NONE"
  )));
}

function exactV5ForecastTriggersPresent(db, expectedTriggers = V5_BASE_TRIGGERS) {
  const actual = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all()
    .filter((item) => item.tbl_name === "short_calibration_forecasts");
  if (actual.length !== expectedTriggers.length) return false;
  return expectedTriggers.every((requirement) => {
    const trigger = actual.find((item) => item.name === requirement.name);
    return trigger?.tbl_name === requirement.table
      && canonicalSchemaSql(trigger.sql) === canonicalSchemaSql(requirement.sql);
  });
}

function v5StructureVariantPresent(
  db, expectedEvidenceSql, expectedTriggers, forecastTriggers = V5_BASE_TRIGGERS,
  forecastRequirements = SHORT_CALIBRATION_FORECAST_REQUIREMENTS, forecastSql = SHORT_CALIBRATION_FORECASTS_SQL,
) {
  return v4StructureVariantPresent(db, expectedEvidenceSql, expectedTriggers)
    && exactTableMatches(db, "short_calibration_forecasts", forecastRequirements, forecastSql)
    && exactV5IndexesPresent(db)
    && exactV5ForeignKeysPresent(db)
    && exactV5ForecastTriggersPresent(db, forecastTriggers)
    && db.prepare("PRAGMA foreign_key_check").all().length === 0;
}

function v5StructurePresent(db) {
  return v5StructureVariantPresent(db, SHORT_MARKET_EVIDENCE_SQL, V4_TRIGGERS);
}

function preInsertGuardV5StructurePresent(db) {
  const evidenceVariants = [
    [PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL, V4_BASE_TRIGGERS],
    [PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL, V4_TRIGGERS],
    [PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL, PRE_ROWID_V4_TRIGGERS],
    [SHORT_MARKET_EVIDENCE_SQL, V4_BASE_TRIGGERS],
    [SHORT_MARKET_EVIDENCE_SQL, V4_TRIGGERS],
    [SHORT_MARKET_EVIDENCE_SQL, PRE_ROWID_V4_TRIGGERS],
  ];
  const forecastVariants = [
    [V5_BASE_TRIGGERS, SHORT_CALIBRATION_FORECAST_REQUIREMENTS, SHORT_CALIBRATION_FORECASTS_SQL],
    [PRE_REINSERT_V5_FORECAST_TRIGGERS, PRE_GUARD_SHORT_CALIBRATION_FORECAST_REQUIREMENTS, PRE_GUARD_SHORT_CALIBRATION_FORECASTS_SQL],
  ];
  return forecastVariants.some(([forecastTriggers, forecastRequirements, forecastSql]) =>
    evidenceVariants.some(([evidenceSql, v4Triggers]) => v5StructureVariantPresent(
      db, evidenceSql, v4Triggers, forecastTriggers, forecastRequirements, forecastSql,
    )));
}

function preInsertGuardV4StructurePresent(db) {
  return v4StructureVariantPresent(db, PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL, V4_BASE_TRIGGERS)
    || v4StructureVariantPresent(db, PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL, V4_TRIGGERS)
    || v4StructureVariantPresent(db, PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL, PRE_ROWID_V4_TRIGGERS)
    || v4StructureVariantPresent(db, SHORT_MARKET_EVIDENCE_SQL, V4_BASE_TRIGGERS)
    || v4StructureVariantPresent(db, SHORT_MARKET_EVIDENCE_SQL, PRE_ROWID_V4_TRIGGERS);
}

function preGate2EvidenceTablePresent(db) {
  return exactTableMatches(db, "short_market_evidence", SHORT_MARKET_EVIDENCE_REQUIREMENTS, PRE_GATE_2_SHORT_MARKET_EVIDENCE_SQL);
}

function verificationResult(db, expectedVersion, structureCheck) {
  let version = null;
  try {
    version = db.pragma("user_version", { simple: true });
    const integrityOk = db.pragma("quick_check", { simple: true }) === "ok";
    return { ok: integrityOk && version === expectedVersion && structureCheck(db), version };
  } catch {
    return { ok: false, version };
  }
}

async function createMigrationBackup(db, backupDirectory, now, backupDatabase) {
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const backupPath = path.join(backupDirectory, backupFilename(now()));
  await backupDatabase(db, backupPath);
  fs.chmodSync(backupPath, 0o600);
  verifyBackup(backupPath);
  return backupPath;
}

export function verifyV3CompatibleDatabase(db) {
  return verificationResult(db, 3, (candidate) => v3StructurePresent(candidate) && retiredTablesAbsent(candidate));
}

export function verifyDatabase(db) {
  return verificationResult(db, SCHEMA_VERSION, v5StructurePresent);
}

export async function migrateDatabase(db, {
  databasePath,
  backupDirectory = path.join(path.dirname(databasePath), "backups"),
  now = () => new Date(),
  backupDatabase = defaultBackupDatabase,
  verify = () => ({ ok: true }),
} = {}) {
  if (!databasePath) throw new Error("databasePath is required for migration safety");

  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion > SCHEMA_VERSION) {
    throw new Error(`Database schema v${fromVersion} is newer than supported v${SCHEMA_VERSION}`);
  }
  const existingTables = tableNames(db);
  if (fromVersion === SCHEMA_VERSION) {
    const verification = verifyDatabase(db);
    if (verification.ok) return { fromVersion, toVersion: SCHEMA_VERSION, migrated: false, backupPath: null };
    if (!preInsertGuardV5StructurePresent(db)) throw new Error("Database schema verification failed");
    const rebuildEvidence = !exactTableMatches(
      db, "short_market_evidence", SHORT_MARKET_EVIDENCE_REQUIREMENTS, SHORT_MARKET_EVIDENCE_SQL,
    );
    const rebuildForecast = !exactTableMatches(
      db, "short_calibration_forecasts", SHORT_CALIBRATION_FORECAST_REQUIREMENTS, SHORT_CALIBRATION_FORECASTS_SQL,
    );
    const backupPath = await createMigrationBackup(db, backupDirectory, now, backupDatabase);
    db.transaction(() => {
      if (rebuildEvidence) rebuildPreGate2EvidenceTable(db);
      replaceV4InsertGuards(db);
      if (rebuildForecast) rebuildV5ForecastTable(db);
      ensureV5ForecastTriggers(db);
      if (!verifyDatabase(db).ok || !verify(db)?.ok) throw new Error("Database migration verification failed");
    })();
    return { fromVersion, toVersion: SCHEMA_VERSION, migrated: true, backupPath };
  }

  const sourceCompatible = fromVersion === 4
    ? v4StructurePresent(db) || preInsertGuardV4StructurePresent(db)
    : fromVersion === 3
      ? v3StructurePresent(db) && retiredTablesAbsent(db)
      : legacyCanonicalTablesCompatible(db, existingTables);
  if (!sourceCompatible) {
    throw new Error("Legacy canonical schema is incompatible with a safe migration");
  }
  const existingV4TableCount = V4_TABLE_NAMES.filter((table) => existingTables.has(table)).length;
  if (existingV4TableCount > 0 && !v4StructurePresent(db) && !preInsertGuardV4StructurePresent(db)) {
    throw new Error("Existing v4 schema is incompatible with a safe migration");
  }
  const rebuildEvidence = existingV4TableCount > 0 && preGate2EvidenceTablePresent(db);
  const replaceInsertGuards = existingV4TableCount > 0 && !exactV4TriggersPresent(db, V4_TRIGGERS);
  let backupPath = null;
  if (existingTables.size > 0) {
    backupPath = await createMigrationBackup(db, backupDirectory, now, backupDatabase);
  }

  db.transaction(() => {
    createCanonicalSchema(db);
    if (fromVersion < 3) {
      for (const table of RETIRED_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    if (rebuildEvidence) rebuildPreGate2EvidenceTable(db);
    createV4Schema(db);
    if (replaceInsertGuards) replaceV4InsertGuards(db);
    createV5Schema(db);
    if (db.pragma("quick_check", { simple: true }) !== "ok" || !v5StructurePresent(db) || !verify(db)?.ok) {
      throw new Error("Database migration verification failed");
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    if (!verifyDatabase(db).ok) throw new Error("Database migration verification failed");
  })();

  const verification = verifyDatabase(db);
  if (!verification.ok) throw new Error("Database migration verification failed");
  return { fromVersion, toVersion: SCHEMA_VERSION, migrated: true, backupPath };
}

export function rollbackSchemaV4MetadataOnly(db) {
  db.pragma("foreign_keys = ON");
  const fromVersion = db.pragma("user_version", { simple: true });
  if (fromVersion !== SCHEMA_VERSION) {
    throw new Error(`Metadata-only rollback requires schema v${SCHEMA_VERSION}`);
  }
  if (!verifyDatabase(db).ok || !v3StructurePresent(db) || !retiredTablesAbsent(db)) {
    throw new Error("Metadata-only rollback verification failed");
  }

  db.transaction(() => {
    if (!v4StructurePresent(db) || !v3StructurePresent(db)) {
      throw new Error("Metadata-only rollback verification failed");
    }
    db.pragma("user_version = 3");
    if (!verifyV3CompatibleDatabase(db).ok) throw new Error("Metadata-only rollback verification failed");
  })();

  return Object.freeze({ fromVersion, toVersion: 3, rolledBack: true, metadataOnly: true });
}
