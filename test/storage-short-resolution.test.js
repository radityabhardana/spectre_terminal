import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";

import {
  SHORT_OBSERVE_CRYPTO_FINGERPRINT,
  parseBtc15mGammaEvent,
} from "../src/short-observe-contract.js";
import {
  appendShortMarketEvidence,
  appendShortResolutionEvidenceBatch,
  appendStrictShortObservationAttempt,
  auditPayloadHash,
  canonicalAuditPayload,
  claimShortObservationRun,
  databasePath,
  enrollShortObservationRun,
  getShortObserverSoakSummary,
  listStrictShortMarketsPendingResolution,
  queryShortMarketEvidence,
  registerStrictShortMarket,
} from "../src/storage.js";

const RAW_HASH = "a".repeat(64);

function unique(label) {
  return `${label}-${randomUUID().replaceAll("-", "")}`;
}

function identity(label, startTime, overrides = {}) {
  const nonce = unique(label);
  const startMs = Date.parse(startTime);
  const endDate = new Date(startMs + 900_000).toISOString();
  return parseBtc15mGammaEvent({
    id: overrides.eventId ?? `event-${nonce}`,
    startTime,
    series: [{ id: "10192" }],
    cryptoFingerprint: structuredClone(SHORT_OBSERVE_CRYPTO_FINGERPRINT),
    markets: [{
      id: overrides.marketId ?? `market-${nonce}`,
      conditionId: overrides.conditionId ?? `condition-${nonce}`,
      eventStartTime: startTime,
      endDate,
      outcomes: ["Up", "Down"],
      clobTokenIds: [overrides.upToken ?? `token-up-${nonce}`, overrides.downToken ?? `token-down-${nonce}`],
    }],
  })[0];
}

function registrationInput(market, label, createdAt = new Date(market.startMs - 1_000).toISOString()) {
  const discoveryPayload = { market: { conditionId: market.conditionId, id: market.marketId }, source: "gamma-keyset" };
  return {
    identity: market,
    discoveryPayload,
    discoveryPayloadHash: auditPayloadHash(canonicalAuditPayload(discoveryPayload)),
    fingerprintHash: auditPayloadHash(canonicalAuditPayload(market.cryptoFingerprint)),
    parserVersion: "strict-identity-parser-v1",
    createdAt,
    evidenceMetadata: {
      candidateKey: `candidate-${label}`,
      idempotencyKey: `discovery-${label}`,
      source: "GAMMA",
      status: "OK",
      sourceTimestampMs: market.startMs,
      effectiveTimestampMs: market.startMs,
      receivedTimestampMs: market.startMs + 100,
      evaluatorVersion: "strict-discovery-evaluator-v1",
      rawPayloadHash: RAW_HASH,
    },
  };
}

function register(market, createdAt) {
  assert.ok(registerStrictShortMarket(registrationInput(market, unique("registration"), createdAt)));
}

function resolutionEvidence(market, label, overrides = {}) {
  const receivedTimestampMs = overrides.receivedTimestampMs ?? market.endMs + 100;
  return {
    candidateKey: `candidate-${label}`,
    marketId: market.marketId,
    kind: "RESOLUTION",
    source: "OBSERVER",
    status: "UNRESOLVED",
    sourceTimestampMs: null,
    effectiveTimestampMs: market.endMs,
    receivedTimestampMs,
    decimalValueText: null,
    outcome: null,
    reasonCode: "PLATFORM_NOT_TERMINAL",
    parserVersion: "strict-resolution-parser-v1",
    evaluatorVersion: "strict-resolution-evaluator-v1",
    payload: { marketId: market.marketId, reason: "PLATFORM_NOT_TERMINAL", status: "UNRESOLVED" },
    rawPayloadHash: null,
    idempotencyKey: `resolution-${label}`,
    createdAt: new Date(receivedTimestampMs).toISOString(),
    ...overrides,
  };
}

