import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  SHORT_OBSERVE_CRYPTO_FINGERPRINT,
  parseBtc15mGammaEvent,
} from "../src/short-observe-contract.js";
import * as storage from "../src/storage.js";
import {
  appendShortEvaluationSnapshotAttempt,
  appendShortMarketEvidence,
  appendStrictShortObservationAttempt,
  auditPayloadHash,
  canonicalAuditPayload,
  claimShortObservationRun,
  databasePath,
  enrollShortObservationRun,
  getShortEvaluationSnapshotAttempts,
  getShortObservationRun,
  queryShortMarketEvidence,
  registerStrictShortMarket,
  terminalizeShortObservationRun,
} from "../src/storage.js";

function run() { const id = randomUUID(); return { runId: `run-${id}`, enrollmentKey: `enroll-${id}`, marketId: `market-${id}`, marketQuestion: "BTC 15m observe-only", asset: "BTC", durationType: "15m", config: { b: 2, a: 1 }, nextScheduledAt: "2026-08-24T00:15:00.000Z", createdAt: "2026-08-24T00:00:00.000Z" }; }

const STRICT_START = "2026-09-01T12:00:00.000Z";
const STRICT_END = "2026-09-01T12:15:00.000Z";
const STRICT_CREATED = "2026-09-01T11:59:00.000Z";
const RAW_HASH = "a".repeat(64);

function strictIdentity() {
  const nonce = randomUUID().replaceAll("-", "");
  return parseBtc15mGammaEvent({
    id: `event-${nonce}`,
    startTime: STRICT_START,
    series: [{ id: "10192" }],
    cryptoFingerprint: structuredClone(SHORT_OBSERVE_CRYPTO_FINGERPRINT),
    markets: [{
      id: `market-${nonce}`,
      conditionId: `condition-${nonce}`,
      eventStartTime: STRICT_START,
      endDate: STRICT_END,
      outcomes: ["Up", "Down"],
      clobTokenIds: [`token-up-${nonce}`, `token-down-${nonce}`],
    }],
  })[0];
}

function registerIdentity(identity) {
  const nonce = randomUUID().replaceAll("-", "");
  const discoveryPayload = { market: { id: identity.marketId }, question: "BTC Up or Down - strict observation" };
  return registerStrictShortMarket({
    identity,
    discoveryPayload,
    discoveryPayloadHash: auditPayloadHash(canonicalAuditPayload(discoveryPayload)),
    fingerprintHash: auditPayloadHash(canonicalAuditPayload(identity.cryptoFingerprint)),
    parserVersion: "strict-identity-parser-v1",
    createdAt: STRICT_CREATED,
    evidenceMetadata: {
      candidateKey: `discovery-candidate-${nonce}`,
      idempotencyKey: `discovery-${nonce}`,
      source: "GAMMA",
      status: "OK",
      sourceTimestampMs: identity.startMs,
      effectiveTimestampMs: identity.startMs,
      receivedTimestampMs: identity.startMs + 100,
      evaluatorVersion: "strict-discovery-v1",
      rawPayloadHash: RAW_HASH,
    },
  });
}

function strictRun(identity) {
  const nonce = randomUUID().replaceAll("-", "");
  return {
    runId: `strict-run-${nonce}`,
    enrollmentKey: `strict-enroll-${nonce}`,
    marketId: identity.marketId,
    marketQuestion: "BTC Up or Down - strict observation",
    asset: identity.asset,
    durationType: identity.durationType,
    config: { marketId: identity.marketId, mode: "strict" },
    nextScheduledAt: STRICT_START,
    createdAt: STRICT_CREATED,
  };
}

