import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";

import {
  SHORT_OBSERVE_CRYPTO_FINGERPRINT,
  parseBtc15mGammaEvent,
} from "../src/short-observe-contract.js";
import * as storage from "../src/storage.js";
import {
  appendShortMarketEvidence,
  auditPayloadHash,
  canonicalAuditPayload,
  databasePath,
  getStrictShortMarket,
  listStrictShortMarketsForObservation,
  listStrictShortMarketsPendingResolution,
  queryShortMarketEvidence,
  registerStrictShortMarket,
} from "../src/storage.js";

const CREATED_AT = "2026-08-25T12:00:01.000Z";
const RAW_HASH = "a".repeat(64);

function unique(label) {
  return `${label}-${randomUUID().replaceAll("-", "")}`;
}

function identity(overrides = {}) {
  const nonce = unique("strict-v4");
  const eventId = overrides.eventId ?? `event-${nonce}`;
  const marketId = overrides.marketId ?? `market-${nonce}`;
  const conditionId = overrides.conditionId ?? `condition-${nonce}`;
  const upToken = overrides.upToken ?? `token-up-${nonce}`;
  const downToken = overrides.downToken ?? `token-down-${nonce}`;
  const startTime = overrides.startTime ?? "2026-08-25T12:00:00.000Z";
  const endDate = overrides.endDate ?? "2026-08-25T12:15:00.000Z";
  return parseBtc15mGammaEvent({
    id: eventId,
    startTime,
    series: [{ id: "10192" }],
    cryptoFingerprint: structuredClone(SHORT_OBSERVE_CRYPTO_FINGERPRINT),
    markets: [{
      id: marketId,
      conditionId,
      eventStartTime: startTime,
      endDate,
      outcomes: ["Up", "Down"],
      clobTokenIds: [upToken, downToken],
    }],
  })[0];
}

function registrationInput(marketIdentity, label, overrides = {}) {
  const discoveryPayload = overrides.discoveryPayload ?? {
    market: { id: marketIdentity.marketId, conditionId: marketIdentity.conditionId },
    source: "gamma-keyset",
  };
  const fingerprintJson = canonicalAuditPayload(marketIdentity.cryptoFingerprint);
  const discoveryJson = canonicalAuditPayload(discoveryPayload);
  return {
    identity: marketIdentity,
    discoveryPayload,
    discoveryPayloadHash: auditPayloadHash(discoveryJson),
    fingerprintHash: auditPayloadHash(fingerprintJson),
    parserVersion: "strict-identity-parser-v1",
    createdAt: CREATED_AT,
    evidenceMetadata: {
      candidateKey: overrides.candidateKey ?? `candidate-${label}`,
      idempotencyKey: overrides.idempotencyKey ?? `discovery-${label}`,
      source: "GAMMA",
      status: "OK",
      sourceTimestampMs: marketIdentity.startMs,
      effectiveTimestampMs: marketIdentity.startMs,
      receivedTimestampMs: marketIdentity.startMs + 100,
      evaluatorVersion: "strict-discovery-evaluator-v1",
      rawPayloadHash: RAW_HASH,
      canonicalHash: auditPayloadHash(discoveryJson),
    },
  };
}

