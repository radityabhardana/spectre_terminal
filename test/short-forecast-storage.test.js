import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";

import { SHORT_OBSERVE_CRYPTO_FINGERPRINT, parseBtc15mGammaEvent } from "../src/short-observe-contract.js";
import { STRICT_OBSERVE_CONTRACT_VERSION, STRICT_OBSERVE_MODEL_VERSION } from "../src/short-observe-audit.js";
import {
  appendShortEvaluationSnapshot,
  appendStrictShortObservationAttempt,
  appendShortMarketEvidence,
  auditPayloadHash,
  canonicalAuditPayload,
  databasePath,
  getShortCalibrationForecasts,
  getShortForecastCalibrationSummary,
  claimShortObservationRun,
  enrollShortObservationRun,
  recordShortCalibrationForecast,
  registerStrictShortMarket,
} from "../src/storage.js";

const HASH = "a".repeat(64);
const unique = (label) => `${label}-${randomUUID().replaceAll("-", "")}`;

function market(label, start = "2028-01-01T12:00:00.000Z") {
  const nonce = unique(label);
  return parseBtc15mGammaEvent({
    id: `event-${nonce}`,
    startTime: start,
    series: [{ id: "10192" }],
    cryptoFingerprint: structuredClone(SHORT_OBSERVE_CRYPTO_FINGERPRINT),
    markets: [{
      id: `market-${nonce}`,
      conditionId: `condition-${nonce}`,
      eventStartTime: start,
      endDate: new Date(Date.parse(start) + 900000).toISOString(),
      outcomes: ["Up", "Down"],
      clobTokenIds: [`up-${nonce}`, `down-${nonce}`],
    }],
  })[0];
}

function register(marketIdentity) {
  const discoveryPayload = { marketId: marketIdentity.marketId, source: "forecast-test" };
  const fingerprintJson = canonicalAuditPayload(marketIdentity.cryptoFingerprint);
  const discoveryJson = canonicalAuditPayload(discoveryPayload);
  assert.ok(registerStrictShortMarket({
    identity: marketIdentity,
    discoveryPayload,
    discoveryPayloadHash: auditPayloadHash(discoveryJson),
    fingerprintHash: auditPayloadHash(fingerprintJson),
    parserVersion: "forecast-test-parser",
    createdAt: "2028-01-01T11:59:00.000Z",
    evidenceMetadata: {
      candidateKey: unique("discovery"),
      idempotencyKey: unique("discovery-key"),
      source: "GAMMA",
      status: "OK",
      sourceTimestampMs: marketIdentity.startMs,
      effectiveTimestampMs: marketIdentity.startMs,
      receivedTimestampMs: marketIdentity.startMs + 10,
      evaluatorVersion: "forecast-test-evaluator",
      rawPayloadHash: HASH,
    },
  }));
}

function strictForecastParts(marketIdentity, label, probability, opening, modelVersion = "calibration-model-v1") {
  const capturedTimestampMs = marketIdentity.startMs + 1000;
  const rawClosedCandles = Array.from({ length: 35 }, (_, index) => ({
    close: 100 + index, high: 101 + index, low: 99 + index, open: 100 + index, time: marketIdentity.startMs - (35 - index) * 900000,
  }));
  const rawFrame = { symbol: "btc/usd", timestamp: capturedTimestampMs + 100, value: "101" };
  const discoveryPayload = { marketId: marketIdentity.marketId, source: "forecast-test" };
  const features = {
    candles: { intervalMs: 900000, payloadSha256: auditPayloadHash(canonicalAuditPayload(rawClosedCandles)), rawCount: 35, uniqueCount: 35 },
    cadence: { duplicateCount: 0, gapCount: 0, inflationFactor: 1, newestCloseAgeMs: 0, usable: true },
    current: { rawFrameHash: auditPayloadHash(canonicalAuditPayload(rawFrame)), timestampMs: marketIdentity.startMs + 1100, usdPriceText: "101" },
    featureContractVersion: "features-v1",
    modelAsOfMs: capturedTimestampMs,
    modelVersion,
    opening: { evidenceHash: opening.canonical_hash, evidenceId: opening.id, usdPriceText: "100" },
    registry: {
      discoveryPayloadHash: auditPayloadHash(canonicalAuditPayload(discoveryPayload)),
      fingerprintHash: auditPayloadHash(canonicalAuditPayload(marketIdentity.cryptoFingerprint)),
    },
    remainingMs: 899000,
    run_id: `test-run-${label}`,
    sequence: 0,
    volatility: { inflationFactor: 1, intervalVolatilityText: "1" },
  };
  const featuresJson = canonicalAuditPayload(features);
  const featuresHash = auditPayloadHash(featuresJson);
  const decision = { downProbabilityPpm: 1_000_000 - probability, featureHash: featuresHash, modelVersion, upProbabilityPpm: probability };
  const decisionJson = canonicalAuditPayload(decision);
  const audit = {
    candles: features.candles,
    current: { rawFrame, ...features.current },
    decisionHash: auditPayloadHash(decisionJson),
    featuresHash,
    opening: features.opening,
    cadence: features.cadence,
    volatility: features.volatility,
  };
  return { features, featuresJson, featuresHash, decisionJson, decisionHash: auditPayloadHash(decisionJson), audit: { ...audit, rawClosedCandles } };
}

