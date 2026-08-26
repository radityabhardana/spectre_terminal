import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { databasePath } from "./database-path.js";
import { migrateDatabase } from "./migrations.js";
import {
  SHORT_OBSERVE_ASSET,
  SHORT_OBSERVE_CRYPTO_FINGERPRINT,
  SHORT_OBSERVE_DURATION,
  SHORT_OBSERVE_DURATION_MS,
  SHORT_OBSERVE_SERIES_ID,
} from "./short-observe-contract.js";
import { STRICT_OBSERVE_CONTRACT_VERSION, STRICT_OBSERVE_MODEL_VERSION } from "./short-observe-audit.js";

const db = new Database(databasePath);
export { databasePath };
export const ANALYSIS_STRATEGY_VERSION = "chainlink-terminal-value-v3";
export const SHORT_EVALUATION_CONTRACT_VERSION = "phase-a-v1";
export const SHORT_EVALUATION_MODEL_VERSION = "oracle-diff-normal-v1";

db.pragma('journal_mode = WAL');
await migrateDatabase(db, { databasePath });

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
export function canonicalAuditPayload(payload) { return JSON.stringify(canonicalize(payload)); }
export function auditPayloadHash(payload) { return createHash("sha256").update(payload, "utf8").digest("hex"); }
const nowIso = (value) => value == null ? new Date().toISOString() : String(value);
const valueOf = (input, camel, snake = camel) => input?.[camel] ?? input?.[snake];

function readPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("audit payload must be a non-null object");
  const serialized = canonicalAuditPayload(payload);
  return { serialized, hash: auditPayloadHash(serialized) };
}

function readStrictCanonicalJson(value, field) {
  const text = strictText(value, field);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${field} must be valid canonical JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || canonicalAuditPayload(parsed) !== text) {
    throw new Error(`${field} must be canonical JSON`);
  }
  return { text, value: parsed };
}

const SHORT_MARKET_EVIDENCE_KINDS = new Set(["DISCOVERY", "BOUNDARY_TWAP", "ORDER_BOOK", "FEE_POLICY", "RESOLUTION"]);
const SHORT_MARKET_EVIDENCE_SOURCES = new Set(["GAMMA", "RTDS", "CHAINLINK", "CHAINLINK_FALLBACK", "POLYMARKET_CLOB", "CLOB_MARKET_RESOLVED", "OBSERVER"]);
const SHORT_MARKET_EVIDENCE_STATUSES = new Set(["OK", "DATA_GAP", "QUARANTINED", "UNRESOLVED", "RESOLVED"]);
const SHORT_MARKET_RESOLUTION_STATUSES = new Set(["DATA_GAP", "QUARANTINED", "UNRESOLVED", "RESOLVED"]);
const SHORT_MARKET_NONTERMINAL_RESOLUTION_STATUSES = new Set(["DATA_GAP", "QUARANTINED", "UNRESOLVED"]);
const SHORT_MARKET_RESOLUTION_SOURCES = new Set(["CLOB_MARKET_RESOLVED", "GAMMA"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PLAIN_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const MIN_MILLISECOND_TIMESTAMP = 1_000_000_000_000;
const MAX_SHORT_MARKET_READ_LIMIT = 500;
const SHORT_FORECAST_CONTENT_COLUMNS = Object.freeze([
  "market_id", "evaluation_snapshot_id", "opening_evidence_id", "captured_timestamp_ms", "oracle_timestamp_ms",
  "remaining_ms", "probability_up_ppm", "model_version", "feature_contract_version", "features_json", "features_hash",
  "decision_json", "decision_hash", "idempotency_key", "created_at",
]);

function strictText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be nonempty exact text`);
  }
  return value;
}

function strictIso(value, field) {
  const text = strictText(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) throw new Error(`${field} must be a canonical ISO timestamp`);
  return { text, milliseconds: parsed };
}

function strictTimestampMs(value, field, nullable = false) {
  if (value == null && nullable) return null;
  if (!Number.isSafeInteger(value) || value < MIN_MILLISECOND_TIMESTAMP) throw new Error(`${field} must be an integer millisecond timestamp`);
  return value;
}

function strictHash(value, field, nullable = false) {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new Error(`${field} must be lowercase sha256 hex`);
  return value;
}

function strictLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("limit must be a positive integer");
  return Math.min(value, MAX_SHORT_MARKET_READ_LIMIT);
}

function evidenceRecord(row) {
  return row ? { ...row, payload: JSON.parse(row.canonical_payload) } : null;
}

const EVIDENCE_CONTENT_COLUMNS = Object.freeze([
  "candidate_key", "market_id", "kind", "source", "status", "source_timestamp_ms", "effective_timestamp_ms",
  "received_timestamp_ms", "decimal_value_text", "outcome", "reason_code", "parser_version", "evaluator_version",
  "canonical_payload", "raw_payload_hash", "canonical_hash", "idempotency_key",
]);

function sameEvidenceContent(row, prepared) {
  return EVIDENCE_CONTENT_COLUMNS.every((column) => row[column] === prepared[column]);
}

function prepareShortMarketEvidence(input = {}) {
  const candidateKey = strictText(valueOf(input, "candidateKey", "candidate_key"), "candidateKey");
  const marketValue = valueOf(input, "marketId", "market_id");
  const marketId = marketValue == null ? null : strictText(marketValue, "marketId");
  const kind = strictText(valueOf(input, "kind"), "kind");
  const source = strictText(valueOf(input, "source"), "source");
  const status = strictText(valueOf(input, "status"), "status");
  if (!SHORT_MARKET_EVIDENCE_KINDS.has(kind)) throw new Error("unsupported short market evidence kind");
  if (!SHORT_MARKET_EVIDENCE_SOURCES.has(source)) throw new Error("unsupported short market evidence source");
  if (!SHORT_MARKET_EVIDENCE_STATUSES.has(status)) throw new Error("unsupported short market evidence status");

  const sourceTimestampMs = strictTimestampMs(valueOf(input, "sourceTimestampMs", "source_timestamp_ms"), "sourceTimestampMs", true);
  const effectiveTimestampMs = strictTimestampMs(valueOf(input, "effectiveTimestampMs", "effective_timestamp_ms"), "effectiveTimestampMs", true);
  const receivedTimestampMs = strictTimestampMs(valueOf(input, "receivedTimestampMs", "received_timestamp_ms"), "receivedTimestampMs");
  const decimalValue = valueOf(input, "decimalValueText", "decimal_value_text");
  const decimalValueText = decimalValue == null ? null : decimalValue;
  if (decimalValueText != null && (typeof decimalValueText !== "string" || !PLAIN_DECIMAL.test(decimalValueText))) {
    throw new Error("decimalValueText must be plain decimal text");
  }
  const outcomeValue = valueOf(input, "outcome");
  const outcome = outcomeValue == null ? null : outcomeValue;
  if (outcome !== null && outcome !== "UP" && outcome !== "DOWN") throw new Error("outcome must be UP, DOWN, or null");
  if (kind === "RESOLUTION" && !SHORT_MARKET_RESOLUTION_STATUSES.has(status)) {
    throw new Error("resolution evidence status is not canonical");
  }
  if (status === "RESOLVED"
      && (kind !== "RESOLUTION"
        || marketId === null
        || outcome === null
        || !SHORT_MARKET_RESOLUTION_SOURCES.has(source))) {
    throw new Error("resolved evidence requires canonical resolution fields");
  }
  const reasonValue = valueOf(input, "reasonCode", "reason_code");
  const reasonCode = reasonValue == null ? null : strictText(reasonValue, "reasonCode");
  const parserVersion = strictText(valueOf(input, "parserVersion", "parser_version"), "parserVersion");
  const evaluatorVersion = strictText(valueOf(input, "evaluatorVersion", "evaluator_version"), "evaluatorVersion");
  const payload = readPayload(valueOf(input, "payload") ?? valueOf(input, "canonicalPayload", "canonical_payload"));
  const suppliedCanonicalHash = valueOf(input, "canonicalHash", "canonical_hash");
  if (suppliedCanonicalHash != null) {
    strictHash(suppliedCanonicalHash, "canonicalHash");
    if (suppliedCanonicalHash !== payload.hash) throw new Error("canonicalHash does not match canonical payload");
  }
  const rawPayloadHash = strictHash(valueOf(input, "rawPayloadHash", "raw_payload_hash"), "rawPayloadHash", true);
  const idempotencyKey = strictText(valueOf(input, "idempotencyKey", "idempotency_key"), "idempotencyKey");
  const createdAt = strictIso(valueOf(input, "createdAt", "created_at"), "createdAt").text;

  return Object.freeze({
    candidate_key: candidateKey,
    market_id: marketId,
    kind,
    source,
    status,
    source_timestamp_ms: sourceTimestampMs,
    effective_timestamp_ms: effectiveTimestampMs,
    received_timestamp_ms: receivedTimestampMs,
    decimal_value_text: decimalValueText,
    outcome,
    reason_code: reasonCode,
    parser_version: parserVersion,
    evaluator_version: evaluatorVersion,
    canonical_payload: payload.serialized,
    raw_payload_hash: rawPayloadHash,
    canonical_hash: payload.hash,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
  });
}

function appendPreparedShortMarketEvidence(prepared) {
  if (prepared.market_id != null) {
    const market = db.prepare("SELECT market_id FROM short_market_registry WHERE market_id = ?").get(prepared.market_id);
    if (!market) throw new Error("short market evidence references an unknown market");
  }
  const existing = db.prepare("SELECT * FROM short_market_evidence WHERE idempotency_key = ?").get(prepared.idempotency_key);
  if (existing) {
    if (!sameEvidenceContent(existing, prepared)) throw new Error("short market evidence idempotency conflict");
    return evidenceRecord(existing);
  }
  const info = db.prepare(`INSERT INTO short_market_evidence
    (candidate_key, market_id, kind, source, status, source_timestamp_ms, effective_timestamp_ms,
     received_timestamp_ms, decimal_value_text, outcome, reason_code, parser_version, evaluator_version,
     canonical_payload, raw_payload_hash, canonical_hash, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    prepared.candidate_key, prepared.market_id, prepared.kind, prepared.source, prepared.status,
    prepared.source_timestamp_ms, prepared.effective_timestamp_ms, prepared.received_timestamp_ms,
    prepared.decimal_value_text, prepared.outcome, prepared.reason_code, prepared.parser_version,
    prepared.evaluator_version, prepared.canonical_payload, prepared.raw_payload_hash, prepared.canonical_hash,
    prepared.idempotency_key, prepared.created_at,
  );
  return evidenceRecord(db.prepare("SELECT * FROM short_market_evidence WHERE id = ?").get(Number(info.lastInsertRowid)));
}

export function appendShortMarketEvidence(input = {}) {
  try {
    const prepared = prepareShortMarketEvidence(input);
    return db.transaction(() => appendPreparedShortMarketEvidence(prepared))();
  } catch (error) {
    console.error("[Storage] appendShortMarketEvidence error:", error.message);
    return null;
  }
}

function strictIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("validated short market identity is required");
  const eventId = strictText(identity.eventId, "identity.eventId");
  const marketId = strictText(identity.marketId, "identity.marketId");
  const conditionId = strictText(identity.conditionId, "identity.conditionId");
  if (identity.seriesId !== SHORT_OBSERVE_SERIES_ID
      || identity.asset !== SHORT_OBSERVE_ASSET
      || identity.durationType !== SHORT_OBSERVE_DURATION) throw new Error("short market identity contract mismatch");
  const startMs = strictTimestampMs(identity.startMs, "identity.startMs");
  const endMs = strictTimestampMs(identity.endMs, "identity.endMs");
  if (endMs - startMs !== SHORT_OBSERVE_DURATION_MS) throw new Error("short market identity duration mismatch");
  const startTime = strictIso(identity.startTime, "identity.startTime");
  const endTime = strictIso(identity.endTime, "identity.endTime");
  if (startTime.milliseconds !== startMs || endTime.milliseconds !== endMs) throw new Error("short market identity timestamp mismatch");
  const fingerprint = readPayload(identity.cryptoFingerprint);
  if (fingerprint.serialized !== canonicalAuditPayload(SHORT_OBSERVE_CRYPTO_FINGERPRINT)) throw new Error("short market fingerprint mismatch");
  const upToken = strictText(identity.tokenIds?.UP, "identity.tokenIds.UP");
  const downToken = strictText(identity.tokenIds?.DOWN, "identity.tokenIds.DOWN");
  if (upToken === downToken) throw new Error("UP and DOWN token ids must be distinct");
  return Object.freeze({ eventId, marketId, conditionId, startMs, endMs, fingerprint, upToken, downToken });
}