function evidenceInput(marketIdentity, label, overrides = {}) {
  return {
    candidateKey: `candidate-${label}`,
    marketId: marketIdentity?.marketId ?? null,
    kind: "BOUNDARY_TWAP",
    source: "RTDS",
    status: "OK",
    sourceTimestampMs: marketIdentity?.startMs ?? 1_787_659_200_000,
    effectiveTimestampMs: marketIdentity?.startMs ?? 1_787_659_200_000,
    receivedTimestampMs: (marketIdentity?.startMs ?? 1_787_659_200_000) + 100,
    decimalValueText: "112345.67890123456789012300",
    outcome: null,
    reasonCode: null,
    parserVersion: "strict-evidence-parser-v1",
    evaluatorVersion: "strict-evidence-evaluator-v1",
    payload: { source: { symbol: "btc/usd", topic: "twap" }, value: "112345.67890123456789012300" },
    rawPayloadHash: RAW_HASH,
    idempotencyKey: `evidence-${label}`,
    createdAt: CREATED_AT,
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

test("strict registration atomically stores registry, exactly two tokens, and canonical discovery evidence", () => {
  const marketIdentity = identity();
  const label = unique("atomic-registration");
  const input = registrationInput(marketIdentity, label, {
    discoveryPayload: { z: { second: 2, first: 1 }, a: "discovery" },
  });
  const registered = registerStrictShortMarket(input);
  assert.ok(registered);
  assert.equal(registered.marketId, marketIdentity.marketId);
  assert.equal(registered.registry.asset, "btc");
  assert.deepEqual(registered.tokenIds, marketIdentity.tokenIds);
  assert.equal(registered.tokens.length, 2);
  assert.deepEqual(new Set(registered.tokens.map((token) => token.outcome)), new Set(["UP", "DOWN"]));

  const discovery = queryShortMarketEvidence({ marketId: marketIdentity.marketId, kind: "DISCOVERY", status: "OK" });
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].candidate_key, input.evidenceMetadata.candidateKey);
  assert.equal(discovery[0].canonical_payload, '{"a":"discovery","z":{"first":1,"second":2}}');
  assert.equal(discovery[0].canonical_hash, auditPayloadHash(discovery[0].canonical_payload));
  assert.equal(registered.registry.discovery_payload_hash, discovery[0].canonical_hash);

  const repeated = registerStrictShortMarket({
    ...input,
    discoveryPayload: { a: "discovery", z: { first: 1, second: 2 } },
  });
  assert.ok(repeated);
  assert.equal(repeated.marketId, registered.marketId);
  assert.equal(queryShortMarketEvidence({ marketId: marketIdentity.marketId, kind: "DISCOVERY" }).length, 1);
  assert.deepEqual(getStrictShortMarket(marketIdentity.marketId).tokenIds, marketIdentity.tokenIds);
});

test("registration conflicts roll back registry, token, and discovery writes without mutating accepted identity", () => {
  const accepted = identity();
  const acceptedLabel = unique("accepted-registration");
  const acceptedInput = registrationInput(accepted, acceptedLabel);
  assert.ok(registerStrictShortMarket(acceptedInput));

  const identityConflict = identity({
    eventId: unique("conflicting-event"),
    marketId: accepted.marketId,
    conditionId: accepted.conditionId,
    upToken: accepted.tokenIds.UP,
    downToken: accepted.tokenIds.DOWN,
  });
  const identityConflictLabel = unique("identity-conflict");
  assert.equal(withoutStorageError(() => registerStrictShortMarket(registrationInput(identityConflict, identityConflictLabel))), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: `candidate-${identityConflictLabel}` }).length, 0);

  const conditionConflict = identity({ conditionId: accepted.conditionId });
  const conditionConflictLabel = unique("condition-conflict");
  assert.equal(withoutStorageError(() => registerStrictShortMarket(registrationInput(conditionConflict, conditionConflictLabel))), null);
  assert.equal(getStrictShortMarket(conditionConflict.marketId), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: `candidate-${conditionConflictLabel}` }).length, 0);

  const tokenConflict = identity({ upToken: accepted.tokenIds.UP });
  const tokenConflictLabel = unique("token-conflict");
  assert.equal(withoutStorageError(() => registerStrictShortMarket(registrationInput(tokenConflict, tokenConflictLabel))), null);
  assert.equal(getStrictShortMarket(tokenConflict.marketId), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: `candidate-${tokenConflictLabel}` }).length, 0);

  const evidenceConflictIdentity = identity();
  const evidenceConflictLabel = unique("registration-evidence-conflict");
  const evidenceKey = `discovery-${evidenceConflictLabel}`;
  assert.ok(appendShortMarketEvidence(evidenceInput(null, unique("preexisting-evidence"), {
    kind: "DISCOVERY",
    source: "OBSERVER",
    status: "QUARANTINED",
    decimalValueText: null,
    idempotencyKey: evidenceKey,
  })));
  assert.equal(withoutStorageError(() => registerStrictShortMarket(registrationInput(evidenceConflictIdentity, evidenceConflictLabel, { idempotencyKey: evidenceKey }))), null);
  assert.equal(getStrictShortMarket(evidenceConflictIdentity.marketId), null);
  assert.equal(queryShortMarketEvidence({ marketId: evidenceConflictIdentity.marketId }).length, 0);

  const acceptedAfter = getStrictShortMarket(accepted.marketId);
  assert.equal(acceptedAfter.eventId, accepted.eventId);
  assert.deepEqual(acceptedAfter.tokenIds, accepted.tokenIds);
  assert.equal(queryShortMarketEvidence({ marketId: accepted.marketId, kind: "DISCOVERY" }).length, 1);
});