function closeBoundaryEvidence(market, label, overrides = {}) {
  const receivedTimestampMs = overrides.receivedTimestampMs ?? market.endMs + 50;
  return {
    candidateKey: `candidate-${label}`,
    marketId: market.marketId,
    kind: "BOUNDARY_TWAP",
    source: "RTDS",
    status: "OK",
    sourceTimestampMs: market.endMs,
    effectiveTimestampMs: market.endMs,
    receivedTimestampMs,
    decimalValueText: "112999.12345678901234567890",
    outcome: null,
    reasonCode: null,
    parserVersion: "strict-boundary-parser-v1",
    evaluatorVersion: "strict-boundary-evaluator-v1",
    payload: { boundaryTimestampMs: market.endMs, marketId: market.marketId, value: "112999.12345678901234567890" },
    rawPayloadHash: RAW_HASH,
    idempotencyKey: `boundary-${label}`,
    createdAt: new Date(receivedTimestampMs).toISOString(),
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

function insertLegacyResolution(market, label, overrides = {}) {
  const receivedTimestampMs = overrides.receivedTimestampMs ?? market.endMs + 100;
  const status = overrides.status ?? "RESOLVED";
  const source = overrides.source ?? "GAMMA";
  const outcome = overrides.outcome === undefined ? "UP" : overrides.outcome;
  const payload = canonicalAuditPayload({ legacy: true, marketId: market.marketId, status });
  const direct = new Database(databasePath);
  try {
    direct.pragma("foreign_keys = ON");
    direct.prepare(`INSERT INTO short_market_evidence
      (candidate_key, market_id, kind, source, status, source_timestamp_ms, effective_timestamp_ms,
       received_timestamp_ms, decimal_value_text, outcome, reason_code, parser_version, evaluator_version,
       canonical_payload, raw_payload_hash, canonical_hash, idempotency_key, created_at)
      VALUES (?, ?, 'RESOLUTION', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(
      `candidate-${label}`,
      market.marketId,
      source,
      status,
      market.endMs,
      receivedTimestampMs,
      outcome,
      status === "RESOLVED" ? null : "LEGACY_RETRY",
      "legacy-parser-v1",
      "legacy-evaluator-v1",
      payload,
      "f".repeat(64),
      `legacy-${label}`,
      new Date(receivedTimestampMs).toISOString(),
    );
  } finally {
    direct.close();
  }
}

test("resolution evidence batch commits atomically and exact repeats are idempotent", () => {
  const market = identity("batch", "2026-10-01T12:00:00.000Z");
  register(market);
  const close = closeBoundaryEvidence(market, unique("close"));
  const unresolved = resolutionEvidence(market, unique("unresolved"));
  const first = appendShortResolutionEvidenceBatch({ marketId: market.marketId, evidence: [close, unresolved] });
  assert.equal(first.length, 2);
  assert.notEqual(first[0].id, first[1].id);

  const repeated = appendShortResolutionEvidenceBatch({ marketId: market.marketId, evidence: [close, unresolved] });
  assert.deepEqual(repeated.map((row) => row.id), first.map((row) => row.id));
  assert.equal(queryShortMarketEvidence({ marketId: market.marketId, kind: "BOUNDARY_TWAP" }).length, 1);
  assert.equal(queryShortMarketEvidence({ marketId: market.marketId, kind: "RESOLUTION" }).length, 1);
});

test("resolution evidence batch rolls back every new row on conflict or invalid batch membership", () => {
  const market = identity("batch-rollback", "2026-10-01T13:00:00.000Z");
  register(market);
  const accepted = resolutionEvidence(market, unique("accepted"), { payload: { accepted: true } });
  assert.ok(appendShortMarketEvidence(accepted));

  const newBeforeConflict = resolutionEvidence(market, unique("new-before-conflict"));
  const conflict = { ...accepted, payload: { accepted: false } };
  assert.equal(withoutStorageError(() => appendShortResolutionEvidenceBatch({
    marketId: market.marketId,
    evidence: [newBeforeConflict, conflict],
  })), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: newBeforeConflict.candidateKey }).length, 0);
  assert.deepEqual(queryShortMarketEvidence({ candidateKey: accepted.candidateKey })[0].payload, { accepted: true });

  const newBeforeInvalid = resolutionEvidence(market, unique("new-before-invalid"));
  const invalidKind = {
    ...resolutionEvidence(market, unique("invalid-kind")),
    kind: "ORDER_BOOK",
    source: "POLYMARKET_CLOB",
    status: "OK",
  };
  assert.equal(withoutStorageError(() => appendShortResolutionEvidenceBatch({
    marketId: market.marketId,
    evidence: [newBeforeInvalid, invalidKind],
  })), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: newBeforeInvalid.candidateKey }).length, 0);

  const newBeforeOpening = resolutionEvidence(market, unique("new-before-opening"));
  const openingBoundary = closeBoundaryEvidence(market, unique("opening"), {
    sourceTimestampMs: market.startMs,
    effectiveTimestampMs: market.startMs,
  });
  assert.equal(withoutStorageError(() => appendShortResolutionEvidenceBatch({
    marketId: market.marketId,
    evidence: [newBeforeOpening, openingBoundary],
  })), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: newBeforeOpening.candidateKey }).length, 0);
  assert.equal(queryShortMarketEvidence({ candidateKey: openingBoundary.candidateKey }).length, 0);

  const otherMarket = identity("batch-other-market", "2026-10-01T13:30:00.000Z");
  register(otherMarket);
  const newBeforeMismatch = resolutionEvidence(market, unique("new-before-mismatch"));
  const mismatched = resolutionEvidence(otherMarket, unique("mismatched-market"));
  assert.equal(withoutStorageError(() => appendShortResolutionEvidenceBatch({
    marketId: market.marketId,
    evidence: [newBeforeMismatch, mismatched],
  })), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: newBeforeMismatch.candidateKey }).length, 0);
  assert.equal(queryShortMarketEvidence({ candidateKey: mismatched.candidateKey }).length, 0);

  const unregistered = identity("batch-unregistered", "2026-10-01T14:00:00.000Z");
  const unknownEvidence = resolutionEvidence(unregistered, unique("unregistered"));
  assert.equal(withoutStorageError(() => appendShortResolutionEvidenceBatch({
    marketId: unregistered.marketId,
    evidence: [unknownEvidence],
  })), null);
  assert.equal(queryShortMarketEvidence({ candidateKey: unknownEvidence.candidateKey }).length, 0);
});

test("pending resolution applies inclusive end and retry boundaries in deterministic order", () => {
  const early = identity("pending-early", "2026-10-02T12:15:00.000Z");
  const retryEqual = identity("pending-equal", "2026-10-02T12:30:00.000Z");
  const retryAfter = identity("pending-after", "2026-10-02T12:45:00.000Z");
  const future = identity("pending-future", "2026-10-02T13:00:00.000Z");
  for (const market of [early, retryEqual, retryAfter, future]) register(market);
  const retryBeforeMs = Date.parse("2026-10-02T13:05:00.000Z");
  assert.ok(appendShortResolutionEvidenceBatch({
    marketId: retryEqual.marketId,
    evidence: [resolutionEvidence(retryEqual, unique("retry-equal"), { receivedTimestampMs: retryBeforeMs })],
  }));
  assert.ok(appendShortResolutionEvidenceBatch({
    marketId: retryAfter.marketId,
    evidence: [resolutionEvidence(retryAfter, unique("retry-after"), { receivedTimestampMs: retryBeforeMs + 1 })],
  }));

  const cutoff = retryAfter.endMs;
  const testMarketIds = new Set([early.marketId, retryEqual.marketId, retryAfter.marketId, future.marketId]);
  const listedTestIds = (query) => listStrictShortMarketsPendingResolution(query)
    .map((market) => market.marketId)
    .filter((marketId) => testMarketIds.has(marketId));
  assert.deepEqual(listedTestIds({ endAtOrBeforeMs: cutoff, retryBeforeMs, limit: 20 }), [early.marketId, retryEqual.marketId]);
  assert.deepEqual(listedTestIds({ endAtOrBeforeMs: cutoff, retryBeforeMs: retryBeforeMs + 1, limit: 20 }), [early.marketId, retryEqual.marketId, retryAfter.marketId]);
  assert.deepEqual(listedTestIds({ endAtOrBeforeMs: cutoff - 1, retryBeforeMs: retryBeforeMs + 1, limit: 20 }), [early.marketId, retryEqual.marketId]);
});

test("pending resolution applies the inclusive lower cutoff in SQL before limit so expired rows cannot starve eligible markets", () => {
  const lowerBoundary = Date.parse("2026-11-30T12:00:00.000Z");
  const upperBoundary = identity("lower-boundary", "2026-11-30T11:45:00.000Z");
  const lowerBoundaryMarket = identity("lower-boundary-exact", "2026-11-30T11:45:00.000Z");
  const expiredBoundary = identity("lower-boundary-expired", "2026-11-30T11:44:59.999Z");
  assert.equal(upperBoundary.endMs, lowerBoundary);
  assert.equal(lowerBoundaryMarket.endMs, lowerBoundary);
  assert.equal(expiredBoundary.endMs, lowerBoundary - 1);
  for (const market of [upperBoundary, lowerBoundaryMarket, expiredBoundary]) register(market);

  const expiredPreceding = [];
  for (let index = 0; index < 101; index += 1) {
    const market = identity(`expired-preceding-${index}`, "2026-11-30T11:44:00.000Z");
    register(market);
    expiredPreceding.push(market);
  }
  const eligibleIds = new Set([upperBoundary.marketId, lowerBoundaryMarket.marketId]);
  const listed = listStrictShortMarketsPendingResolution({
    endAtOrAfterMs: lowerBoundary,
    endAtOrBeforeMs: lowerBoundary,
    retryBeforeMs: Date.parse("2026-11-30T12:15:00.000Z"),
    limit: 1,
  });
  assert.equal(listed.length, 1);
  assert.equal(eligibleIds.has(listed[0].marketId), true);
  assert.equal(expiredPreceding.some((market) => market.marketId === listed[0].marketId), false);

  const exactBoundaryIds = listStrictShortMarketsPendingResolution({
    endAtOrAfterMs: lowerBoundary,
    endAtOrBeforeMs: lowerBoundary,
    retryBeforeMs: Date.parse("2026-11-30T12:15:00.000Z"),
    limit: 10,
  }).map((market) => market.marketId);
  assert.deepEqual(new Set(exactBoundaryIds), new Set([upperBoundary.marketId, lowerBoundaryMarket.marketId]));
  assert.equal(exactBoundaryIds.includes(expiredBoundary.marketId), false);
});

test("pending resolution rejects invalid lower, upper, retry, and limit inputs", () => {
  const valid = {
    endAtOrAfterMs: Date.parse("2026-12-02T12:00:00.000Z"),
    endAtOrBeforeMs: Date.parse("2026-12-02T12:15:00.000Z"),
    retryBeforeMs: Date.parse("2026-12-02T12:15:00.000Z"),
    limit: 1,
  };
  for (const mutation of [
    { endAtOrAfterMs: String(valid.endAtOrAfterMs) },
    { endAtOrAfterMs: valid.endAtOrAfterMs + 0.5 },
    { endAtOrAfterMs: 0 },
    { endAtOrBeforeMs: String(valid.endAtOrBeforeMs) },
    { retryBeforeMs: String(valid.retryBeforeMs) },
    { limit: 0 },
    { limit: 1.5 },
  ]) {
    assert.deepEqual(withoutStorageError(() => listStrictShortMarketsPendingResolution({ ...valid, ...mutation })), []);
  }
});

test("pending resolution trusts only canonical terminal evidence and rate-limits canonical quarantine", () => {
  const start = "2026-10-03T12:00:00.000Z";
  const resolved = identity("canonical-resolved", start);
  const nonterminal = identity("nonterminal", start);
  const dataGap = identity("data-gap", start);
  const recentQuarantine = identity("recent-quarantine", start);
  const malformedTerminal = identity("malformed-terminal", start);
  const malformedFuture = identity("malformed-future", start);
  for (const market of [resolved, nonterminal, dataGap, recentQuarantine, malformedTerminal, malformedFuture]) register(market);
  const retryBeforeMs = Date.parse("2026-10-03T12:20:00.000Z");

  assert.ok(appendShortResolutionEvidenceBatch({
    marketId: resolved.marketId,
    evidence: [resolutionEvidence(resolved, unique("resolved"), {
      source: "GAMMA",
      status: "RESOLVED",
      outcome: "UP",
      reasonCode: null,
      payload: { marketId: resolved.marketId, outcome: "UP", source: "GAMMA", status: "RESOLVED" },
    })],
  }));
  const opening = closeBoundaryEvidence(nonterminal, unique("opening-projection"), {
    sourceTimestampMs: nonterminal.startMs,
    effectiveTimestampMs: nonterminal.startMs,
    receivedTimestampMs: nonterminal.startMs + 100,
  });
  assert.ok(appendShortMarketEvidence(opening));
  const close = closeBoundaryEvidence(nonterminal, unique("close-projection"));
  const unresolved = resolutionEvidence(nonterminal, unique("nonterminal"), { receivedTimestampMs: retryBeforeMs });
  assert.ok(appendShortResolutionEvidenceBatch({ marketId: nonterminal.marketId, evidence: [close, unresolved] }));
  assert.ok(appendShortResolutionEvidenceBatch({
    marketId: dataGap.marketId,
    evidence: [resolutionEvidence(dataGap, unique("data-gap"), {
      status: "DATA_GAP",
      reasonCode: "PLATFORM_UNAVAILABLE",
      receivedTimestampMs: retryBeforeMs,
      payload: { marketId: dataGap.marketId, reason: "PLATFORM_UNAVAILABLE", status: "DATA_GAP" },
    })],
  }));
  assert.ok(appendShortResolutionEvidenceBatch({
    marketId: recentQuarantine.marketId,
    evidence: [
      resolutionEvidence(recentQuarantine, unique("pre-quarantine"), { receivedTimestampMs: retryBeforeMs - 100 }),
      resolutionEvidence(recentQuarantine, unique("quarantine"), {
        status: "QUARANTINED",
        reasonCode: "SOURCE_DISAGREEMENT",
        receivedTimestampMs: retryBeforeMs + 1,
        payload: { marketId: recentQuarantine.marketId, reason: "SOURCE_DISAGREEMENT", status: "QUARANTINED" },
      }),
    ],
  }));
  insertLegacyResolution(malformedTerminal, unique("malformed-terminal"));
  insertLegacyResolution(malformedFuture, unique("malformed-future"), {
    status: "UNRESOLVED",
    source: "OBSERVER",
    outcome: null,
    receivedTimestampMs: retryBeforeMs + 60_000,
  });

  const query = { endAtOrBeforeMs: resolved.endMs, retryBeforeMs, limit: 20 };
  const pending = listStrictShortMarketsPendingResolution(query);
  const pendingIds = new Set(pending.map((market) => market.marketId));
  assert.equal(pendingIds.has(resolved.marketId), false);
  assert.equal(pendingIds.has(nonterminal.marketId), true);
  assert.equal(pendingIds.has(dataGap.marketId), true);
  assert.equal(pendingIds.has(recentQuarantine.marketId), false);
  assert.equal(pendingIds.has(malformedTerminal.marketId), true);
  assert.equal(pendingIds.has(malformedFuture.marketId), true);

  const projected = pending.find((market) => market.marketId === nonterminal.marketId);
  assert.deepEqual(projected.tokenIds, nonterminal.tokenIds);
  assert.deepEqual(projected.boundaryEvidence.map((item) => item.effectiveTimestampMs), [nonterminal.startMs, nonterminal.endMs]);
  assert.deepEqual(projected.resolutionEvidence.map((item) => item.status), ["UNRESOLVED"]);
  assert.equal("registry" in projected, false);
  assert.equal("tokens" in projected, false);
  assert.equal("id" in projected.resolutionEvidence[0], false);
  assert.equal("idempotencyKey" in projected.resolutionEvidence[0], false);
  assert.equal("rawPayloadHash" in projected.resolutionEvidence[0], false);
  assert.deepEqual(listStrictShortMarketsPendingResolution(query), pending);

  const afterQuarantineRetry = listStrictShortMarketsPendingResolution({ ...query, retryBeforeMs: retryBeforeMs + 1 });
  assert.equal(afterQuarantineRetry.some((market) => market.marketId === recentQuarantine.marketId), true);
});

test("short observer soak summary exposes aggregate counts and ranges without row authority", () => {
  const sinceMs = Date.parse("2027-01-01T00:00:00.000Z");
  const observed = identity("soak-observed", "2027-02-01T12:00:00.000Z");
  const registeredOnly = identity("soak-registered", "2027-02-01T12:30:00.000Z");
  register(observed, "2027-02-01T11:59:00.000Z");
  register(registeredOnly, "2027-02-01T12:29:00.000Z");

  const runLabel = unique("soak-run");
  const run = {
    runId: `run-${runLabel}`,
    enrollmentKey: `enroll-${runLabel}`,
    marketId: observed.marketId,
    marketQuestion: "BTC Up or Down - soak",
    asset: observed.asset,
    durationType: observed.durationType,
    config: { mode: "strict", soak: true },
    nextScheduledAt: observed.startTime,
    createdAt: "2027-02-01T11:59:30.000Z",
  };
  assert.ok(enrollShortObservationRun(run));
  assert.ok(claimShortObservationRun({
    runId: run.runId,
    leaseOwner: "soak-worker",
    leaseToken: "soak-token",
    leaseExpiresAt: "2027-02-01T12:20:00.000Z",
    now: "2027-02-01T11:59:40.000Z",
  }));
  const opening = closeBoundaryEvidence(observed, unique("soak-opening"), {
    sourceTimestampMs: observed.startMs,
    effectiveTimestampMs: observed.startMs,
    receivedTimestampMs: observed.startMs + 100,
    createdAt: "2027-02-01T12:00:00.100Z",
  });
  assert.ok(appendStrictShortObservationAttempt({
    ...run,
    sequence: 0,
    capturedAt: "2027-02-01T12:00:00.100Z",
    createdAt: "2027-02-01T12:00:00.100Z",
    auditPayload: { observation: "soak" },
    leaseOwner: "soak-worker",
    leaseToken: "soak-token",
    now: "2027-02-01T12:00:00.100Z",
    evidence: [opening],
  }) > 0);
  assert.ok(appendShortResolutionEvidenceBatch({
    marketId: observed.marketId,
    evidence: [
      resolutionEvidence(observed, unique("soak-gap"), {
        status: "DATA_GAP",
        reasonCode: "PLATFORM_UNAVAILABLE",
        payload: { reason: "PLATFORM_UNAVAILABLE", status: "DATA_GAP" },
      }),
      resolutionEvidence(observed, unique("soak-quarantine"), {
        status: "QUARANTINED",
        reasonCode: "SOURCE_DISAGREEMENT",
        receivedTimestampMs: observed.endMs + 200,
        payload: { reason: "SOURCE_DISAGREEMENT", status: "QUARANTINED" },
      }),
      resolutionEvidence(observed, unique("soak-resolved"), {
        source: "GAMMA",
        status: "RESOLVED",
        outcome: "DOWN",
        reasonCode: null,
        receivedTimestampMs: observed.endMs + 300,
        payload: { outcome: "DOWN", source: "GAMMA", status: "RESOLVED" },
      }),
    ],
  }));

  const summary = getShortObserverSoakSummary({ sinceMs });
  assert.equal(summary.sinceMs, sinceMs);
  assert.equal(summary.registeredMarkets.count, 2);
  assert.deepEqual(summary.registeredMarkets.startTimestampMs, { min: observed.startMs, max: registeredOnly.startMs });
  assert.equal(summary.runs.count, 1);
  assert.deepEqual(summary.runs.sequence, { min: 1, max: 1 });
  assert.equal(summary.snapshots.count, 1);
  assert.deepEqual(summary.snapshots.sequence, { min: 0, max: 0 });
  assert.equal(summary.evidence.count, 6);
  assert.equal(summary.evidence.byKind.DISCOVERY, 2);
  assert.equal(summary.evidence.byKind.BOUNDARY_TWAP, 1);
  assert.equal(summary.evidence.byKind.RESOLUTION, 3);
  assert.equal(summary.evidence.byStatus.OK, 3);
  assert.equal(summary.evidence.dataGapCount, 1);
  assert.equal(summary.evidence.quarantinedCount, 1);
  assert.equal(summary.evidence.resolvedCount, 1);
  assert.equal(summary.evidence.bySource.GAMMA, 3);
  assert.equal(summary.evidence.bySource.RTDS, 1);
  assert.equal(summary.evidence.bySource.OBSERVER, 2);
  assert.deepEqual(summary.evidence.receivedTimestampMs, {
    min: observed.startMs + 100,
    max: registeredOnly.startMs + 100,
  });
  const serialized = JSON.stringify(summary).toLowerCase();
  for (const forbidden of ["payload", "idempotency", "token", "lease", "config", "question", "action", "secret"]) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must not leak through the soak summary`);
  }
  assert.equal(withoutStorageError(() => getShortObserverSoakSummary({ sinceMs: String(sinceMs) })), null);
});