function strictEvidence(identity, label, overrides = {}) {
  return {
    candidateKey: `candidate-${label}`,
    marketId: identity.marketId,
    kind: "BOUNDARY_TWAP",
    source: "RTDS",
    status: "OK",
    sourceTimestampMs: identity.startMs,
    effectiveTimestampMs: identity.startMs,
    receivedTimestampMs: identity.startMs + 100,
    decimalValueText: "112345.67890123456789012300",
    outcome: null,
    reasonCode: null,
    parserVersion: "strict-evidence-parser-v1",
    evaluatorVersion: "strict-evidence-evaluator-v1",
    payload: { source: "rtds", value: "112345.67890123456789012300" },
    rawPayloadHash: RAW_HASH,
    idempotencyKey: `evidence-${label}`,
    createdAt: "2026-09-01T12:00:00.100Z",
    ...overrides,
  };
}

function setupStrictRun() {
  const identity = strictIdentity();
  assert.ok(registerIdentity(identity));
  const input = strictRun(identity);
  assert.ok(enrollShortObservationRun(input));
  assert.ok(claimShortObservationRun({
    runId: input.runId,
    leaseOwner: "strict-worker",
    leaseToken: "strict-token",
    leaseExpiresAt: "2026-09-01T12:20:00.000Z",
    now: "2026-09-01T11:59:30.000Z",
  }));
  return { identity, input };
}

function strictAttempt(input, evidence, overrides = {}) {
  return {
    ...input,
    sequence: 0,
    capturedAt: "2026-09-01T12:00:00.100Z",
    auditPayload: { marketId: input.marketId, observation: "strict" },
    leaseOwner: "strict-worker",
    leaseToken: "strict-token",
    now: "2026-09-01T12:00:00.100Z",
    nextScheduledAt: "2026-09-01T12:05:00.000Z",
    evidence: [evidence],
    ...overrides,
  };
}

function withoutStorageError(call) {
  const original = console.error;
  console.error = () => {};
  try {
    return call();
  } finally {
    console.error = original;
  }
}

test("standalone checkpoint API is not exposed", () => {
  assert.equal("checkpointShortObservationRun" in storage, false);
});

test("enrollment is idempotent and canonical identity guarded", () => {
  const input = run(); const first = enrollShortObservationRun(input); const repeated = enrollShortObservationRun({ ...input, runId: `other-${input.runId}` });
  assert.equal(first.run_id, input.runId); assert.equal(repeated.run_id, input.runId); assert.equal(first.config_json, '{"a":1,"b":2}');
  assert.equal(enrollShortObservationRun({ ...run(), marketId: input.marketId, asset: input.asset, durationType: input.durationType }), null);
});

test("collector transaction fences takeover and advances checkpoint atomically", () => {
  const input = run(); enrollShortObservationRun(input);
  claimShortObservationRun({ runId: input.runId, leaseOwner: "a", leaseToken: "a-token", leaseExpiresAt: "2026-08-24T00:20:00.000Z", now: "2026-08-24T00:10:00.000Z" });
  claimShortObservationRun({ runId: input.runId, leaseOwner: "b", leaseToken: "b-token", leaseExpiresAt: "2026-08-24T00:30:00.000Z", now: "2026-08-24T00:21:00.000Z" });
  const base = { ...input, sequence: 0, capturedAt: "2026-08-24T00:21:01.000Z", auditPayload: { ok: true }, now: "2026-08-24T00:21:01.000Z" };
  assert.equal(appendShortEvaluationSnapshotAttempt({ ...base, leaseOwner: "a", leaseToken: "a-token" }), null);
  assert.equal(getShortEvaluationSnapshotAttempts({ runId: input.runId }).length, 0);
  assert.ok(appendShortEvaluationSnapshotAttempt({ ...base, leaseOwner: "b", leaseToken: "b-token", nextScheduledAt: "2026-08-24T00:30:00.000Z" }) > 0);
  assert.equal(getShortObservationRun(input.runId).next_sequence, 1);
});