test("evidence canonicalization and idempotency preserve exact decimal text across object key order", () => {
  const marketIdentity = identity();
  const registrationLabel = unique("evidence-market");
  assert.ok(registerStrictShortMarket(registrationInput(marketIdentity, registrationLabel)));
  const label = unique("canonical-evidence");
  const firstInput = evidenceInput(marketIdentity, label, {
    payload: { z: { b: 2, a: 1 }, a: "stable" },
  });
  firstInput.canonicalHash = auditPayloadHash(canonicalAuditPayload(firstInput.payload));
  const first = appendShortMarketEvidence(firstInput);
  assert.ok(first);
  assert.equal(first.decimal_value_text, "112345.67890123456789012300");
  assert.equal(first.canonical_payload, '{"a":"stable","z":{"a":1,"b":2}}');
  assert.equal(first.canonical_hash, auditPayloadHash(first.canonical_payload));

  const repeated = appendShortMarketEvidence({
    ...firstInput,
    payload: { a: "stable", z: { a: 1, b: 2 } },
    createdAt: "2026-08-25T12:00:02.000Z",
  });
  assert.ok(repeated);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.created_at, first.created_at);
  assert.equal(queryShortMarketEvidence({ marketId: marketIdentity.marketId, kind: "BOUNDARY_TWAP", status: "OK", limit: 1 }).length, 1);

  const conflict = withoutStorageError(() => appendShortMarketEvidence({ ...firstInput, payload: { a: "changed" }, canonicalHash: undefined }));
  assert.equal(conflict, null);
  const stored = queryShortMarketEvidence({ candidateKey: firstInput.candidateKey, kind: "BOUNDARY_TWAP" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, first.id);
  assert.equal(stored[0].decimal_value_text, "112345.67890123456789012300");
});

test("evidence rejects unknown FK and invalid enum, time, hash, decimal, outcome, version, or key", () => {
  const marketIdentity = identity();
  const registrationLabel = unique("validation-market");
  assert.ok(registerStrictShortMarket(registrationInput(marketIdentity, registrationLabel)));

  const invalidCases = [
    { marketId: unique("unknown-market") },
    { kind: "UNKNOWN_KIND" },
    { source: "UNKNOWN_SOURCE" },
    { status: "UNKNOWN_STATUS" },
    { sourceTimestampMs: 1_787_659_200 },
    { effectiveTimestampMs: 1_787_659_200_000.5 },
    { receivedTimestampMs: "1787659200100" },
    { rawPayloadHash: "A".repeat(64) },
    { rawPayloadHash: "abcd" },
    { canonicalHash: "b".repeat(64) },
    { decimalValueText: 112345.67 },
    { decimalValueText: "01.20" },
    { outcome: "SIDEWAYS" },
    { parserVersion: "" },
    { evaluatorVersion: " evaluator-v1" },
    { candidateKey: "   " },
    { idempotencyKey: "" },
    { createdAt: "not-an-iso-time" },
    { kind: "RESOLUTION", source: "GAMMA", status: "RESOLVED", outcome: null },
    { marketId: null, kind: "RESOLUTION", source: "GAMMA", status: "RESOLVED", outcome: "UP" },
    { kind: "RESOLUTION", source: "RTDS", status: "RESOLVED", outcome: "UP" },
    { kind: "BOUNDARY_TWAP", source: "GAMMA", status: "RESOLVED", outcome: "UP" },
    { kind: "RESOLUTION", source: "GAMMA", status: "OK", outcome: "UP" },
  ];
  for (const [index, mutation] of invalidCases.entries()) {
    const label = unique(`invalid-${index}`);
    const result = withoutStorageError(() => appendShortMarketEvidence(evidenceInput(marketIdentity, label, mutation)));
    assert.equal(result, null, `invalid case ${index} must fail closed`);
    assert.equal(queryShortMarketEvidence({ candidateKey: `candidate-${label}` }).length, 0);
  }
});