function snapshot(marketIdentity, label, parts) {
  const payload = { forecast: parts.audit, label, marketId: marketIdentity.marketId, score: 7 };
  const capturedAt = new Date(marketIdentity.startMs + 1000).toISOString();
  const createdAt = new Date(marketIdentity.startMs + 1001).toISOString();
  const direct = new Database(databasePath);
  try {
    const info = direct.prepare(`INSERT INTO short_evaluation_snapshots
      (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version,
       payload, audit_payload_hash, run_id, sequence, collection_mode, scheduled_at, started_at, finished_at, attempt_status, error_code)
      VALUES (?, ?, '15m', 'BTC', ?, ?, ?, ?, ?, ?, ?, 0, 'observe_only', ?, ?, ?, 'completed', NULL)`).run(
      marketIdentity.marketId, "BTC up or down?", capturedAt, createdAt,
      STRICT_OBSERVE_CONTRACT_VERSION, STRICT_OBSERVE_MODEL_VERSION,
      canonicalAuditPayload(payload), auditPayloadHash(canonicalAuditPayload(payload)), parts.features.run_id,
      new Date(marketIdentity.startMs).toISOString(), new Date(marketIdentity.startMs).toISOString(), capturedAt,
    );
    return { id: Number(info.lastInsertRowid), hash: auditPayloadHash(canonicalAuditPayload(payload)) };
  } finally {
    direct.close();
  }
}

function openingEvidence(marketIdentity, label) {
  const payload = { boundary: marketIdentity.startMs, label, marketId: marketIdentity.marketId, value: "100" };
  return appendShortMarketEvidence({
    candidateKey: `strict-observe:${marketIdentity.marketId}:test-run-${label}:0`,
    marketId: marketIdentity.marketId,
    kind: "BOUNDARY_TWAP",
    source: "RTDS",
    status: "OK",
    sourceTimestampMs: marketIdentity.startMs,
    effectiveTimestampMs: marketIdentity.startMs,
    receivedTimestampMs: marketIdentity.startMs + 20,
    decimalValueText: "100",
    parserVersion: "forecast-test-parser",
    evaluatorVersion: "forecast-test-evaluator",
    payload,
    rawPayloadHash: HASH,
    idempotencyKey: unique(`opening-key-${label}`),
    createdAt: new Date(marketIdentity.startMs + 20).toISOString(),
  });
}

function forecastInput(marketIdentity, snapshotRecord, label, probability, opening, parts) {
  return {
    marketId: marketIdentity.marketId,
    evaluationSnapshotId: snapshotRecord.id,
    snapshotHash: snapshotRecord.hash,
    openingEvidenceHash: opening.canonical_hash,
    openingEvidenceKind: opening.kind,
    capturedTimestampMs: marketIdentity.startMs + 1000,
    oracleTimestampMs: marketIdentity.startMs + 1100,
    remainingMs: 899000,
    probabilityUpPpm: probability,
    modelVersion: "calibration-model-v1",
    featureContractVersion: "features-v1",
    featuresJson: parts.featuresJson,
    featuresHash: parts.featuresHash,
    decisionJson: parts.decisionJson,
    decisionHash: parts.decisionHash,
    idempotencyKey: `forecast-${label}`,
    createdAt: new Date(marketIdentity.startMs + 1200).toISOString(),
  };
}