test("terminal transitions are legal-status and lease fenced", () => {
  const input = run(); enrollShortObservationRun(input); claimShortObservationRun({ runId: input.runId, leaseOwner: "worker", leaseToken: "token", leaseExpiresAt: "2026-08-24T01:00:00.000Z", now: "2026-08-24T00:10:00.000Z" });
  assert.equal(terminalizeShortObservationRun({ ...input, status: "completed", leaseOwner: "stale", leaseToken: "bad", now: "2026-08-24T00:11:00.000Z" }), null);
  const terminal = terminalizeShortObservationRun({ runId: input.runId, status: "completed", leaseOwner: "worker", leaseToken: "token", terminalAt: "2026-08-24T00:12:00.000Z", now: "2026-08-24T00:12:00.000Z" });
  assert.equal(terminal.status, "completed"); assert.equal(terminal.lease_token, null); assert.equal(terminal.terminal_at, "2026-08-24T00:12:00.000Z");
  assert.equal(terminalizeShortObservationRun({ runId: input.runId, status: "missed", leaseOwner: "worker", leaseToken: "token" }), null);
});

test("sequence mismatch leaves collector row and checkpoint unchanged", () => {
  const input = run(); enrollShortObservationRun(input); claimShortObservationRun({ runId: input.runId, leaseOwner: "worker", leaseToken: "token", leaseExpiresAt: "2026-08-24T01:00:00.000Z", now: "2026-08-24T00:10:00.000Z" });
  assert.equal(appendShortEvaluationSnapshotAttempt({ ...input, sequence: 1, capturedAt: "2026-08-24T00:15:00.000Z", auditPayload: { rejected: true }, leaseOwner: "worker", leaseToken: "token", now: "2026-08-24T00:15:00.000Z" }), null);
  assert.equal(getShortEvaluationSnapshotAttempts({ runId: input.runId }).length, 0); assert.equal(getShortObservationRun(input.runId).next_sequence, 0);
});

test("strict observation attempt atomically stores evidence, snapshot, and checkpoint", () => {
  const { identity, input } = setupStrictRun();
  const label = randomUUID().replaceAll("-", "");
  const evidence = strictEvidence(identity, label);
  const snapshotId = appendStrictShortObservationAttempt(strictAttempt(input, evidence));
  assert.ok(snapshotId > 0);

  const snapshots = getShortEvaluationSnapshotAttempts({ runId: input.runId });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].id, snapshotId);
  assert.equal(snapshots[0].sequence, 0);
  assert.deepEqual(snapshots[0].payload, { marketId: input.marketId, observation: "strict" });
  assert.equal(snapshots[0].audit_payload_hash, auditPayloadHash(canonicalAuditPayload(snapshots[0].payload)));
  const storedEvidence = queryShortMarketEvidence({ candidateKey: evidence.candidateKey, kind: evidence.kind });
  assert.equal(storedEvidence.length, 1);
  assert.equal(storedEvidence[0].idempotency_key, evidence.idempotencyKey);
  assert.equal(storedEvidence[0].decimal_value_text, evidence.decimalValueText);
  const checkpoint = getShortObservationRun(input.runId);
  assert.equal(checkpoint.next_sequence, 1);
  assert.equal(checkpoint.next_scheduled_at, "2026-09-01T12:05:00.000Z");
});

test("strict observation attempt rolls back all writes for stale lease or sequence", () => {
  const { identity, input } = setupStrictRun();
  const staleEvidence = strictEvidence(identity, randomUUID().replaceAll("-", ""));
  const sequenceEvidence = strictEvidence(identity, randomUUID().replaceAll("-", ""));
  assert.equal(withoutStorageError(() => appendStrictShortObservationAttempt(strictAttempt(input, staleEvidence, {
    leaseOwner: "stale-worker",
    leaseToken: "stale-token",
  }))), null);
  assert.equal(withoutStorageError(() => appendStrictShortObservationAttempt(strictAttempt(input, sequenceEvidence, {
    sequence: 1,
  }))), null);

  assert.equal(queryShortMarketEvidence({ candidateKey: staleEvidence.candidateKey }).length, 0);
  assert.equal(queryShortMarketEvidence({ candidateKey: sequenceEvidence.candidateKey }).length, 0);
  assert.equal(getShortEvaluationSnapshotAttempts({ runId: input.runId }).length, 0);
  assert.equal(getShortObservationRun(input.runId).next_sequence, 0);
});