test("pending resolution read excludes only markets with strict RESOLUTION/RESOLVED evidence", () => {
  const pendingIdentity = identity();
  const resolvedIdentity = identity();
  const noEvidenceIdentity = identity();
  const legacyMalformedIdentity = identity();
  assert.ok(registerStrictShortMarket(registrationInput(pendingIdentity, unique("pending-registration"))));
  assert.ok(registerStrictShortMarket(registrationInput(resolvedIdentity, unique("resolved-registration"))));
  assert.ok(registerStrictShortMarket(registrationInput(noEvidenceIdentity, unique("no-resolution-registration"))));
  assert.ok(registerStrictShortMarket(registrationInput(legacyMalformedIdentity, unique("legacy-malformed-registration"))));

  assert.ok(appendShortMarketEvidence(evidenceInput(pendingIdentity, unique("pending-resolution"), {
    kind: "RESOLUTION",
    source: "GAMMA",
    status: "UNRESOLVED",
    decimalValueText: null,
  })));
  assert.ok(appendShortMarketEvidence(evidenceInput(resolvedIdentity, unique("strict-resolution"), {
    kind: "RESOLUTION",
    source: "GAMMA",
    status: "RESOLVED",
    decimalValueText: null,
    outcome: "UP",
  })));

  const direct = new Database(databasePath);
  const malformedIdempotencyKey = unique("legacy-malformed-resolved");
  const malformedValues = [
    unique("legacy-malformed-candidate"), legacyMalformedIdentity.marketId, "RESOLUTION", "RTDS", "RESOLVED",
    null, null, legacyMalformedIdentity.endMs + 100, null, null, null, "legacy-parser-v1", "legacy-evaluator-v1",
    '{"legacy":true}', null, "f".repeat(64), malformedIdempotencyKey, "2026-08-25T12:15:00.100Z",
  ];
  const directInsertSql = `INSERT INTO short_market_evidence
    (candidate_key, market_id, kind, source, status, source_timestamp_ms, effective_timestamp_ms,
     received_timestamp_ms, decimal_value_text, outcome, reason_code, parser_version, evaluator_version,
     canonical_payload, raw_payload_hash, canonical_hash, idempotency_key, created_at)
    VALUES (${malformedValues.map(() => "?").join(", ")})`;
  try {
    direct.pragma("foreign_keys = ON");
    assert.throws(() => direct.prepare(directInsertSql).run(...malformedValues), /resolution contract violation/);
    const triggerSql = direct.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_short_market_evidence_resolution_contract'").get().sql;
    direct.transaction(() => {
      direct.exec("DROP TRIGGER trg_short_market_evidence_resolution_contract");
      direct.pragma("ignore_check_constraints = ON");
      try {
        direct.prepare(directInsertSql).run(...malformedValues);
      } finally {
        direct.pragma("ignore_check_constraints = OFF");
      }
      direct.exec(`${triggerSql};`);
    })();
  } finally {
    direct.close();
  }

  let pendingIds = new Set(listStrictShortMarketsPendingResolution({ limit: 500 }).map((market) => market.marketId));
  assert.equal(pendingIds.has(pendingIdentity.marketId), true);
  assert.equal(pendingIds.has(noEvidenceIdentity.marketId), true);
  assert.equal(pendingIds.has(legacyMalformedIdentity.marketId), true);
  assert.equal(pendingIds.has(resolvedIdentity.marketId), false);

  assert.ok(appendShortMarketEvidence(evidenceInput(legacyMalformedIdentity, unique("legacy-valid-resolution"), {
    kind: "RESOLUTION",
    source: "CLOB_MARKET_RESOLVED",
    status: "RESOLVED",
    decimalValueText: null,
    outcome: "DOWN",
  })));
  pendingIds = new Set(listStrictShortMarketsPendingResolution({ limit: 500 }).map((market) => market.marketId));
  assert.equal(pendingIds.has(legacyMalformedIdentity.marketId), false);
});