function quiet(call) {
  const original = console.error;
  console.error = () => {};
  try { return call(); } finally { console.error = original; }
}

function validFixture(labelPrefix = "regression", probability = 420000) {
  const identity = market(labelPrefix);
  register(identity);
  const label = unique(labelPrefix);
  const opening = openingEvidence(identity, label);
  const parts = strictForecastParts(identity, label, probability, opening);
  const snap = snapshot(identity, unique(`${labelPrefix}-snapshot`), parts);
  return { identity, label, opening, parts, snap, input: forecastInput(identity, snap, label, probability, opening, parts) };
}

function decisionVariant(input, update) {
  const decision = update(JSON.parse(input.decisionJson));
  const decisionJson = canonicalAuditPayload(decision);
  return { ...input, decisionJson, decisionHash: auditPayloadHash(decisionJson), idempotencyKey: unique("decision-variant") };
}

function evidenceInput(identity, label, overrides = {}) {
  return {
    candidateKey: `strict-observe:${identity.marketId}:test-run-${label}:0`,
    marketId: identity.marketId,
    kind: "BOUNDARY_TWAP",
    source: "RTDS",
    status: "OK",
    sourceTimestampMs: identity.startMs,
    effectiveTimestampMs: identity.startMs,
    receivedTimestampMs: identity.startMs + 20,
    decimalValueText: "100",
    parserVersion: "forecast-test-parser",
    evaluatorVersion: "forecast-test-evaluator",
    payload: { boundary: identity.startMs, label, marketId: identity.marketId, value: "100" },
    rawPayloadHash: HASH,
    idempotencyKey: unique(`opening-key-${label}`),
    createdAt: new Date(identity.startMs + 20).toISOString(),
    ...overrides,
  };
}

test("short calibration forecasts insert, replay idempotently, and fail closed on conflicts", () => {
  const identity = market("happy");
  register(identity);
  const label = unique("forecast");
  const opening = openingEvidence(identity, label);
  const parts = strictForecastParts(identity, label, 420000, opening);
  const snap = snapshot(identity, unique("snapshot"), parts);
  const input = forecastInput(identity, snap, label, 420000, opening, parts);
  const id = recordShortCalibrationForecast(input);
  assert.ok(id);
  assert.equal(recordShortCalibrationForecast(input), id);
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...input, featuresJson: '{"changed":true}' })), null);
  const rows = getShortCalibrationForecasts({ marketId: identity.marketId, modelVersion: "calibration-model-v1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].opening_evidence_id, opening.id);
  assert.equal(rows[0].features_json, input.featuresJson);
});

test("short calibration forecast validation and immutable foreign keys fail closed", () => {
  const identity = market("validation");
  register(identity);
  const label = unique("validation-forecast");
  const opening = openingEvidence(identity, label);
  const parts = strictForecastParts(identity, label, 500000, opening);
  const snap = snapshot(identity, unique("snapshot"), parts);
  const input = forecastInput(identity, snap, label, 500000, opening, parts);
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...input, marketId: unique("unknown-market") })), null);
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...input, evaluationSnapshotId: 999999999 })), null);
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...input, probabilityUpPpm: -1 })), null);
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...input, probabilityUpPpm: 1000001 })), null);
  const id = recordShortCalibrationForecast(input);
  const direct = new Database(databasePath);
  try {
    direct.pragma("foreign_keys = ON");
    assert.throws(() => direct.prepare("UPDATE short_calibration_forecasts SET remaining_ms = 1 WHERE id = ?").run(id), /append-only/);
    assert.throws(() => direct.prepare("DELETE FROM short_calibration_forecasts WHERE id = ?").run(id), /append-only/);
  } finally {
    direct.close();
  }
});