function registrationMetadataValue(input, metadata, camel, snake = camel) {
  return valueOf(metadata, camel, snake) ?? valueOf(input, camel, snake);
}

function prepareStrictShortMarketRegistration(input = {}) {
  const identity = strictIdentity(input.identity);
  const metadata = input.evidenceMetadata ?? input.discoveryEvidence ?? input.evidence ?? {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("discovery evidence metadata must be an object");
  const discoveryPayload = readPayload(valueOf(input, "discoveryPayload", "discovery_payload"));
  const suppliedDiscoveryHash = valueOf(input, "discoveryPayloadHash", "discovery_payload_hash");
  if (suppliedDiscoveryHash != null) {
    strictHash(suppliedDiscoveryHash, "discoveryPayloadHash");
    if (suppliedDiscoveryHash !== discoveryPayload.hash) throw new Error("discoveryPayloadHash does not match discovery payload");
  }
  const suppliedFingerprintHash = valueOf(input, "fingerprintHash", "fingerprint_hash");
  if (suppliedFingerprintHash != null) {
    strictHash(suppliedFingerprintHash, "fingerprintHash");
    if (suppliedFingerprintHash !== identity.fingerprint.hash) throw new Error("fingerprintHash does not match identity fingerprint");
  }
  const parserVersion = strictText(valueOf(input, "parserVersion", "parser_version"), "parserVersion");
  const createdAt = strictIso(valueOf(input, "createdAt", "created_at"), "createdAt").text;
  const evidenceSource = registrationMetadataValue(input, metadata, "source") ?? "GAMMA";
  const evidenceStatus = registrationMetadataValue(input, metadata, "status") ?? "OK";
  if (evidenceSource !== "GAMMA" || evidenceStatus !== "OK") throw new Error("accepted discovery evidence must be GAMMA/OK");
  const candidateKey = registrationMetadataValue(input, metadata, "candidateKey", "candidate_key")
    ?? `${SHORT_OBSERVE_SERIES_ID}:${identity.marketId}`;
  const evaluatorVersion = registrationMetadataValue(input, metadata, "evaluatorVersion", "evaluator_version") ?? parserVersion;
  const evidence = prepareShortMarketEvidence({
    candidateKey,
    marketId: identity.marketId,
    kind: "DISCOVERY",
    source: evidenceSource,
    status: evidenceStatus,
    sourceTimestampMs: registrationMetadataValue(input, metadata, "sourceTimestampMs", "source_timestamp_ms"),
    effectiveTimestampMs: registrationMetadataValue(input, metadata, "effectiveTimestampMs", "effective_timestamp_ms"),
    receivedTimestampMs: registrationMetadataValue(input, metadata, "receivedTimestampMs", "received_timestamp_ms"),
    parserVersion,
    evaluatorVersion,
    payload: valueOf(input, "discoveryPayload", "discovery_payload"),
    rawPayloadHash: registrationMetadataValue(input, metadata, "rawPayloadHash", "raw_payload_hash"),
    canonicalHash: registrationMetadataValue(input, metadata, "canonicalHash", "canonical_hash"),
    idempotencyKey: registrationMetadataValue(input, metadata, "idempotencyKey", "idempotency_key"),
    createdAt,
  });
  return Object.freeze({
    registry: Object.freeze({
      market_id: identity.marketId,
      event_id: identity.eventId,
      condition_id: identity.conditionId,
      series_id: SHORT_OBSERVE_SERIES_ID,
      asset: SHORT_OBSERVE_ASSET.toLowerCase(),
      duration_type: SHORT_OBSERVE_DURATION,
      start_time_ms: identity.startMs,
      end_time_ms: identity.endMs,
      fingerprint_json: identity.fingerprint.serialized,
      fingerprint_hash: identity.fingerprint.hash,
      discovery_payload_hash: discoveryPayload.hash,
      parser_version: parserVersion,
      created_at: createdAt,
    }),
    tokens: Object.freeze([
      Object.freeze({ market_id: identity.marketId, outcome: "UP", token_id: identity.upToken, created_at: createdAt }),
      Object.freeze({ market_id: identity.marketId, outcome: "DOWN", token_id: identity.downToken, created_at: createdAt }),
    ]),
    evidence,
  });
}

function sameColumns(row, expected, columns) {
  return columns.every((column) => row?.[column] === expected[column]);
}

const REGISTRY_COLUMNS = Object.freeze([
  "market_id", "event_id", "condition_id", "series_id", "asset", "duration_type", "start_time_ms", "end_time_ms",
  "fingerprint_json", "fingerprint_hash", "discovery_payload_hash", "parser_version", "created_at",
]);

function strictShortMarketRecord(marketId) {
  const registry = db.prepare("SELECT * FROM short_market_registry WHERE market_id = ?").get(marketId);
  if (!registry) return null;
  const tokens = db.prepare("SELECT market_id, outcome, token_id, created_at FROM short_market_tokens WHERE market_id = ? ORDER BY outcome").all(marketId);
  if (tokens.length !== 2) throw new Error("registered short market must have exactly two tokens");
  const tokenIds = Object.fromEntries(tokens.map((token) => [token.outcome, token.token_id]));
  if (!tokenIds.UP || !tokenIds.DOWN || tokenIds.UP === tokenIds.DOWN) throw new Error("registered short market token mapping is invalid");
  const cryptoFingerprint = JSON.parse(registry.fingerprint_json);
  return {
    eventId: registry.event_id,
    marketId: registry.market_id,
    conditionId: registry.condition_id,
    seriesId: registry.series_id,
    asset: registry.asset.toUpperCase(),
    durationType: registry.duration_type,
    startTime: new Date(registry.start_time_ms).toISOString(),
    endTime: new Date(registry.end_time_ms).toISOString(),
    startMs: registry.start_time_ms,
    endMs: registry.end_time_ms,
    cryptoFingerprint,
    tokenIds,
    registry,
    tokens,
  };
}

export function registerStrictShortMarket(input = {}) {
  try {
    const prepared = prepareStrictShortMarketRegistration(input);
    return db.transaction(() => {
      const existing = db.prepare("SELECT * FROM short_market_registry WHERE market_id = ?").get(prepared.registry.market_id);
      if (existing) {
        if (!sameColumns(existing, prepared.registry, REGISTRY_COLUMNS)) throw new Error("short market registry identity conflict");
        const tokens = db.prepare("SELECT market_id, outcome, token_id, created_at FROM short_market_tokens WHERE market_id = ? ORDER BY outcome").all(prepared.registry.market_id);
        if (tokens.length !== prepared.tokens.length
            || prepared.tokens.some((expected) => !tokens.some((row) => sameColumns(row, expected, ["market_id", "outcome", "token_id", "created_at"])))) {
          throw new Error("short market token identity conflict");
        }
        const discoveryRows = db.prepare("SELECT * FROM short_market_evidence WHERE market_id = ? AND kind = 'DISCOVERY'").all(prepared.registry.market_id);
        if (discoveryRows.length !== 1
            || discoveryRows[0].idempotency_key !== prepared.evidence.idempotency_key
            || !sameEvidenceContent(discoveryRows[0], prepared.evidence)
            || discoveryRows[0].created_at !== prepared.evidence.created_at) {
          throw new Error("short market discovery evidence conflict");
        }
        return strictShortMarketRecord(prepared.registry.market_id);
      }

      db.prepare(`INSERT INTO short_market_registry
        (market_id, event_id, condition_id, series_id, asset, duration_type, start_time_ms, end_time_ms,
         fingerprint_json, fingerprint_hash, discovery_payload_hash, parser_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...REGISTRY_COLUMNS.map((column) => prepared.registry[column]));
      const insertToken = db.prepare("INSERT INTO short_market_tokens (market_id, outcome, token_id, created_at) VALUES (?, ?, ?, ?)");
      for (const token of prepared.tokens) insertToken.run(token.market_id, token.outcome, token.token_id, token.created_at);
      appendPreparedShortMarketEvidence(prepared.evidence);
      return strictShortMarketRecord(prepared.registry.market_id);
    })();
  } catch (error) {
    console.error("[Storage] registerStrictShortMarket error:", error.message);
    return null;
  }
}

export function getStrictShortMarket(marketId) {
  try {
    return strictShortMarketRecord(strictText(marketId, "marketId"));
  } catch (error) {
    console.error("[Storage] getStrictShortMarket error:", error.message);
    return null;
  }
}

function strictObservationMarketProjection(marketId) {
  const market = strictShortMarketRecord(marketId);
  if (!market) return null;
  strictText(market.eventId, "registry.eventId");
  strictText(market.marketId, "registry.marketId");
  strictText(market.conditionId, "registry.conditionId");
  strictText(market.tokenIds.UP, "registry.tokenIds.UP");
  strictText(market.tokenIds.DOWN, "registry.tokenIds.DOWN");
  strictText(market.registry.parser_version, "registry.parserVersion");
  strictIso(market.registry.created_at, "registry.createdAt");
  strictTimestampMs(market.startMs, "registry.startMs");
  strictTimestampMs(market.endMs, "registry.endMs");
  if (market.registry.market_id !== marketId
      || market.registry.asset !== SHORT_OBSERVE_ASSET.toLowerCase()
      || market.seriesId !== SHORT_OBSERVE_SERIES_ID
      || market.asset !== SHORT_OBSERVE_ASSET
      || market.durationType !== SHORT_OBSERVE_DURATION
      || market.endMs - market.startMs !== SHORT_OBSERVE_DURATION_MS) return null;
  for (const token of market.tokens) {
    if (token.market_id !== marketId || !["UP", "DOWN"].includes(token.outcome)) return null;
    strictText(token.token_id, `registry.tokenIds.${token.outcome}`);
    strictIso(token.created_at, `registry.tokens.${token.outcome}.createdAt`);
    if (token.created_at !== market.registry.created_at) return null;
  }
  const fingerprint = readPayload(market.cryptoFingerprint);
  if (fingerprint.serialized !== market.registry.fingerprint_json
      || fingerprint.serialized !== canonicalAuditPayload(SHORT_OBSERVE_CRYPTO_FINGERPRINT)
      || fingerprint.hash !== strictHash(market.registry.fingerprint_hash, "fingerprintHash")) return null;
  const discoveryRows = db.prepare(`SELECT * FROM short_market_evidence
    WHERE market_id = ? AND kind = 'DISCOVERY' AND source = 'GAMMA' AND status = 'OK'
    ORDER BY id`).all(marketId);
  if (discoveryRows.length !== 1) return null;
  const discovery = discoveryRows[0];
  if (discovery.market_id !== marketId
      || discovery.source !== "GAMMA"
      || discovery.status !== "OK"
      || discovery.decimal_value_text !== null
      || discovery.outcome !== null
      || discovery.reason_code !== null) return null;
  strictText(discovery.candidate_key, "discovery.candidateKey");
  strictText(discovery.parser_version, "discovery.parserVersion");
  strictText(discovery.evaluator_version, "discovery.evaluatorVersion");
  strictText(discovery.idempotency_key, "discovery.idempotencyKey");
  strictTimestampMs(discovery.source_timestamp_ms, "discovery.sourceTimestampMs", true);
  strictTimestampMs(discovery.effective_timestamp_ms, "discovery.effectiveTimestampMs", true);
  strictTimestampMs(discovery.received_timestamp_ms, "discovery.receivedTimestampMs");
  strictIso(discovery.created_at, "discovery.createdAt");
  strictHash(discovery.raw_payload_hash, "discovery.rawPayloadHash", true);
  if (discovery.parser_version !== market.registry.parser_version
      || discovery.created_at !== market.registry.created_at) return null;
  const discoveryPayload = readPayload(JSON.parse(discovery.canonical_payload));
  if (discoveryPayload.serialized !== discovery.canonical_payload
      || discoveryPayload.hash !== strictHash(discovery.canonical_hash, "discovery.canonicalHash")
      || discoveryPayload.hash !== strictHash(market.registry.discovery_payload_hash, "discoveryPayloadHash")) return null;
  return {
    eventId: market.eventId,
    marketId: market.marketId,
    conditionId: market.conditionId,
    seriesId: market.seriesId,
    asset: market.asset,
    durationType: market.durationType,
    startTime: market.startTime,
    endTime: market.endTime,
    startMs: market.startMs,
    endMs: market.endMs,
    cryptoFingerprint: market.cryptoFingerprint,
    tokenIds: market.tokenIds,
    parserVersion: market.registry.parser_version,
    createdAt: market.registry.created_at,
    discoveryPayload: JSON.parse(discovery.canonical_payload),
    discoveryEvidence: {
      candidateKey: discovery.candidate_key,
      source: discovery.source,
      status: discovery.status,
      sourceTimestampMs: discovery.source_timestamp_ms,
      effectiveTimestampMs: discovery.effective_timestamp_ms,
      receivedTimestampMs: discovery.received_timestamp_ms,
      parserVersion: discovery.parser_version,
      evaluatorVersion: discovery.evaluator_version,
      canonicalHash: discovery.canonical_hash,
      createdAt: discovery.created_at,
    },
  };
}

function strictStoredShortMarketEvidence(row, expectedMarketId) {
  if (!row || row.market_id !== expectedMarketId) throw new Error("stored evidence market identity mismatch");
  const payload = JSON.parse(row.canonical_payload);
  const prepared = prepareShortMarketEvidence({
    candidateKey: row.candidate_key,
    marketId: row.market_id,
    kind: row.kind,
    source: row.source,
    status: row.status,
    sourceTimestampMs: row.source_timestamp_ms,
    effectiveTimestampMs: row.effective_timestamp_ms,
    receivedTimestampMs: row.received_timestamp_ms,
    decimalValueText: row.decimal_value_text,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    parserVersion: row.parser_version,
    evaluatorVersion: row.evaluator_version,
    payload,
    rawPayloadHash: row.raw_payload_hash,
    canonicalHash: row.canonical_hash,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  });
  if (!sameEvidenceContent(row, prepared) || row.created_at !== prepared.created_at) {
    throw new Error("stored evidence is not canonical");
  }
  return { prepared, payload };
}

function isStrictBoundaryEvidenceAt(prepared, boundaryTimestampMs) {
  if (prepared.kind !== "BOUNDARY_TWAP"
      || prepared.effective_timestamp_ms !== boundaryTimestampMs
      || prepared.outcome !== null) return false;
  if (prepared.status === "OK") {
    return ["RTDS", "CHAINLINK", "CHAINLINK_FALLBACK"].includes(prepared.source)
      && prepared.source_timestamp_ms === boundaryTimestampMs
      && prepared.decimal_value_text !== null
      && prepared.reason_code === null;
  }
  return ["DATA_GAP", "QUARANTINED"].includes(prepared.status)
    && prepared.source === "OBSERVER"
    && prepared.source_timestamp_ms === null
    && prepared.decimal_value_text === null
    && prepared.reason_code !== null;
}

function strictEvidenceProjection(row, stored) {
  return {
    kind: row.kind,
    source: row.source,
    status: row.status,
    sourceTimestampMs: row.source_timestamp_ms,
    effectiveTimestampMs: row.effective_timestamp_ms,
    receivedTimestampMs: row.received_timestamp_ms,
    decimalValueText: row.decimal_value_text,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    parserVersion: row.parser_version,
    evaluatorVersion: row.evaluator_version,
    canonicalHash: row.canonical_hash,
    createdAt: row.created_at,
    payload: stored.payload,
  };
}

function relevantStrictResolutionEvidence(market) {
  const rows = db.prepare(`SELECT * FROM short_market_evidence
    WHERE market_id = ? AND kind IN ('BOUNDARY_TWAP', 'RESOLUTION')
    ORDER BY received_timestamp_ms, effective_timestamp_ms, id`).all(market.marketId);
  const boundaryEvidence = [];
  const resolutionEvidence = [];
  for (const row of rows) {
    try {
      const stored = strictStoredShortMarketEvidence(row, market.marketId);
      if (row.kind === "BOUNDARY_TWAP") {
        if (!isStrictBoundaryEvidenceAt(stored.prepared, market.startMs)
            && !isStrictBoundaryEvidenceAt(stored.prepared, market.endMs)) continue;
        boundaryEvidence.push(strictEvidenceProjection(row, stored));
      } else {
        resolutionEvidence.push(strictEvidenceProjection(row, stored));
      }
    } catch {
      // Legacy malformed evidence is excluded from authority and retry timing.
    }
  }
  return { boundaryEvidence, resolutionEvidence };
}

export function listStrictShortMarketsForObservation({ endAfterMs, startAtOrBeforeMs, limit = 100 } = {}) {
  try {
    const endAfter = strictTimestampMs(endAfterMs, "endAfterMs");
    const startAtOrBefore = strictTimestampMs(startAtOrBeforeMs, "startAtOrBeforeMs");
    const boundedLimit = strictLimit(limit);
    const rows = db.prepare(`SELECT market_id FROM short_market_registry
      WHERE end_time_ms > ? AND start_time_ms <= ?
      ORDER BY start_time_ms, market_id LIMIT ?`).all(endAfter, startAtOrBefore, MAX_SHORT_MARKET_READ_LIMIT);
    const markets = [];
    for (const row of rows) {
      try {
        const market = strictObservationMarketProjection(row.market_id);
        if (market) markets.push(market);
      } catch {
        // A malformed immutable registry/evidence aggregate is excluded fail-closed.
      }
      if (markets.length === boundedLimit) break;
    }
    return markets;
  } catch (error) {
    console.error("[Storage] listStrictShortMarketsForObservation error:", error.message);
    return [];
  }
}

export function appendShortResolutionEvidenceBatch({ marketId, evidence } = {}) {
  try {
    const strictMarketId = strictText(marketId, "marketId");
    if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("resolution evidence batch is required");
    const preparedEvidence = evidence.map((item) => prepareShortMarketEvidence(item));
    return db.transaction(() => {
      const market = strictObservationMarketProjection(strictMarketId);
      if (!market) throw new Error("resolution evidence requires a registered strict market");
      for (const prepared of preparedEvidence) {
        if (prepared.market_id !== strictMarketId) throw new Error("resolution evidence batch market mismatch");
        if (prepared.kind !== "RESOLUTION"
            && !isStrictBoundaryEvidenceAt(prepared, market.endMs)) {
          throw new Error("resolution batch permits only resolution or exact close boundary evidence");
        }
      }
      return preparedEvidence.map((prepared) => appendPreparedShortMarketEvidence(prepared));
    })();
  } catch (error) {
    console.error("[Storage] appendShortResolutionEvidenceBatch error:", error.message);
    return null;
  }
}

export function queryShortMarketEvidence({ marketId = null, candidateKey = null, kind = null, status = null, limit = 100 } = {}) {
  try {
    const conditions = [];
    const params = [];
    if (marketId != null) { conditions.push("market_id = ?"); params.push(strictText(marketId, "marketId")); }
    if (candidateKey != null) { conditions.push("candidate_key = ?"); params.push(strictText(candidateKey, "candidateKey")); }
    if (kind != null) {
      if (!SHORT_MARKET_EVIDENCE_KINDS.has(kind)) throw new Error("unsupported short market evidence kind");
      conditions.push("kind = ?"); params.push(kind);
    }
    if (status != null) {
      if (!SHORT_MARKET_EVIDENCE_STATUSES.has(status)) throw new Error("unsupported short market evidence status");
      conditions.push("status = ?"); params.push(status);
    }
    params.push(strictLimit(limit));
    const rows = db.prepare(`SELECT * FROM short_market_evidence${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id ASC LIMIT ?`).all(...params);
    return rows.map(evidenceRecord);
  } catch (error) {
    console.error("[Storage] queryShortMarketEvidence error:", error.message);
    return [];
  }
}

export function listStrictShortMarketsPendingResolution({
  endAtOrAfterMs = MIN_MILLISECOND_TIMESTAMP,
  endAtOrBeforeMs = Number.MAX_SAFE_INTEGER,
  retryBeforeMs = Number.MAX_SAFE_INTEGER,
  limit = 100,
} = {}) {
  try {
    const endedFrom = strictTimestampMs(endAtOrAfterMs, "endAtOrAfterMs");
    const endedBy = strictTimestampMs(endAtOrBeforeMs, "endAtOrBeforeMs");
    const retryBefore = strictTimestampMs(retryBeforeMs, "retryBeforeMs");
    const boundedLimit = strictLimit(limit);
    return db.transaction(() => {
      const firstPage = db.prepare(`SELECT market_id, end_time_ms FROM short_market_registry
        WHERE end_time_ms >= ? AND end_time_ms <= ?
        ORDER BY end_time_ms, market_id LIMIT ?`).all(endedFrom, endedBy, MAX_SHORT_MARKET_READ_LIMIT);
      const nextPage = db.prepare(`SELECT market_id, end_time_ms FROM short_market_registry
        WHERE end_time_ms >= ? AND end_time_ms <= ?
          AND (end_time_ms > ? OR (end_time_ms = ? AND market_id > ?))
        ORDER BY end_time_ms, market_id LIMIT ?`);
      const pending = [];
      let rows = firstPage;
      while (rows.length > 0 && pending.length < boundedLimit) {
        for (const row of rows) {
          try {
            const market = strictObservationMarketProjection(row.market_id);
            if (!market) continue;
            const relevant = relevantStrictResolutionEvidence(market);
            if (relevant.resolutionEvidence.some((item) => item.status === "RESOLVED")) continue;
            const latestReceivedTimestampMs = relevant.resolutionEvidence.reduce((latest, item) => (
              SHORT_MARKET_NONTERMINAL_RESOLUTION_STATUSES.has(item.status)
                ? Math.max(latest ?? item.receivedTimestampMs, item.receivedTimestampMs)
                : latest
            ), null);
            if (latestReceivedTimestampMs !== null && latestReceivedTimestampMs > retryBefore) continue;
            pending.push({
              ...market,
              boundaryEvidence: relevant.boundaryEvidence,
              resolutionEvidence: relevant.resolutionEvidence,
            });
          } catch {
            // Malformed registry/evidence aggregates never become resolution authority.
          }
          if (pending.length === boundedLimit) break;
        }
        if (pending.length === boundedLimit || rows.length < MAX_SHORT_MARKET_READ_LIMIT) break;
        const last = rows.at(-1);
        rows = nextPage.all(endedFrom, endedBy, last.end_time_ms, last.end_time_ms, last.market_id, MAX_SHORT_MARKET_READ_LIMIT);
      }
      return pending;
    })();
  } catch (error) {
    console.error("[Storage] listStrictShortMarketsPendingResolution error:", error.message);
    return [];
  }
}

function countEvidenceBy(column, sinceMs, allowedValues) {
  const counts = Object.fromEntries([...allowedValues].map((value) => [value, 0]));
  const rows = db.prepare(`SELECT e.${column} AS value, COUNT(*) AS count
    FROM short_market_evidence e
    JOIN short_market_registry r ON r.market_id = e.market_id
    WHERE e.received_timestamp_ms >= ?
    GROUP BY e.${column}
    ORDER BY e.${column}`).all(sinceMs);
  for (const row of rows) {
    if (Object.hasOwn(counts, row.value)) counts[row.value] = Number(row.count);
  }
  return counts;
}

function aggregateRange(minimum, maximum) {
  return { min: minimum ?? null, max: maximum ?? null };
}

function isoAggregateRange(minimum, maximum) {
  const parsedMinimum = minimum == null ? null : Date.parse(minimum);
  const parsedMaximum = maximum == null ? null : Date.parse(maximum);
  return aggregateRange(Number.isFinite(parsedMinimum) ? parsedMinimum : null, Number.isFinite(parsedMaximum) ? parsedMaximum : null);
}

export function getShortObserverSoakSummary({ sinceMs } = {}) {
  try {
    const since = strictTimestampMs(sinceMs, "sinceMs");
    const sinceIso = new Date(since).toISOString();
    return db.transaction(() => {
      const registered = db.prepare(`SELECT COUNT(*) AS count,
        MIN(start_time_ms) AS min_start_time_ms, MAX(start_time_ms) AS max_start_time_ms,
        MIN(end_time_ms) AS min_end_time_ms, MAX(end_time_ms) AS max_end_time_ms,
        MIN(created_at) AS min_created_at, MAX(created_at) AS max_created_at
        FROM short_market_registry WHERE created_at >= ?`).get(sinceIso);
      const runs = db.prepare(`SELECT COUNT(*) AS count,
        MIN(o.next_sequence) AS min_sequence, MAX(o.next_sequence) AS max_sequence,
        MIN(o.created_at) AS min_created_at, MAX(o.created_at) AS max_created_at,
        MIN(o.updated_at) AS min_updated_at, MAX(o.updated_at) AS max_updated_at
        FROM short_observation_runs o
        JOIN short_market_registry r ON r.market_id = o.market_id
        WHERE o.created_at >= ?`).get(sinceIso);
      const snapshots = db.prepare(`SELECT COUNT(*) AS count,
        MIN(s.sequence) AS min_sequence, MAX(s.sequence) AS max_sequence,
        MIN(s.captured_at) AS min_captured_at, MAX(s.captured_at) AS max_captured_at,
        MIN(s.created_at) AS min_created_at, MAX(s.created_at) AS max_created_at
        FROM short_evaluation_snapshots s
        JOIN short_market_registry r ON r.market_id = s.market_id
        WHERE s.run_id IS NOT NULL AND s.created_at >= ?`).get(sinceIso);
      const evidence = db.prepare(`SELECT COUNT(*) AS count,
        MIN(e.source_timestamp_ms) AS min_source_timestamp_ms, MAX(e.source_timestamp_ms) AS max_source_timestamp_ms,
        MIN(e.effective_timestamp_ms) AS min_effective_timestamp_ms, MAX(e.effective_timestamp_ms) AS max_effective_timestamp_ms,
        MIN(e.received_timestamp_ms) AS min_received_timestamp_ms, MAX(e.received_timestamp_ms) AS max_received_timestamp_ms
        FROM short_market_evidence e
        JOIN short_market_registry r ON r.market_id = e.market_id
        WHERE e.received_timestamp_ms >= ?`).get(since);
      const byKind = countEvidenceBy("kind", since, SHORT_MARKET_EVIDENCE_KINDS);
      const byStatus = countEvidenceBy("status", since, SHORT_MARKET_EVIDENCE_STATUSES);
      const bySource = countEvidenceBy("source", since, SHORT_MARKET_EVIDENCE_SOURCES);
      return {
        sinceMs: since,
        registeredMarkets: {
          count: Number(registered.count),
          startTimestampMs: aggregateRange(registered.min_start_time_ms, registered.max_start_time_ms),
          endTimestampMs: aggregateRange(registered.min_end_time_ms, registered.max_end_time_ms),
          createdTimestampMs: isoAggregateRange(registered.min_created_at, registered.max_created_at),
        },
        runs: {
          count: Number(runs.count),
          sequence: aggregateRange(runs.min_sequence, runs.max_sequence),
          createdTimestampMs: isoAggregateRange(runs.min_created_at, runs.max_created_at),
          updatedTimestampMs: isoAggregateRange(runs.min_updated_at, runs.max_updated_at),
        },
        snapshots: {
          count: Number(snapshots.count),
          sequence: aggregateRange(snapshots.min_sequence, snapshots.max_sequence),
          capturedTimestampMs: isoAggregateRange(snapshots.min_captured_at, snapshots.max_captured_at),
          createdTimestampMs: isoAggregateRange(snapshots.min_created_at, snapshots.max_created_at),
        },
        evidence: {
          count: Number(evidence.count),
          byKind,
          byStatus,
          bySource,
          resolvedCount: byStatus.RESOLVED,
          dataGapCount: byStatus.DATA_GAP,
          quarantinedCount: byStatus.QUARANTINED,
          sourceTimestampMs: aggregateRange(evidence.min_source_timestamp_ms, evidence.max_source_timestamp_ms),
          effectiveTimestampMs: aggregateRange(evidence.min_effective_timestamp_ms, evidence.max_effective_timestamp_ms),
          receivedTimestampMs: aggregateRange(evidence.min_received_timestamp_ms, evidence.max_received_timestamp_ms),
        },
      };
    })();
  } catch {
    return null;
  }
}

export function appendShortEvaluationSnapshot({
  marketId = null, marketQuestion = null, durationType = null, asset = null,
  capturedAt, createdAt = new Date().toISOString(),
  contractVersion = SHORT_EVALUATION_CONTRACT_VERSION, modelVersion = SHORT_EVALUATION_MODEL_VERSION,
  auditPayload = null, payload = auditPayload, runId = null, sequence = null,
  collectionMode = null, scheduledAt = null, startedAt = null, finishedAt = null,
  attemptStatus = null, errorCode = null, leaseOwner = null, leaseToken = null, now = null,
} = {}) {
  if (runId != null || sequence != null) return appendShortEvaluationSnapshotAttempt({
    marketId, marketQuestion, durationType, asset, capturedAt, createdAt, contractVersion,
    modelVersion, auditPayload: payload, runId, sequence, collectionMode, scheduledAt,
    startedAt, finishedAt, attemptStatus, errorCode, leaseOwner, leaseToken, now,
  });
  try {
    if (!capturedAt) throw new Error("capturedAt is required for a short evaluation snapshot");
    const serialized = readPayload(payload);
    const info = db.prepare(`INSERT INTO short_evaluation_snapshots
      (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      marketId == null ? null : String(marketId), marketQuestion == null ? null : String(marketQuestion),
      durationType == null ? null : String(durationType), asset == null ? null : String(asset), String(capturedAt), String(createdAt),
      String(contractVersion), String(modelVersion), serialized.serialized, serialized.hash,
    );
    return Number(info.lastInsertRowid);
  } catch (error) { console.error("[Storage] appendShortEvaluationSnapshot error:", error.message); return null; }
}

export function getShortEvaluationSnapshots({ marketId = null, marketQuestion = null, limit = 100 } = {}) {
  try {
    const conditions = []; const params = [];
    if (marketId != null) { conditions.push("market_id = ?"); params.push(String(marketId)); }
    if (marketQuestion != null) { conditions.push("market_question = ?"); params.push(String(marketQuestion)); }
    params.push(Math.max(0, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 100)));
    const rows = db.prepare(`SELECT id, market_id, market_question, duration_type, asset, captured_at, created_at,
      contract_version, model_version, payload, audit_payload_hash, run_id, sequence, collection_mode,
      scheduled_at, started_at, finished_at, attempt_status, error_code FROM short_evaluation_snapshots
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  } catch (error) { console.error("[Storage] getShortEvaluationSnapshots error:", error.message); return []; }
}

function prepareShortCalibrationForecast(input = {}, { allowMissingEvaluationSnapshot = false } = {}) {
  const marketId = strictText(valueOf(input, "marketId", "market_id"), "marketId");
  const evaluationSnapshotId = valueOf(input, "evaluationSnapshotId", "evaluation_snapshot_id")
    ?? valueOf(input, "snapshotId", "snapshot_id");
  if (allowMissingEvaluationSnapshot && evaluationSnapshotId == null) {
    // The collector supplies the snapshot and forecast in one transaction.
  } else if (!Number.isSafeInteger(evaluationSnapshotId) || evaluationSnapshotId <= 0) {
    throw new Error("evaluationSnapshotId must be a positive integer");
  }
  const snapshotHashValue = valueOf(input, "snapshotHash", "snapshot_hash");
  const snapshotHash = strictHash(snapshotHashValue, "snapshotHash", true);
  const openingEvidenceHashValue = valueOf(input, "openingEvidenceHash", "opening_evidence_hash");
  const openingEvidenceKindValue = valueOf(input, "openingEvidenceKind", "opening_evidence_kind");
  if (openingEvidenceHashValue == null || openingEvidenceKindValue == null) {
    throw new Error("openingEvidenceHash and openingEvidenceKind are required");
  }
  const openingEvidenceHash = strictHash(openingEvidenceHashValue, "openingEvidenceHash");
  const openingEvidenceKind = strictText(openingEvidenceKindValue, "openingEvidenceKind");
  const capturedTimestampMs = strictTimestampMs(
    valueOf(input, "capturedTimestampMs", "captured_timestamp_ms"), "capturedTimestampMs",
  );
  const oracleTimestampMs = strictTimestampMs(
    valueOf(input, "oracleTimestampMs", "oracle_timestamp_ms"), "oracleTimestampMs",
  );
  const remainingMs = valueOf(input, "remainingMs", "remaining_ms");
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) throw new Error("remainingMs must be a positive integer");
  const probabilityUpPpm = valueOf(input, "probabilityUpPpm", "probability_up_ppm");
  if (!Number.isSafeInteger(probabilityUpPpm) || probabilityUpPpm < 0 || probabilityUpPpm > 1_000_000) {
    throw new Error("probabilityUpPpm must be an integer between 0 and 1000000");
  }
  const modelVersion = strictText(valueOf(input, "modelVersion", "model_version"), "modelVersion");
  const featureContractVersion = strictText(
    valueOf(input, "featureContractVersion", "feature_contract_version"), "featureContractVersion",
  );
  const features = readStrictCanonicalJson(valueOf(input, "featuresJson", "features_json"), "featuresJson");
  const featuresHash = strictHash(valueOf(input, "featuresHash", "features_hash"), "featuresHash");
  if (auditPayloadHash(features.text) !== featuresHash) throw new Error("featuresHash does not match featuresJson");
  const decision = readStrictCanonicalJson(valueOf(input, "decisionJson", "decision_json"), "decisionJson");
  const decisionHash = strictHash(valueOf(input, "decisionHash", "decision_hash"), "decisionHash");
  if (auditPayloadHash(decision.text) !== decisionHash) throw new Error("decisionHash does not match decisionJson");
  const decisionKeys = Object.keys(decision.value).sort();
  if (decisionKeys.join("\u0000") !== ["downProbabilityPpm", "featureHash", "modelVersion", "upProbabilityPpm"].join("\u0000")
      || decision.value.featureHash !== featuresHash
      || decision.value.modelVersion !== modelVersion
      || decision.value.upProbabilityPpm !== probabilityUpPpm
      || !Number.isSafeInteger(decision.value.upProbabilityPpm)
      || decision.value.upProbabilityPpm < 0 || decision.value.upProbabilityPpm > 1_000_000
      || decision.value.downProbabilityPpm !== 1_000_000 - decision.value.upProbabilityPpm) {
    throw new Error("decision JSON does not match forecast fields");
  }
  const idempotencyKey = strictText(valueOf(input, "idempotencyKey", "idempotency_key"), "idempotencyKey");
  const createdAt = strictIso(valueOf(input, "createdAt", "created_at") ?? new Date().toISOString(), "createdAt").text;

  return Object.freeze({
    market_id: marketId,
    evaluation_snapshot_id: evaluationSnapshotId ?? null,
    opening_evidence_id: null,
    captured_timestamp_ms: capturedTimestampMs,
    oracle_timestamp_ms: oracleTimestampMs,
    remaining_ms: remainingMs,
    probability_up_ppm: probabilityUpPpm,
    model_version: modelVersion,
    feature_contract_version: featureContractVersion,
    features_json: features.text,
    features_hash: featuresHash,
    decision_json: decision.text,
    decision_hash: decisionHash,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
    snapshot_hash: snapshotHash,
    opening_evidence_hash: openingEvidenceHash,
    opening_evidence_kind: openingEvidenceKind,
    allow_opening_evidence_hydration: allowMissingEvaluationSnapshot,
    features_value: features.value,
    decision_value: decision.value,
  });
}

function sameShortCalibrationForecastContent(row, prepared) {
  return SHORT_FORECAST_CONTENT_COLUMNS.every((column) => row?.[column] === prepared[column]);
}

function shortCalibrationForecastRecord(row) {
  return row ? { ...row } : null;
}

function bindOpeningEvidenceToForecast(prepared, evidenceId) {
  const opening = prepared.features_value.opening;
  if (!opening || typeof opening !== "object" || Array.isArray(opening)) {
    throw new Error("features JSON must contain an opening evidence binding");
  }
  if (opening.evidenceId != null && opening.evidenceId !== evidenceId) {
    throw new Error("opening evidence id does not match persisted evidence");
  }
  if (opening.evidenceHash != null && typeof opening.evidenceHash !== "string") {
    throw new Error("opening evidence hash must be exact text");
  }
  const featuresValue = {
    ...prepared.features_value,
    opening: { ...opening, evidenceId },
  };
  const featuresJson = canonicalAuditPayload(featuresValue);
  const featuresHash = auditPayloadHash(featuresJson);
  const decisionValue = { ...prepared.decision_value, featureHash: featuresHash };
  const decisionJson = canonicalAuditPayload(decisionValue);
  return {
    ...prepared,
    features_value: featuresValue,
    features_json: featuresJson,
    features_hash: featuresHash,
    decision_value: decisionValue,
    decision_json: decisionJson,
    decision_hash: auditPayloadHash(decisionJson),
  };
}

function validateShortCalibrationForecastReferences(prepared, market, snapshot, evidence) {
  if (prepared.opening_evidence_id == null || !evidence) throw new Error("opening evidence is required");
  if (evidence.market_id !== prepared.market_id
      || evidence.kind !== "BOUNDARY_TWAP"
      || evidence.status !== "OK"
      || evidence.effective_timestamp_ms !== market.start_time_ms
      || evidence.candidate_key !== `strict-observe:${prepared.market_id}:${snapshot.run_id}:${snapshot.sequence}`
      || !["RTDS", "CHAINLINK_FALLBACK"].includes(evidence.source)) {
    throw new Error("opening evidence is not an authoritative opening projection");
  }
  const opening = prepared.features_value.opening;
  const openingValue = strictText(opening?.usdPriceText, "features.opening.usdPriceText");
  if (!PLAIN_DECIMAL.test(openingValue) || Number(openingValue) <= 0
      || evidence.decimal_value_text !== openingValue
      || opening.evidenceId !== evidence.id
      || opening.evidenceHash !== evidence.canonical_hash) {
    throw new Error("opening evidence is not cryptographically bound to features");
  }
  if (prepared.features_value.modelVersion !== prepared.model_version
      || prepared.features_value.featureContractVersion !== prepared.feature_contract_version
      || prepared.features_value.registry?.discoveryPayloadHash !== market.discovery_payload_hash
      || prepared.features_value.registry?.fingerprintHash !== market.fingerprint_hash) {
    throw new Error("forecast features are not bound to the registered market");
  }
  const cadence = prepared.features_value.cadence;
  const candles = prepared.features_value.candles;
  const volatility = prepared.features_value.volatility;
  if (!cadence || cadence.usable !== true
      || !candles || !Number.isSafeInteger(candles.rawCount) || !Number.isSafeInteger(candles.uniqueCount)
      || candles.rawCount < candles.uniqueCount || candles.uniqueCount < 35
      || cadence.inflationFactor !== volatility?.inflationFactor
      || cadence.inflationFactor < 1 || cadence.inflationFactor > 2) {
    throw new Error("forecast cadence and volatility are not retained");
  }
  if (!snapshot
      || snapshot.run_id == null
      || snapshot.sequence == null
      || snapshot.attempt_status !== "completed"
      || snapshot.collection_mode !== "observe_only"
      || snapshot.contract_version !== STRICT_OBSERVE_CONTRACT_VERSION
      || snapshot.model_version !== STRICT_OBSERVE_MODEL_VERSION
      || snapshot.market_id !== prepared.market_id
      || snapshot.duration_type !== "15m"
      || String(snapshot.asset).toUpperCase() !== "BTC"
      || String(snapshot.run_id) !== String(prepared.features_value.run_id)
      || Number(snapshot.sequence) !== prepared.features_value.sequence) {
    throw new Error("evaluation snapshot is not a completed strict collector attempt");
  }
  const audit = readStrictCanonicalJson(snapshot.payload, "snapshot.payload").value;
  const forecastAudit = audit.forecast;
  if (!forecastAudit || typeof forecastAudit !== "object" || Array.isArray(forecastAudit)
      || forecastAudit.featuresHash !== prepared.features_hash
      || forecastAudit.decisionHash !== prepared.decision_hash
      || forecastAudit.opening?.evidenceId !== evidence.id
      || forecastAudit.opening?.evidenceHash !== evidence.canonical_hash
      || forecastAudit.current?.rawFrameHash !== prepared.features_value.current?.rawFrameHash
      || forecastAudit.candles?.payloadSha256 !== prepared.features_value.candles?.payloadSha256
      || !Array.isArray(forecastAudit.rawClosedCandles)
      || auditPayloadHash(canonicalAuditPayload(forecastAudit.rawClosedCandles)) !== prepared.features_value.candles?.payloadSha256
      || forecastAudit.rawClosedCandles.length !== prepared.features_value.candles?.uniqueCount
      || auditPayloadHash(canonicalAuditPayload(forecastAudit.current?.rawFrame)) !== prepared.features_value.current?.rawFrameHash
      || forecastAudit.volatility?.intervalVolatilityText !== prepared.features_value.volatility?.intervalVolatilityText) {
    throw new Error("snapshot audit payload is not bound to the strict forecast");
  }
  const captured = strictIso(snapshot.captured_at, "snapshot.captured_at").milliseconds;
  const finished = strictIso(snapshot.finished_at, "snapshot.finished_at").milliseconds;
  const started = strictIso(snapshot.started_at, "snapshot.started_at").milliseconds;
  const scheduled = strictIso(snapshot.scheduled_at, "snapshot.scheduled_at").milliseconds;
  if (captured !== prepared.captured_timestamp_ms
      || finished !== captured
      || started > captured
      || scheduled > captured
      || prepared.remaining_ms !== market.end_time_ms - captured
      || prepared.remaining_ms <= 0
      || prepared.features_value.modelAsOfMs !== captured
      || prepared.features_value.remainingMs !== prepared.remaining_ms
      || prepared.features_value.current?.timestampMs !== prepared.oracle_timestamp_ms
      || !Number.isSafeInteger(prepared.oracle_timestamp_ms)
      || prepared.oracle_timestamp_ms < captured - 15_000
      || prepared.oracle_timestamp_ms > captured + 2_000) {
    throw new Error("forecast timing is not bound to the evaluation snapshot");
  }
}

function recordPreparedShortCalibrationForecastTransaction(prepared) {
      const market = db.prepare(`SELECT * FROM short_market_registry
        WHERE market_id = ? AND asset = 'btc' AND duration_type = '15m'`).get(prepared.market_id);
      if (!market) throw new Error("short calibration forecast references an unknown BTC 15m market");

      let snapshot = db.prepare(`SELECT *
        FROM short_evaluation_snapshots WHERE id = ?`).get(prepared.evaluation_snapshot_id);
      if (!snapshot) throw new Error("short calibration forecast references an invalid evaluation snapshot");
      if (prepared.snapshot_hash != null && snapshot.audit_payload_hash !== prepared.snapshot_hash) {
        throw new Error("evaluation snapshot hash mismatch");
      }

      let evidence = null;
      if (prepared.opening_evidence_hash != null) {
        evidence = db.prepare(`SELECT * FROM short_market_evidence
          WHERE market_id = ? AND kind = ? AND canonical_hash = ? ORDER BY id LIMIT 1`).get(
          prepared.market_id, prepared.opening_evidence_kind, prepared.opening_evidence_hash,
        );
        if (!evidence) throw new Error("opening evidence hash does not match a stored row");
        prepared = { ...prepared, opening_evidence_id: evidence.id };
        if (prepared.allow_opening_evidence_hydration && prepared.features_value.opening?.evidenceId == null) {
          prepared = bindOpeningEvidenceToForecast(prepared, evidence.id);
        }
      }
      validateShortCalibrationForecastReferences(prepared, market, snapshot, evidence);

      const existingByKey = db.prepare("SELECT * FROM short_calibration_forecasts WHERE idempotency_key = ?")
        .get(prepared.idempotency_key);
      const existingBySnapshot = db.prepare(`SELECT * FROM short_calibration_forecasts
        WHERE evaluation_snapshot_id = ? AND model_version = ?`).get(
        prepared.evaluation_snapshot_id, prepared.model_version,
      );
      for (const existing of [existingByKey, existingBySnapshot]) {
        if (existing) {
          if (!sameShortCalibrationForecastContent(existing, prepared)) {
            throw new Error("short calibration forecast idempotency conflict");
          }
          return Number(existing.id);
        }
      }

      const info = db.prepare(`INSERT INTO short_calibration_forecasts
        (market_id, evaluation_snapshot_id, opening_evidence_id, captured_timestamp_ms, oracle_timestamp_ms,
         remaining_ms, probability_up_ppm, model_version, feature_contract_version, features_json, features_hash,
         decision_json, decision_hash, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ...SHORT_FORECAST_CONTENT_COLUMNS.slice(0, -1).map((column) => prepared[column]),
        prepared.created_at,
      );
      return Number(info.lastInsertRowid);
}

export function recordShortCalibrationForecast(input = {}) {
  try {
    const prepared = prepareShortCalibrationForecast(input);
    return db.transaction(() => recordPreparedShortCalibrationForecastTransaction(prepared))();
  } catch (error) {
    console.error("[Storage] recordShortCalibrationForecast error:", error.message);
    return null;
  }
}

export function getShortCalibrationForecasts({ marketId = null, modelVersion = null, limit = 100 } = {}) {
  try {
    const conditions = [];
    const params = [];
    if (marketId != null) { conditions.push("market_id = ?"); params.push(strictText(marketId, "marketId")); }
    if (modelVersion != null) { conditions.push("model_version = ?"); params.push(strictText(modelVersion, "modelVersion")); }
    params.push(strictLimit(limit));
    const rows = db.prepare(`SELECT id, market_id, evaluation_snapshot_id, opening_evidence_id,
      captured_timestamp_ms, oracle_timestamp_ms, remaining_ms, probability_up_ppm, model_version,
      feature_contract_version, features_json, features_hash, decision_json, decision_hash,
      idempotency_key, created_at FROM short_calibration_forecasts
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT ?`).all(...params);
    return rows.map(shortCalibrationForecastRecord);
  } catch (error) {
    console.error("[Storage] getShortCalibrationForecasts error:", error.message);
    return [];
  }
}

export function getShortForecastCalibrationSummary({ modelVersion = null } = {}) {
  try {
    const params = [];
    let modelClause = "";
    if (modelVersion != null) {
      modelClause = " AND f.model_version = ?";
      params.push(strictText(modelVersion, "modelVersion"));
    }
    const rows = db.prepare(`SELECT f.id, f.market_id, f.probability_up_ppm,
        e.id AS resolution_id, e.candidate_key, e.kind, e.source, e.status,
        e.source_timestamp_ms, e.effective_timestamp_ms, e.received_timestamp_ms,
        e.decimal_value_text, e.outcome, e.reason_code, e.parser_version,
        e.evaluator_version, e.canonical_payload, e.raw_payload_hash,
        e.canonical_hash, e.idempotency_key, e.created_at
      FROM short_calibration_forecasts f
      JOIN short_market_registry r ON r.market_id = f.market_id
      LEFT JOIN short_market_evidence e
        ON e.market_id = f.market_id AND e.kind = 'RESOLUTION' AND e.status = 'RESOLVED'
      WHERE 1 = 1${modelClause}
      ORDER BY f.id, e.id`).all(...params);
    const forecasts = new Map();
    const resolutionOutcomes = new Map();
    const conflictedMarkets = new Set();
    for (const row of rows) {
      forecasts.set(row.id, row);
      if (row.resolution_id == null) continue;
      try {
        const stored = strictStoredShortMarketEvidence({
          id: row.resolution_id,
          market_id: row.market_id,
          candidate_key: row.candidate_key,
          kind: row.kind,
          source: row.source,
          status: row.status,
          source_timestamp_ms: row.source_timestamp_ms,
          effective_timestamp_ms: row.effective_timestamp_ms,
          received_timestamp_ms: row.received_timestamp_ms,
          decimal_value_text: row.decimal_value_text,
          outcome: row.outcome,
          reason_code: row.reason_code,
          parser_version: row.parser_version,
          evaluator_version: row.evaluator_version,
          canonical_payload: row.canonical_payload,
          raw_payload_hash: row.raw_payload_hash,
          canonical_hash: row.canonical_hash,
          idempotency_key: row.idempotency_key,
          created_at: row.created_at,
        }, row.market_id);
        if (stored.prepared.status !== "RESOLVED" || stored.prepared.kind !== "RESOLUTION") continue;
        const previous = resolutionOutcomes.get(row.market_id);
        if (previous != null && previous !== stored.prepared.outcome) conflictedMarkets.add(row.market_id);
        else resolutionOutcomes.set(row.market_id, stored.prepared.outcome);
      } catch {
        // Legacy or malformed terminal rows are not calibration authority.
      }
    }
    for (const marketId of conflictedMarkets) resolutionOutcomes.delete(marketId);

    let forecastCount = 0;
    let distinctMarketCount = forecasts.size === 0 ? 0 : new Set([...forecasts.values()].map((row) => row.market_id)).size;
    let resolvedCount = 0;
    let probabilitySum = 0;
    let upCount = 0;
    for (const row of forecasts.values()) {
      forecastCount += 1;
      probabilitySum += Number(row.probability_up_ppm);
      const outcome = resolutionOutcomes.get(row.market_id);
      if (outcome == null) continue;
      resolvedCount += 1;
      if (outcome === "UP") upCount += 1;
    }
    return {
      forecastCount,
      distinctMarketCount,
      resolvedCount,
      meanProbabilityUpPpm: forecastCount === 0 ? null : Math.trunc(probabilitySum / forecastCount),
      empiricalUpRatePpm: resolvedCount === 0 ? null : Math.trunc(upCount * 1_000_000 / resolvedCount),
    };
  } catch (error) {
    console.error("[Storage] getShortForecastCalibrationSummary error:", error.message);
    return null;
  }
}

function runRow(runId) { return db.prepare("SELECT * FROM short_observation_runs WHERE run_id = ?").get(String(runId)) || null; }
function canonicalConfig(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be an object");
  return JSON.stringify(canonicalize(parsed));
}

export function enrollShortObservationRun(input = {}) {
  try {
    const runId = valueOf(input, "runId", "run_id"); const enrollmentKey = valueOf(input, "enrollmentKey", "enrollment_key");
    const marketId = valueOf(input, "marketId", "market_id"); const marketQuestion = valueOf(input, "marketQuestion", "market_question");
    const asset = valueOf(input, "asset"); const durationType = valueOf(input, "durationType", "duration_type");
    const nextScheduledAt = valueOf(input, "nextScheduledAt", "next_scheduled_at");
    if ([runId, enrollmentKey, marketId, marketQuestion, asset, durationType, nextScheduledAt].some((v) => v == null || String(v) === "")) throw new Error("run enrollment requires canonical identity and schedule");
    const config = canonicalConfig(valueOf(input, "config", "config_json") ?? input.configJson);
    const createdAt = nowIso(valueOf(input, "createdAt", "created_at"));
    db.prepare(`INSERT INTO short_observation_runs
      (run_id, enrollment_key, market_id, market_question, asset, duration_type, config_json, status, next_sequence, next_scheduled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?) ON CONFLICT(enrollment_key) DO NOTHING`).run(
      String(runId), String(enrollmentKey), String(marketId), String(marketQuestion), String(asset), String(durationType), config,
      Number(valueOf(input, "nextSequence", "next_sequence") ?? 0), String(nextScheduledAt), createdAt, nowIso(valueOf(input, "updatedAt", "updated_at") ?? createdAt),
    );
    return db.prepare("SELECT * FROM short_observation_runs WHERE enrollment_key = ?").get(String(enrollmentKey)) || null;
  } catch (error) { console.error("[Storage] enrollShortObservationRun error:", error.message); return null; }
}
export const enrollShortObservation = enrollShortObservationRun;
export function getShortObservationRun(runId) { try { return runRow(runId); } catch { return null; } }
export function getShortObservationRuns({ status = null, limit = 100 } = {}) {
  try { const params = []; const where = status == null ? "" : " WHERE status = ?"; if (status != null) params.push(String(status)); params.push(Math.max(0, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 100))); return db.prepare(`SELECT * FROM short_observation_runs${where} ORDER BY next_scheduled_at, run_id LIMIT ?`).all(...params); } catch { return []; }
}
export const listShortObservationRuns = getShortObservationRuns;

function leaseArgs(input, owner, token, expiresAt, now) {
  if (input && typeof input === "object") return {
    runId: valueOf(input, "runId", "run_id"), leaseOwner: valueOf(input, "leaseOwner", "lease_owner") ?? valueOf(input, "owner"),
    leaseToken: valueOf(input, "leaseToken", "lease_token") ?? valueOf(input, "token"), leaseExpiresAt: valueOf(input, "leaseExpiresAt", "lease_expires_at") ?? valueOf(input, "expiresAt"), now: valueOf(input, "now") ?? valueOf(input, "at"),
  };
  return { runId: input, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expiresAt, now };
}
export function claimShortObservationRun(input, owner, token, expiresAt, at) {
  try { const args = leaseArgs(input, owner, token, expiresAt, at); if (!args.runId || !args.leaseOwner || !args.leaseExpiresAt) throw new Error("lease claim requires owner and expiry"); const leaseToken = String(args.leaseToken || randomUUID()); const now = nowIso(args.now); const info = db.prepare(`UPDATE short_observation_runs SET lease_token = ?, lease_owner = ?, lease_expires_at = ?, status = CASE WHEN status = 'scheduled' THEN 'observing' ELSE status END, started_at = COALESCE(started_at, ?), updated_at = ? WHERE run_id = ? AND status IN ('scheduled', 'observing') AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`).run(leaseToken, String(args.leaseOwner), String(args.leaseExpiresAt), now, now, String(args.runId), now); return info.changes === 1 ? runRow(args.runId) : null; } catch (error) { console.error("[Storage] claimShortObservationRun error:", error.message); return null; }
}
export function releaseShortObservationRun(input, owner, token, at) {
  try { const args = leaseArgs(input, owner, token, undefined, at); if (!args.runId || !args.leaseOwner || !args.leaseToken) throw new Error("lease release requires owner and token"); return db.prepare("UPDATE short_observation_runs SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ? AND lease_owner = ? AND lease_token = ?").run(nowIso(args.now), String(args.runId), String(args.leaseOwner), String(args.leaseToken)).changes === 1; } catch { return false; }
}
const terminalStatuses = new Set(["completed", "missed", "invalid"]);
export function terminalizeShortObservationRun(input = {}) {
  try { const runId = valueOf(input, "runId", "run_id"); const status = String(valueOf(input, "status") || ""); const owner = valueOf(input, "leaseOwner", "lease_owner") ?? valueOf(input, "owner"); const token = valueOf(input, "leaseToken", "lease_token") ?? valueOf(input, "token"); const now = nowIso(valueOf(input, "now")); const terminalAt = String(valueOf(input, "terminalAt", "terminal_at") ?? now); if (!runId || !terminalStatuses.has(status) || !owner || !token) return null; return db.transaction(() => { const info = db.prepare(`UPDATE short_observation_runs SET status = ?, terminal_at = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END, error_code = ?, error_message = ?, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ? AND status IN ('scheduled', 'observing')`).run(status, terminalAt, status, terminalAt, valueOf(input, "errorCode", "error_code") ?? null, valueOf(input, "errorMessage", "error_message") ?? null, now, String(runId), String(owner), String(token), now); if (info.changes !== 1) throw new Error("terminal transition was lease-fenced"); return runRow(runId); })(); } catch { return null; }
}
export const transitionShortObservationRunTerminal = terminalizeShortObservationRun;

function prepareShortEvaluationSnapshotAttempt(input) {
  const runId = valueOf(input, "runId", "run_id");
  const sequence = Number(valueOf(input, "sequence"));
  const owner = valueOf(input, "leaseOwner", "lease_owner") ?? valueOf(input, "owner");
  const token = valueOf(input, "leaseToken", "lease_token") ?? valueOf(input, "token");
  const marketId = valueOf(input, "marketId", "market_id");
  const marketQuestion = valueOf(input, "marketQuestion", "market_question");
  const durationType = valueOf(input, "durationType", "duration_type");
  const asset = valueOf(input, "asset");
  const capturedAt = valueOf(input, "capturedAt", "captured_at");
  const now = nowIso(valueOf(input, "now"));
  if (!runId || !Number.isInteger(sequence) || sequence < 0 || !owner || !token
      || [marketId, marketQuestion, durationType, asset, capturedAt].some((value) => value == null || String(value) === "")) {
    throw new Error("collector attempt requires lease, identity, and sequence");
  }
  return Object.freeze({
    runId: String(runId),
    sequence,
    owner: String(owner),
    token: String(token),
    marketId: String(marketId),
    marketQuestion: String(marketQuestion),
    durationType: String(durationType),
    asset: String(asset),
    capturedAt: String(capturedAt),
    now,
    createdAt: nowIso(valueOf(input, "createdAt", "created_at")),
    contractVersion: String(valueOf(input, "contractVersion", "contract_version") ?? SHORT_EVALUATION_CONTRACT_VERSION),
    modelVersion: String(valueOf(input, "modelVersion", "model_version") ?? SHORT_EVALUATION_MODEL_VERSION),
    payload: readPayload(valueOf(input, "auditPayload") ?? valueOf(input, "payload")),
    collectionMode: valueOf(input, "collectionMode", "collection_mode") ?? null,
    scheduledAt: valueOf(input, "scheduledAt", "scheduled_at") ?? null,
    startedAt: valueOf(input, "startedAt", "started_at") ?? null,
    finishedAt: valueOf(input, "finishedAt", "finished_at") ?? null,
    attemptStatus: valueOf(input, "attemptStatus", "attempt_status") ?? null,
    errorCode: valueOf(input, "errorCode", "error_code") ?? null,
    nextScheduledAt: valueOf(input, "nextScheduledAt", "next_scheduled_at") ?? null,
  });
}

function appendObservationAttemptTransaction(attempt, preparedEvidence = null) {
  return db.transaction(() => {
    const run = db.prepare(`SELECT * FROM short_observation_runs
      WHERE run_id = ? AND market_id = ? AND market_question = ? AND duration_type = ? AND asset = ?
        AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?
        AND status IN ('scheduled', 'observing')`).get(
      attempt.runId, attempt.marketId, attempt.marketQuestion, attempt.durationType, attempt.asset,
      attempt.owner, attempt.token, attempt.now,
    );
    if (!run || attempt.sequence !== Number(run.next_sequence)) throw new Error("collector lease or sequence is not active");

    let transactionAttempt = attempt;
    if (preparedEvidence !== null) {
      const strictMarket = strictObservationMarketProjection(attempt.marketId);
      if (!strictMarket
          || strictMarket.asset !== attempt.asset
          || strictMarket.durationType !== attempt.durationType
          || preparedEvidence.some((evidence) => evidence.market_id !== attempt.marketId)) {
        throw new Error("strict collector attempt market identity is invalid");
      }
      const persistedEvidence = preparedEvidence.map((evidence) => appendPreparedShortMarketEvidence(evidence));
      if (attempt.forecast) {
        const openingEvidence = persistedEvidence.find((evidence) => evidence.kind === "BOUNDARY_TWAP"
          && evidence.effective_timestamp_ms === strictMarket.start_time_ms);
        if (!openingEvidence) throw new Error("strict collector attempt has no opening evidence");
        const boundForecast = bindOpeningEvidenceToForecast(attempt.forecast, openingEvidence.id);
        const audit = JSON.parse(attempt.payload.serialized);
        if (!audit.forecast || typeof audit.forecast !== "object") throw new Error("forecast audit block is required");
        audit.forecast.opening = { ...audit.forecast.opening, evidenceId: openingEvidence.id };
        audit.forecast.featuresHash = boundForecast.features_hash;
        audit.forecast.decisionHash = boundForecast.decision_hash;
        transactionAttempt = { ...attempt, payload: readPayload(audit), forecast: boundForecast };
      }
    }

    const info = db.prepare(`INSERT INTO short_evaluation_snapshots
      (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version,
       payload, audit_payload_hash, run_id, sequence, collection_mode, scheduled_at, started_at, finished_at,
       attempt_status, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      transactionAttempt.marketId, transactionAttempt.marketQuestion, transactionAttempt.durationType, transactionAttempt.asset, transactionAttempt.capturedAt,
      transactionAttempt.createdAt, transactionAttempt.contractVersion, transactionAttempt.modelVersion, transactionAttempt.payload.serialized,
      transactionAttempt.payload.hash, transactionAttempt.runId, transactionAttempt.sequence, transactionAttempt.collectionMode, transactionAttempt.scheduledAt,
      transactionAttempt.startedAt, transactionAttempt.finishedAt, transactionAttempt.attemptStatus, transactionAttempt.errorCode,
    );
    if (transactionAttempt.forecast) {
      const forecastId = recordPreparedShortCalibrationForecastTransaction({
        ...transactionAttempt.forecast,
        evaluation_snapshot_id: Number(info.lastInsertRowid),
        snapshot_hash: transactionAttempt.payload.hash,
      });
      if (!Number.isSafeInteger(forecastId) || forecastId <= 0) throw new Error("strict forecast insert was not confirmed");
    }

    const checkpoint = db.prepare(`UPDATE short_observation_runs
      SET next_sequence = ?, next_scheduled_at = COALESCE(?, next_scheduled_at), updated_at = ?
      WHERE run_id = ? AND market_id = ? AND duration_type = ? AND asset = ?
        AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ?
        AND status IN ('scheduled', 'observing') AND next_sequence = ?`).run(
      transactionAttempt.sequence + 1, transactionAttempt.nextScheduledAt, transactionAttempt.now, transactionAttempt.runId, transactionAttempt.marketId,
      transactionAttempt.durationType, transactionAttempt.asset, transactionAttempt.owner, transactionAttempt.token, transactionAttempt.now, transactionAttempt.sequence,
    );
    if (checkpoint.changes !== 1) throw new Error("collector checkpoint was fenced");
    return Number(info.lastInsertRowid);
  })();
}

export function appendShortEvaluationSnapshotAttempt(input = {}) {
  try {
    return appendObservationAttemptTransaction(prepareShortEvaluationSnapshotAttempt(input));
  } catch (error) { console.error("[Storage] appendShortEvaluationSnapshotAttempt error:", error.message); return null; }
}

export function appendStrictShortObservationAttempt(input = {}) {
  try {
    if (!Array.isArray(input.evidence) || input.evidence.length === 0) throw new Error("strict collector attempt evidence is required");
    const attempt = prepareShortEvaluationSnapshotAttempt(input);
    const evidence = input.evidence.map((item) => prepareShortMarketEvidence(item));
    const forecastInput = input.forecast ?? input.preparedForecast;
    const forecast = forecastInput == null
      ? null
      : prepareShortCalibrationForecast(forecastInput, { allowMissingEvaluationSnapshot: true });
    return appendObservationAttemptTransaction({ ...attempt, forecast }, evidence);
  } catch (error) { console.error("[Storage] appendStrictShortObservationAttempt error:", error.message); return null; }
}
export const appendCollectorAttempt = appendShortEvaluationSnapshotAttempt;

export function getShortEvaluationSnapshotAttempts({ runId = null, sequence = null, limit = 100 } = {}) {
  try { const conditions = ["run_id IS NOT NULL"]; const params = []; if (runId != null) { conditions.push("run_id = ?"); params.push(String(runId)); } if (sequence != null) { conditions.push("sequence = ?"); params.push(Number(sequence)); } params.push(Math.max(0, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 100))); const rows = db.prepare(`SELECT id, market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash, run_id, sequence, collection_mode, scheduled_at, started_at, finished_at, attempt_status, error_code FROM short_evaluation_snapshots WHERE ${conditions.join(" AND ")} ORDER BY sequence, id LIMIT ?`).all(...params); return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })); } catch { return []; }
}
export const getCollectorAttempts = getShortEvaluationSnapshotAttempts;

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