test("observation recovery lists registered markets before enrollment with deterministic window boundaries", () => {
  const nonce = unique("recovery-window");
  const timedIdentity = (label, startTime, endDate) => identity({
    eventId: `event-${label}-${nonce}`,
    marketId: `market-${label}-${nonce}`,
    conditionId: `condition-${label}-${nonce}`,
    upToken: `token-up-${label}-${nonce}`,
    downToken: `token-down-${label}-${nonce}`,
    startTime,
    endDate,
  });
  const ended = timedIdentity("ended", "2026-08-30T11:45:00.000Z", "2026-08-30T12:00:00.000Z");
  const firstB = timedIdentity("b", "2026-08-30T12:00:00.000Z", "2026-08-30T12:15:00.000Z");
  const firstA = timedIdentity("a", "2026-08-30T12:00:00.000Z", "2026-08-30T12:15:00.000Z");
  const atBoundary = timedIdentity("boundary", "2026-08-30T12:15:00.000Z", "2026-08-30T12:30:00.000Z");
  const afterBoundary = timedIdentity("future", "2026-08-30T12:15:00.001Z", "2026-08-30T12:30:00.001Z");
  for (const marketIdentity of [ended, firstB, firstA, atBoundary, afterBoundary]) {
    assert.ok(registerStrictShortMarket(registrationInput(marketIdentity, unique("recovery-registration"), {
      discoveryPayload: { question: `Question for ${marketIdentity.marketId}`, marketId: marketIdentity.marketId },
    })));
  }

  const query = {
    endAfterMs: Date.parse("2026-08-30T12:00:00.000Z"),
    startAtOrBeforeMs: Date.parse("2026-08-30T12:15:00.000Z"),
    limit: 10,
  };
  const listed = listStrictShortMarketsForObservation(query);
  assert.deepEqual(listed.map((market) => market.marketId), [firstA.marketId, firstB.marketId, atBoundary.marketId]);
  assert.deepEqual(listed[0].tokenIds, firstA.tokenIds);
  assert.deepEqual(listed[0].cryptoFingerprint, SHORT_OBSERVE_CRYPTO_FINGERPRINT);
  assert.deepEqual(listed[0].discoveryPayload, { marketId: firstA.marketId, question: `Question for ${firstA.marketId}` });
  assert.equal("registry" in listed[0], false);
  assert.equal("tokens" in listed[0], false);
  assert.equal("idempotencyKey" in listed[0].discoveryEvidence, false);
  assert.equal("rawPayloadHash" in listed[0].discoveryEvidence, false);
  assert.deepEqual(listStrictShortMarketsForObservation({ ...query, limit: 2 }).map((market) => market.marketId), [firstA.marketId, firstB.marketId]);
  assert.deepEqual(withoutStorageError(() => listStrictShortMarketsForObservation({ ...query, limit: 0 })), []);
  assert.deepEqual(withoutStorageError(() => listStrictShortMarketsForObservation({ ...query, endAfterMs: String(query.endAfterMs) })), []);
});

test("observation recovery excludes ambiguous accepted discovery evidence but ignores quarantined discovery", () => {
  const nonce = unique("recovery-evidence");
  const makeIdentity = (label) => identity({
    eventId: `event-${label}-${nonce}`,
    marketId: `market-${label}-${nonce}`,
    conditionId: `condition-${label}-${nonce}`,
    upToken: `token-up-${label}-${nonce}`,
    downToken: `token-down-${label}-${nonce}`,
    startTime: "2026-08-31T12:00:00.000Z",
    endDate: "2026-08-31T12:15:00.000Z",
  });
  const ambiguous = makeIdentity("ambiguous");
  const valid = makeIdentity("valid");
  assert.ok(registerStrictShortMarket(registrationInput(ambiguous, unique("ambiguous-registration"))));
  assert.ok(registerStrictShortMarket(registrationInput(valid, unique("valid-registration"))));
  assert.ok(appendShortMarketEvidence(evidenceInput(ambiguous, unique("extra-accepted-discovery"), {
    kind: "DISCOVERY",
    source: "GAMMA",
    status: "OK",
    decimalValueText: null,
    payload: { duplicate: true, marketId: ambiguous.marketId },
  })));
  assert.ok(appendShortMarketEvidence(evidenceInput(valid, unique("quarantined-discovery"), {
    kind: "DISCOVERY",
    source: "OBSERVER",
    status: "QUARANTINED",
    decimalValueText: null,
    payload: { quarantined: true, marketId: valid.marketId },
  })));

  const listedIds = listStrictShortMarketsForObservation({
    endAfterMs: Date.parse("2026-08-31T11:59:59.999Z"),
    startAtOrBeforeMs: Date.parse("2026-08-31T12:00:00.000Z"),
    limit: 10,
  }).map((market) => market.marketId);
  assert.deepEqual(listedIds, [valid.marketId]);
});

test("strict short-market storage exposes no mutation or action APIs", () => {
  for (const name of ["updateStrictShortMarket", "deleteStrictShortMarket", "deleteShortMarketEvidence", "setShortMarketAction"]) {
    assert.equal(name in storage, false);
  }
});