test("calibration summary counts forecasts and resolved outcomes with integer ppm math", () => {
  const resolved = market("summary-resolved", "2028-01-02T12:00:00.000Z");
  const unresolved = market("summary-unresolved", "2028-01-02T13:00:00.000Z");
  register(resolved);
  register(unresolved);
  for (const [identity, values] of [[resolved, [200000, 800000]], [unresolved, [900000]]]) {
    for (const [index, probability] of values.entries()) {
      const label = unique(`summary-${index}`);
      const opening = openingEvidence(identity, label);
      const parts = strictForecastParts(identity, label, probability, opening, "calibration-summary-v1");
      const snap = snapshot(identity, unique(`summary-snapshot-${index}`), parts);
      assert.ok(recordShortCalibrationForecast({
        ...forecastInput(identity, snap, label, probability, opening, parts),
        modelVersion: "calibration-summary-v1",
      }));
    }
  }
  assert.ok(appendShortMarketEvidence({
    candidateKey: unique("resolution"), marketId: resolved.marketId, kind: "RESOLUTION", source: "GAMMA",
    status: "RESOLVED", sourceTimestampMs: null, effectiveTimestampMs: resolved.endMs,
    receivedTimestampMs: resolved.endMs + 10, decimalValueText: null, outcome: "UP", reasonCode: null,
    parserVersion: "forecast-test-parser", evaluatorVersion: "forecast-test-evaluator",
    payload: { marketId: resolved.marketId, outcome: "UP" }, rawPayloadHash: null,
    idempotencyKey: unique("resolution-key"), createdAt: new Date(resolved.endMs + 10).toISOString(),
  }));

  assert.deepEqual(getShortForecastCalibrationSummary({ modelVersion: "calibration-summary-v1" }), {
    forecastCount: 3,
    distinctMarketCount: 2,
    resolvedCount: 2,
    meanProbabilityUpPpm: 633333,
    empiricalUpRatePpm: 1000000,
  });
});

test("malformed JSON is rejected", () => {
  const fixture = validFixture("malformed-json");
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...fixture.input, featuresJson: "{\"broken\":" })), null);
});

test("non-canonical unsorted-key features_json is rejected", () => {
  const fixture = validFixture("unsorted-features");
  const featuresJson = '{"z":1,"a":2}';
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...fixture.input, featuresJson, featuresHash: auditPayloadHash(featuresJson) })), null);
});

test("features_hash mismatch is rejected", () => {
  const fixture = validFixture("features-hash");
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...fixture.input, featuresHash: "b".repeat(64) })), null);
});

test("decision_hash mismatch is rejected", () => {
  const fixture = validFixture("decision-hash");
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...fixture.input, decisionHash: "b".repeat(64) })), null);
});

test("decision modelVersion mismatch is rejected", () => {
  const fixture = validFixture("decision-model");
  assert.equal(quiet(() => recordShortCalibrationForecast(decisionVariant(fixture.input, (decision) => ({ ...decision, modelVersion: "wrong-model" })))), null);
});

test("decision featureHash mismatch is rejected", () => {
  const fixture = validFixture("decision-feature-hash");
  assert.equal(quiet(() => recordShortCalibrationForecast(decisionVariant(fixture.input, (decision) => ({ ...decision, featureHash: "c".repeat(64) })))), null);
});

test("decision upProbabilityPpm mismatch is rejected", () => {
  const fixture = validFixture("decision-up", 420000);
  assert.equal(quiet(() => recordShortCalibrationForecast(decisionVariant(fixture.input, (decision) => ({ ...decision, upProbabilityPpm: 420001 })))), null);
});

test("decision probability complement mismatch is rejected", () => {
  const fixture = validFixture("decision-complement", 420000);
  assert.equal(quiet(() => recordShortCalibrationForecast(decisionVariant(fixture.input, (decision) => ({ ...decision, downProbabilityPpm: 1 })))), null);
});