test("strict observation evidence conflict rolls back snapshot and checkpoint while exact evidence repeat succeeds", () => {
  const conflictSetup = setupStrictRun();
  const conflictEvidence = strictEvidence(conflictSetup.identity, randomUUID().replaceAll("-", ""), {
    payload: { accepted: true },
  });
  assert.ok(appendShortMarketEvidence(conflictEvidence));
  const conflictingAttemptEvidence = { ...conflictEvidence, payload: { accepted: false } };
  assert.equal(withoutStorageError(() => appendStrictShortObservationAttempt(
    strictAttempt(conflictSetup.input, conflictingAttemptEvidence),
  )), null);
  const preserved = queryShortMarketEvidence({ candidateKey: conflictEvidence.candidateKey });
  assert.equal(preserved.length, 1);
  assert.deepEqual(preserved[0].payload, { accepted: true });
  assert.equal(getShortEvaluationSnapshotAttempts({ runId: conflictSetup.input.runId }).length, 0);
  assert.equal(getShortObservationRun(conflictSetup.input.runId).next_sequence, 0);

  const repeatSetup = setupStrictRun();
  const repeatEvidence = strictEvidence(repeatSetup.identity, randomUUID().replaceAll("-", ""));
  const existing = appendShortMarketEvidence(repeatEvidence);
  assert.ok(existing);
  assert.ok(appendStrictShortObservationAttempt(strictAttempt(repeatSetup.input, repeatEvidence)) > 0);
  const repeated = queryShortMarketEvidence({ candidateKey: repeatEvidence.candidateKey });
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, existing.id);
  assert.equal(getShortObservationRun(repeatSetup.input.runId).next_sequence, 1);
});

test("strict observation snapshot insert failure rolls back newly inserted evidence", () => {
  const { identity, input } = setupStrictRun();
  const evidence = strictEvidence(identity, randomUUID().replaceAll("-", ""));
  const baselinePayload = canonicalAuditPayload({ baseline: true });
  const direct = new Database(databasePath);
  try {
    direct.prepare(`INSERT INTO short_evaluation_snapshots
      (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version,
       model_version, payload, audit_payload_hash, run_id, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.marketId,
      input.marketQuestion,
      input.durationType,
      input.asset,
      "2026-09-01T12:00:00.000Z",
      "2026-09-01T12:00:00.000Z",
      "test-contract-v1",
      "test-model-v1",
      baselinePayload,
      auditPayloadHash(baselinePayload),
      input.runId,
      0,
    );
  } finally {
    direct.close();
  }

  assert.equal(withoutStorageError(() => appendStrictShortObservationAttempt(strictAttempt(input, evidence))), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: evidence.candidateKey }).length, 0);
  assert.equal(getShortEvaluationSnapshotAttempts({ runId: input.runId }).length, 1);
  assert.equal(getShortObservationRun(input.runId).next_sequence, 0);
});

test("strict observation checkpoint failure rolls back evidence and snapshot", () => {
  const { identity, input } = setupStrictRun();
  const evidence = strictEvidence(identity, randomUUID().replaceAll("-", ""));
  const triggerName = `trg_test_checkpoint_${randomUUID().replaceAll("-", "")}`;
  const escapedRunId = input.runId.replaceAll("'", "''");
  const direct = new Database(databasePath);
  try {
    direct.exec(`CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF next_sequence ON short_observation_runs
      WHEN OLD.run_id = '${escapedRunId}'
      BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END;`);
    assert.equal(withoutStorageError(() => appendStrictShortObservationAttempt(strictAttempt(input, evidence))), null);
  } finally {
    direct.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
    direct.close();
  }

  assert.equal(queryShortMarketEvidence({ candidateKey: evidence.candidateKey }).length, 0);
  assert.equal(getShortEvaluationSnapshotAttempts({ runId: input.runId }).length, 0);
  assert.equal(getShortObservationRun(input.runId).next_sequence, 0);
});