test("null opening_evidence_id is rejected by the schema", () => {
  const fixture = validFixture("null-opening-id");
  const direct = new Database(databasePath);
  try {
    assert.throws(() => direct.prepare(`INSERT INTO short_calibration_forecasts
      (market_id, evaluation_snapshot_id, opening_evidence_id, captured_timestamp_ms, oracle_timestamp_ms, remaining_ms,
       probability_up_ppm, model_version, feature_contract_version, features_json, features_hash, decision_json, decision_hash,
       idempotency_key, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      fixture.input.marketId, fixture.input.evaluationSnapshotId, fixture.input.capturedTimestampMs,
      fixture.input.oracleTimestampMs, fixture.input.remainingMs, fixture.input.probabilityUpPpm,
      fixture.input.modelVersion, fixture.input.featureContractVersion, fixture.input.featuresJson, fixture.input.featuresHash,
      fixture.input.decisionJson, fixture.input.decisionHash, unique("null-opening"), fixture.input.createdAt,
    ), /NOT NULL/);
  } finally { direct.close(); }
});

test("wrong-market opening evidence is rejected", () => {
  const fixture = validFixture("wrong-market");
  const other = validFixture("wrong-market-source");
  const input = { ...fixture.input, openingEvidenceHash: other.opening.canonical_hash, idempotencyKey: unique("wrong-market") };
  assert.equal(quiet(() => recordShortCalibrationForecast(input)), null);
});

test("wrong-kind opening evidence is rejected", () => {
  const fixture = validFixture("wrong-kind");
  assert.equal(quiet(() => recordShortCalibrationForecast({ ...fixture.input, openingEvidenceKind: "ORDER_BOOK", idempotencyKey: unique("wrong-kind") })), null);
});

test("non-OK opening evidence is rejected", () => {
  const identity = market("non-ok-opening");
  register(identity);
  const label = unique("non-ok-opening");
  const opening = appendShortMarketEvidence(evidenceInput(identity, label, { status: "DATA_GAP" }));
  const parts = strictForecastParts(identity, label, 420000, opening);
  const snap = snapshot(identity, unique("non-ok-snapshot"), parts);
  assert.equal(quiet(() => recordShortCalibrationForecast(forecastInput(identity, snap, label, 420000, opening, parts))), null);
});

test("wrong-start opening evidence is rejected", () => {
  const identity = market("wrong-start-opening");
  register(identity);
  const label = unique("wrong-start-opening");
  const opening = appendShortMarketEvidence(evidenceInput(identity, label, { effectiveTimestampMs: identity.startMs + 1 }));
  const parts = strictForecastParts(identity, label, 420000, opening);
  const snap = snapshot(identity, unique("wrong-start-snapshot"), parts);
  assert.equal(quiet(() => recordShortCalibrationForecast(forecastInput(identity, snap, label, 420000, opening, parts))), null);
});

test("unknown-source opening evidence is rejected", () => {
  const identity = market("unknown-source-opening");
  register(identity);
  const label = unique("unknown-source-opening");
  const opening = appendShortMarketEvidence(evidenceInput(identity, label, { source: "CHAINLINK" }));
  const parts = strictForecastParts(identity, label, 420000, opening);
  const snap = snapshot(identity, unique("unknown-source-snapshot"), parts);
  assert.equal(quiet(() => recordShortCalibrationForecast(forecastInput(identity, snap, label, 420000, opening, parts))), null);
});

test("wrong-run-sequence opening evidence is rejected", () => {
  const identity = market("wrong-run-sequence");
  register(identity);
  const label = unique("wrong-run-sequence");
  const opening = appendShortMarketEvidence(evidenceInput(identity, label, {
    candidateKey: `strict-observe:${identity.marketId}:other-run:9`,
  }));
  const parts = strictForecastParts(identity, label, 420000, opening);
  const snap = snapshot(identity, unique("wrong-sequence-snapshot"), parts);
  assert.equal(quiet(() => recordShortCalibrationForecast(forecastInput(identity, snap, label, 420000, opening, parts))), null);
});

test("manual or incomplete snapshot is rejected", () => {
  const fixture = validFixture("incomplete-snapshot");
  const manual = appendShortEvaluationSnapshot({
    marketId: fixture.identity.marketId, marketQuestion: "BTC up or down?", durationType: "15m", asset: "BTC",
    capturedAt: new Date(fixture.identity.startMs + 1000).toISOString(), auditPayload: { manual: true },
  });
  assert.equal(quiet(() => recordShortCalibrationForecast({
    ...fixture.input, evaluationSnapshotId: manual, snapshotHash: auditPayloadHash(canonicalAuditPayload({ manual: true })),
    idempotencyKey: unique("manual-snapshot"),
  })), null);
});

test("recursive_triggers OFF INSERT OR REPLACE is blocked", () => {
  const fixture = validFixture("replace-guard");
  const id = recordShortCalibrationForecast(fixture.input);
  const direct = new Database(databasePath);
  try {
    direct.pragma("recursive_triggers = OFF");
    assert.throws(() => direct.prepare(`INSERT OR REPLACE INTO short_calibration_forecasts
      SELECT id, market_id, evaluation_snapshot_id, opening_evidence_id, captured_timestamp_ms, oracle_timestamp_ms,
      remaining_ms, probability_up_ppm + 1, model_version, feature_contract_version, features_json, features_hash,
      decision_json, decision_hash, idempotency_key, created_at FROM short_calibration_forecasts WHERE id = ?`).run(id), /reinsert|append-only/);
  } finally { direct.close(); }
});

test("real-database atomicity rolls back evidence, snapshot, and run checkpoint after forecast failure", () => {
  const identity = market("atomic-forecast-failure");
  register(identity);
  const label = unique("atomic-forecast-failure");
  const runId = `test-run-${label}`;
  const scheduledAt = new Date(identity.startMs).toISOString();
  assert.ok(enrollShortObservationRun({
    runId, enrollmentKey: unique("atomic-enrollment"), marketId: identity.marketId, marketQuestion: "BTC up or down?",
    asset: "BTC", durationType: "15m", config: { snapshotIntervalMs: 900000 }, nextSequence: 0, nextScheduledAt: scheduledAt,
  }));
  const lease = claimShortObservationRun({ runId, leaseOwner: "atomic-test", leaseToken: "atomic-token", leaseExpiresAt: "2028-01-01T12:10:00.000Z", now: scheduledAt });
  assert.ok(lease);
  const opening = evidenceInput(identity, label);
  const openingRef = { ...opening, canonical_hash: auditPayloadHash(canonicalAuditPayload(opening.payload)), id: null };
  const parts = strictForecastParts(identity, label, 420000, openingRef);
  const book = { ...opening, candidateKey: unique("atomic-book"), kind: "ORDER_BOOK", source: "POLYMARKET_CLOB", decimalValueText: null, outcome: "UP", payload: { marketId: identity.marketId, side: "UP" }, idempotencyKey: unique("atomic-book-key") };
  const result = quiet(() => appendStrictShortObservationAttempt({
    runId, sequence: 0, leaseOwner: "atomic-test", leaseToken: "atomic-token", now: scheduledAt,
    marketId: identity.marketId, marketQuestion: "BTC up or down?", durationType: "15m", asset: "BTC",
    capturedAt: new Date(identity.startMs + 1000).toISOString(), createdAt: new Date(identity.startMs + 1000).toISOString(),
    contractVersion: STRICT_OBSERVE_CONTRACT_VERSION, modelVersion: STRICT_OBSERVE_MODEL_VERSION,
    auditPayload: { forecast: { ...parts.audit, rawClosedCandles: [] } }, collectionMode: "observe_only", scheduledAt, startedAt: scheduledAt,
    finishedAt: new Date(identity.startMs + 1000).toISOString(), attemptStatus: "completed", evidence: [opening, book],
    forecast: forecastInput(identity, { id: null, hash: null }, label, 420000, openingRef, parts),
  }));
  assert.equal(result, null);
  const direct = new Database(databasePath);
  try {
    assert.equal(direct.prepare("SELECT COUNT(*) AS count FROM short_market_evidence WHERE market_id = ? AND candidate_key LIKE ?").get(identity.marketId, `strict-observe:${identity.marketId}%`).count, 0);
    assert.equal(direct.prepare("SELECT COUNT(*) AS count FROM short_evaluation_snapshots WHERE run_id = ?").get(runId).count, 0);
    assert.equal(direct.prepare("SELECT next_sequence FROM short_observation_runs WHERE run_id = ?").get(runId).next_sequence, 0);
  } finally { direct.close(); }
});
