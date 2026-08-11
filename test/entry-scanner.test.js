import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ENTRY_SCANNER_CONFIG,
  advanceEntryScannerState,
  assessEntrySnapshot,
  normalizeEntryScannerResult,
  qualifyEntrySnapshot,
  resetEntryScannerItem,
  selectNewestEntryScannerItem,
  summarizeEntryScannerSession,
  terminalizeEntryScannerState,
} from "../public/entry-scanner.js";

function snapshot(overrides = {}) {
  return {
    capturedAt: "2026-07-29T06:01:00.000Z",
    remainingSeconds: 210,
    oracleAgeMs: 2_000,
    marketActive: true,
    marketClosed: false,
    acceptingOrders: true,
    actionable: true,
    blockers: [],
    feeBufferCents: 4,
    sides: {
      UP: { fairProbability: 72, ask: 0.55, netEvCents: 13 },
      DOWN: { fairProbability: 28, ask: 0.46, netEvCents: -22 },
    },
    ...overrides,
  };
}

test("qualifies the highest-EV executable side inside the scan window", () => {
  const result = qualifyEntrySnapshot(snapshot(), DEFAULT_ENTRY_SCANNER_CONFIG);

  assert.equal(result.qualified, true);
  assert.equal(result.direction, "UP");
  assert.equal(result.ask, 0.55);
  assert.equal(result.netEvCents, 13);
  assert.equal(result.maxEntryPrice, 0.6);
});

test("rejects weak, expensive, stale, and out-of-window snapshots", () => {
  assert.equal(qualifyEntrySnapshot(snapshot({ sides: { UP: { fairProbability: 59, ask: 0.45, netEvCents: 10 } } })).qualified, false);
  assert.equal(qualifyEntrySnapshot(snapshot({ sides: { UP: { fairProbability: 80, ask: 0.66, netEvCents: 10 } } })).qualified, false);
  assert.equal(qualifyEntrySnapshot(snapshot({ oracleAgeMs: 16_000 })).qualified, false);
  assert.equal(qualifyEntrySnapshot(snapshot({ remainingSeconds: 119 })).status, "expired");
  assert.equal(qualifyEntrySnapshot(snapshot({ remainingSeconds: 310 })).status, "waiting");
});

test("closed markets can never qualify", () => {
  const closed = assessEntrySnapshot(snapshot({ marketClosed: true }));
  assert.equal(closed.qualified, false);
  assert.equal(closed.dataStatus, "BLOCKED");
  assert.equal(closed.failedGates.some((failure) => failure.id === "MARKET_EXECUTABILITY"), true);
});

test("actionable false and server blockers independently prevent qualification", () => {
  const nonActionable = assessEntrySnapshot(snapshot({
    actionable: false,
    blockers: [],
  }));
  assert.equal(nonActionable.qualified, false);
  assert.equal(nonActionable.dataStatus, "BLOCKED");
  assert.deepEqual(nonActionable.failedGates.filter((failure) => failure.id === "BACKEND_ACTIONABLE").map((failure) => failure.id), [
    "BACKEND_ACTIONABLE",
  ]);

  const serverBlocked = assessEntrySnapshot(snapshot({
    actionable: true,
    blockers: ["[MAX ENTRY PRICE GUARDRAIL]"],
  }));
  assert.equal(serverBlocked.qualified, false);
  assert.equal(serverBlocked.dataStatus, "BLOCKED");
  assert.deepEqual(serverBlocked.failedGates.filter((failure) => failure.id === "SERVER_GUARDRAIL").map((failure) => failure.id), [
    "SERVER_GUARDRAIL",
  ]);
});

test("snapshots with missing backend authority are unavailable and cannot qualify", () => {
  const missingActionable = assessEntrySnapshot(snapshot({ actionable: undefined }));
  const missingBlockers = assessEntrySnapshot(snapshot({ blockers: undefined }));

  for (const assessment of [missingActionable, missingBlockers]) {
    assert.equal(assessment.qualified, false);
    assert.equal(assessment.dataStatus, "UNAVAILABLE");
    assert.equal(assessment.failedGates.some((failure) => failure.id === "BACKEND_AUTHORITY"), true);
  }
});

test("requires two consecutive confirmations in the same direction", () => {
  const first = advanceEntryScannerState({}, snapshot());
  assert.equal(first.status, "candidate");
  assert.equal(first.confirmationCount, 1);

  const second = advanceEntryScannerState(first, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z", remainingSeconds: 205 }));
  assert.equal(second.status, "entry");
  assert.equal(second.confirmationCount, 2);
  assert.equal(second.signal.direction, "UP");
});

test("direction disagreement resets candidate confirmation", () => {
  const first = advanceEntryScannerState({}, snapshot());
  const changed = advanceEntryScannerState(first, snapshot({
    sides: {
      UP: { fairProbability: 35, ask: 0.36, netEvCents: -5 },
      DOWN: { fairProbability: 65, ask: 0.5, netEvCents: 11 },
    },
  }));

  assert.equal(changed.status, "candidate");
  assert.equal(changed.candidateDirection, "DOWN");
  assert.equal(changed.confirmationCount, 1);
});

test("confirmed signal becomes no-chase when price loses its edge", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const noChase = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:10.000Z",
    sides: {
      UP: { fairProbability: 72, ask: 0.65, netEvCents: 3 },
      DOWN: { fairProbability: 28, ask: 0.36, netEvCents: -12 },
    },
  }));

  assert.equal(noChase.status, "no_chase");
  assert.equal(noChase.reason, "Issued UP side no longer qualifies.");
});

test("confirmed signal remains valid across scan-stop while its TTL and edge remain valid", () => {
  const candidate = advanceEntryScannerState({}, snapshot({ remainingSeconds: 200 }));
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z", remainingSeconds: 190 }));
  const revalidated = advanceEntryScannerState(entry, snapshot({ capturedAt: "2026-07-29T06:01:10.000Z", remainingSeconds: 140 }));

  assert.equal(revalidated.status, "entry");
});

test("confirmed signal remains entry when the opposite qualified side ranks higher", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const revalidated = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    sides: {
      UP: { fairProbability: 70, ask: 0.55, netEvCents: 11 },
      DOWN: { fairProbability: 75, ask: 0.5, netEvCents: 21 },
    },
  }));

  assert.equal(revalidated.latestAssessment.direction, "DOWN");
  assert.equal(revalidated.status, "entry");
  assert.deepEqual(revalidated.failedGates || [], []);
});

test("confirmed signal records its own failed qualification gate and exact reason", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const noChase = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    sides: {
      UP: { fairProbability: 72, ask: 0.55, netEvCents: 7 },
      DOWN: { fairProbability: 28, ask: 0.46, netEvCents: -22 },
    },
  }));

  assert.equal(noChase.status, "no_chase");
  assert.equal(noChase.reason, "Issued UP side no longer qualifies.");
  assert.deepEqual(noChase.failedGates.map((failure) => failure.id), ["MIN_NET_EV"]);
  assert.deepEqual(noChase.failedGates.map((failure) => failure.message), [
    "Net EV must be at least 8 cents.",
  ]);
});

test("confirmed signal records the issued max cap gate when only that cap is exceeded", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const noChase = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    sides: {
      UP: { fairProbability: 80, ask: 0.62, netEvCents: 14 },
      DOWN: { fairProbability: 20, ask: 0.39, netEvCents: -23 },
    },
  }));

  assert.equal(noChase.status, "no_chase");
  assert.equal(noChase.reason, "Issued UP ask exceeds its max entry price.");
  assert.deepEqual(noChase.failedGates, [{
    id: "ISSUED_MAX_ENTRY_PRICE",
    actual: 0.62,
    required: 0.6,
    message: "Ask $0.62 exceeds issued max entry price $0.60.",
  }]);
});

test("confirmed signal records an exact gate when its issued side disappears", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const noChase = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    sides: {
      DOWN: { fairProbability: 75, ask: 0.5, netEvCents: 21 },
    },
  }));

  assert.equal(noChase.status, "no_chase");
  assert.equal(noChase.reason, "Issued UP side is unavailable.");
  assert.deepEqual(noChase.failedGates, [{
    id: "SIGNAL_SIDE_UNAVAILABLE",
    actual: null,
    required: "UP side metrics",
    message: "Issued UP side is unavailable for revalidation.",
  }]);
});

test("transient snapshot errors preserve an existing candidate", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const degraded = advanceEntryScannerState(candidate, {
    error: "temporary CLOB failure",
    capturedAt: "2026-07-29T06:01:03.000Z",
  });

  assert.equal(degraded.status, "candidate");
  assert.equal(degraded.confirmationCount, 1);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.latestSnapshot, candidate.latestSnapshot);
  assert.equal(degraded.latestAssessment, candidate.latestAssessment);
  assert.equal(degraded.bestObserved, candidate.bestObserved);
  assert.equal(degraded.terminalCapturedAt, undefined);
});

test("revalidation errors fail a confirmed signal closed after its TTL", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const expired = advanceEntryScannerState(entry, {
    error: "temporary CLOB failure",
    capturedAt: "2026-07-29T06:01:16.000Z",
  });

  assert.equal(expired.status, "no_chase");
  assert.match(expired.reason, /expired/i);
  const result = normalizeEntryScannerResult(expired);
  assert.equal(result.dataStatus, "UNAVAILABLE");
  assert.deepEqual(result.failedGates.map((failure) => failure.message), [
    "Entry signal expired before use.",
  ]);
});

test("assessment retains both sides with derived values and every failed gate", () => {
  const assessment = assessEntrySnapshot(snapshot({
    marketActive: false,
    oracleAgeMs: 15_001,
    sides: {
      UP: { fairProbability: 59, ask: 0.66, netEvCents: 7 },
      DOWN: { fairProbability: null, ask: 0, netEvCents: "" },
    },
  }));

  assert.equal(assessment.dataStatus, "STALE");
  assert.deepEqual(Object.keys(assessment.sides), ["UP", "DOWN"]);
  assert.deepEqual(assessment.sides.UP, {
    direction: "UP",
    fairProbability: 59,
    ask: 0.66,
    feeBufferCents: 4,
    grossEvCents: -7,
    netEvCents: 7,
    maxEntryPrice: 0.47,
    qualified: false,
    failedGates: [
      {
        id: "MARKET_EXECUTABILITY",
        actual: { marketActive: false, marketClosed: false, acceptingOrders: true },
        required: { marketActive: true, marketClosed: false, acceptingOrders: true },
        message: "Market must be active, open, and accepting orders.",
      },
      {
        id: "STALE_ORACLE",
        actual: 15_001,
        required: 15_000,
        message: "Oracle age must be between 0 and 15000ms.",
      },
      {
        id: "MIN_FAIR_PROBABILITY",
        actual: 59,
        required: 60,
        message: "Fair probability must be at least 60%.",
      },
      {
        id: "MAX_ASK",
        actual: 0.66,
        required: 0.65,
        message: "Ask must not exceed $0.65.",
      },
      {
        id: "MIN_NET_EV",
        actual: 7,
        required: 8,
        message: "Net EV must be at least 8 cents.",
      },
      {
        id: "EDGE_PRESERVING_CAP",
        actual: 0.66,
        required: 0.47,
        message: "Ask must not exceed the edge-preserving cap of $0.47.",
      },
    ],
  });
  assert.equal(assessment.sides.DOWN.ask, 0);
  assert.deepEqual(
    assessment.sides.DOWN.failedGates.map((gate) => gate.id),
    ["MARKET_EXECUTABILITY", "STALE_ORACLE", "MISSING_METRICS", "INVALID_ASK"]
  );
  assert.deepEqual(assessment.sides.DOWN.failedGates[2].actual, ["fairProbability", "netEvCents"]);
});

test("assessment reports READY, STALE, BLOCKED, and UNAVAILABLE data status", () => {
  assert.equal(assessEntrySnapshot(snapshot()).dataStatus, "READY");
  assert.equal(assessEntrySnapshot(snapshot({ oracleAgeMs: 15_001 })).dataStatus, "STALE");
  assert.equal(assessEntrySnapshot(snapshot({ acceptingOrders: false })).dataStatus, "BLOCKED");
  assert.equal(assessEntrySnapshot(snapshot({ oracleAgeMs: null })).dataStatus, "UNAVAILABLE");
});

test("diagnostic lean follows forecast direction while observed side is ranked separately", () => {
  const assessment = assessEntrySnapshot(snapshot({
    forecastDirection: "DOWN",
    sides: {
      UP: { fairProbability: 80, ask: 0.5, netEvCents: 26 },
      DOWN: { fairProbability: 65, ask: 0.5, netEvCents: 11 },
    },
  }));

  assert.equal(assessment.diagnosticLean, "DOWN");
  assert.equal(assessment.observedSide.direction, "UP");
  assert.equal(assessEntrySnapshot(snapshot({ forecastDirection: "up" })).diagnosticLean, "NEUTRAL");
  assert.equal(assessEntrySnapshot(snapshot({ forecastDirection: "NEUTRAL" })).diagnosticLean, "NEUTRAL");
});

test("state retains strongest observation and confirmation evidence through degradation and flips", () => {
  const first = advanceEntryScannerState({}, snapshot({ forecastDirection: "UP" }));
  const confirmed = advanceEntryScannerState(first, snapshot({
    capturedAt: "2026-07-29T06:01:05.000Z",
    sides: {
      UP: { fairProbability: 74, ask: 0.54, netEvCents: 16 },
      DOWN: { fairProbability: 26, ask: 0.47, netEvCents: -25 },
    },
  }), { confirmations: 3 });
  const flipped = advanceEntryScannerState(confirmed, snapshot({
    capturedAt: "2026-07-29T06:01:10.000Z",
    forecastDirection: "DOWN",
    sides: {
      UP: { fairProbability: 35, ask: 0.36, netEvCents: -5 },
      DOWN: { fairProbability: 65, ask: 0.5, netEvCents: 11 },
    },
  }), { confirmations: 3 });
  const stale = advanceEntryScannerState(flipped, snapshot({
    capturedAt: "2026-07-29T06:01:15.000Z",
    oracleAgeMs: 15_001,
    sides: {
      UP: { fairProbability: 90, ask: 0.4, netEvCents: 46 },
      DOWN: { fairProbability: 10, ask: 0.61, netEvCents: -55 },
    },
  }), { confirmations: 3 });
  const errored = advanceEntryScannerState(stale, { error: "temporary failure" }, { confirmations: 3 });

  assert.equal(confirmed.maxConfirmationCount, 2);
  assert.equal(flipped.confirmationCount, 1);
  assert.equal(flipped.maxConfirmationCount, 2);
  assert.equal(stale.latestAssessment.dataStatus, "STALE");
  assert.equal(stale.bestObserved.direction, "UP");
  assert.equal(stale.bestObserved.netEvCents, 16);
  assert.equal(errored.latestAssessment, stale.latestAssessment);
  assert.equal(errored.bestObserved, stale.bestObserved);
  assert.equal(errored.maxConfirmationCount, 2);
});

test("best observation ranking is deterministic through all tie breakers", () => {
  const initial = advanceEntryScannerState({}, snapshot({
    capturedAt: "2026-07-29T06:01:00.000Z",
    sides: {
      UP: { fairProbability: 70, ask: 0.56, netEvCents: 10 },
      DOWN: { fairProbability: 70, ask: 0.54, netEvCents: 10 },
    },
  }), { confirmations: 9 });
  const later = advanceEntryScannerState(initial, snapshot({
    capturedAt: "2026-07-29T06:01:05.000Z",
    sides: {
      UP: { fairProbability: 70, ask: 0.54, netEvCents: 10 },
      DOWN: { fairProbability: 70, ask: 0.54, netEvCents: 10 },
    },
  }), { confirmations: 9 });

  assert.equal(initial.bestObserved.direction, "DOWN");
  assert.equal(later.bestObserved.direction, "DOWN");
  assert.equal(later.bestObserved.capturedAt, "2026-07-29T06:01:05.000Z");
});

test("terminal expiry records NO_ENTRY and exact failed gates without losing best observation", () => {
  const candidate = advanceEntryScannerState({}, snapshot(), { confirmations: 3 });
  const expired = advanceEntryScannerState(candidate, snapshot({
    capturedAt: "2026-07-29T06:02:31.000Z",
    remainingSeconds: 119,
  }), { confirmations: 3 });

  assert.equal(expired.status, "skipped");
  assert.equal(expired.outcome, "NO_ENTRY");
  assert.equal(expired.bestObserved.direction, "UP");
  assert.equal(expired.maxConfirmationCount, 1);
  assert.deepEqual(expired.failedGates, [{
    id: "CONFIRMATIONS",
    actual: 1,
    required: 3,
    message: "Required 3 same-direction confirmations; observed at most 1.",
  }]);
});

test("result and session helpers preserve NO_CHASE separately from its issued signal", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const noChase = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:10.000Z",
    sides: {
      UP: { fairProbability: 72, ask: 0.65, netEvCents: 3 },
      DOWN: { fairProbability: 28, ask: 0.36, netEvCents: -12 },
    },
  }));
  const skipped = advanceEntryScannerState({}, snapshot({ remainingSeconds: 119 }));
  const normalized = normalizeEntryScannerResult(noChase);

  assert.equal(normalizeEntryScannerResult(entry).completed, false);
  assert.equal(normalized.completed, true);
  assert.equal(normalized.outcome, "NO_CHASE");
  assert.equal(normalized.issuedSignal.direction, "UP");
  assert.equal(normalized.diagnosticLean, "NEUTRAL");
  assert.deepEqual(summarizeEntryScannerSession([
    { entryScanner: entry },
    { entryScanner: noChase },
    { entryScanner: skipped },
    { entryScanner: { status: "watching" } },
  ]), {
    completed: 2,
    entries: 1,
    noEntry: 1,
    noChase: 1,
    up: 0,
    down: 0,
    neutral: 2,
  });
});

test("session summary counts only terminal outcomes and retains issued signals on NO_CHASE", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const issued = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const noChase = advanceEntryScannerState(issued, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    sides: {
      UP: { fairProbability: 72, ask: 0.65, netEvCents: 3 },
      DOWN: { fairProbability: 28, ask: 0.36, netEvCents: -12 },
    },
  }));

  assert.deepEqual(summarizeEntryScannerSession([
    { entryScanner: issued },
    { entryScanner: noChase },
    { entryScanner: { status: "watching" } },
  ]), {
    completed: 1,
    entries: 1,
    noEntry: 0,
    noChase: 1,
    up: 0,
    down: 0,
    neutral: 1,
  });
});

test("empty side metrics do not fabricate a best observation but partial metrics are retained", () => {
  const empty = advanceEntryScannerState({}, snapshot({ sides: {} }));
  const partial = advanceEntryScannerState(empty, snapshot({
    capturedAt: "2026-07-29T06:01:05.000Z",
    sides: { UP: { ask: 0.5 } },
  }));

  assert.equal(empty.bestObserved, null);
  assert.equal(partial.bestObserved.direction, "UP");
  assert.equal(partial.bestObserved.ask, 0.5);
  assert.equal(partial.bestObserved.fairProbability, null);
  assert.equal(partial.bestObserved.netEvCents, null);
});

test("signal panel selection uses scanner chronology instead of queue order", () => {
  const newerEntry = {
    id: "new-entry",
    entryScanner: {
      status: "entry",
      signal: { direction: "UP", capturedAt: "2026-07-29T06:01:10.000Z" },
      latestSnapshot: { capturedAt: "2026-07-29T06:01:10.000Z" },
    },
  };
  const olderNoEntry = {
    id: "old-no-entry",
    entryScanner: {
      status: "skipped",
      latestSnapshot: { capturedAt: "2026-07-29T06:01:05.000Z" },
    },
  };

  assert.equal(selectNewestEntryScannerItem([newerEntry, olderNoEntry]), newerEntry);
});

test("error-driven NO_CHASE is ordered by its terminal transition time", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({
    capturedAt: "2026-07-29T06:01:05.000Z",
  }));
  const noChase = advanceEntryScannerState(entry, {
    error: "temporary CLOB failure",
    capturedAt: "2026-07-29T06:01:16.000Z",
  });
  const olderTerminal = {
    id: "older-terminal",
    entryScanner: {
      status: "skipped",
      latestSnapshot: { capturedAt: "2026-07-29T06:01:10.000Z" },
    },
  };
  const errorTerminal = { id: "error-terminal", entryScanner: noChase };

  assert.equal(noChase.terminalCapturedAt, "2026-07-29T06:01:16.000Z");
  assert.equal(selectNewestEntryScannerItem([errorTerminal, olderTerminal]), errorTerminal);
});

test("terminalization advances oracle age without rewriting the observation timestamp", () => {
  const observed = snapshot({
    capturedAt: "2026-07-29T06:01:00.000Z",
    oracleAgeMs: 2_000,
  });
  const candidate = advanceEntryScannerState({}, observed, { confirmations: 3 });
  const terminal = terminalizeEntryScannerState(
    candidate,
    119,
    "2026-07-29T06:01:20.000Z",
    { confirmations: 3 },
  );
  const result = normalizeEntryScannerResult(terminal);

  assert.equal(terminal.latestSnapshot.capturedAt, observed.capturedAt);
  assert.equal(terminal.latestSnapshot.oracleAgeMs, 22_000);
  assert.equal(terminal.latestSnapshot.sides, observed.sides);
  assert.equal(terminal.terminalCapturedAt, "2026-07-29T06:01:20.000Z");
  assert.equal(result.dataStatus, "STALE");
  assert.deepEqual(result.failedGates.filter((failure) => failure.id === "STALE_ORACLE"), [{
    id: "STALE_ORACLE",
    actual: 22_000,
    required: 15_000,
    message: "Oracle age must be between 0 and 15000ms.",
  }]);
});

test("terminalization preserves a genuinely fresh snapshot as valid evidence", () => {
  const observed = snapshot({
    capturedAt: "2026-07-29T06:01:19.000Z",
    oracleAgeMs: 2_000,
  });
  const candidate = advanceEntryScannerState({}, observed, { confirmations: 3 });
  const terminal = terminalizeEntryScannerState(
    candidate,
    119,
    "2026-07-29T06:01:20.000Z",
    { confirmations: 3 },
  );

  assert.equal(terminal.latestSnapshot.capturedAt, observed.capturedAt);
  assert.equal(terminal.latestSnapshot.oracleAgeMs, 3_000);
  assert.equal(normalizeEntryScannerResult(terminal).dataStatus, "READY");
  assert.equal(terminal.failedGates.some((failure) => failure.id === "STALE_ORACLE"), false);
});

test("terminalization without a valid observation finishes as unavailable", () => {
  const terminal = terminalizeEntryScannerState(
    { status: "watching", requiredConfirmations: 2 },
    119,
    "2026-07-29T06:01:20.000Z",
  );

  assert.equal(terminal.status, "skipped");
  assert.equal(terminal.terminalCapturedAt, "2026-07-29T06:01:20.000Z");
  assert.equal(normalizeEntryScannerResult(terminal).dataStatus, "UNAVAILABLE");
  assert.equal(terminal.failedGates.some((failure) => failure.id === "MISSING_ORACLE"), true);
});

test("scanner restart reset clears terminal state and stale per-item session fields", () => {
  const item = {
    entryScanner: {
      status: "no_chase",
      outcome: "NO_CHASE",
      signal: { direction: "DOWN" },
      latestSnapshot: { capturedAt: "2026-07-29T06:01:10.000Z" },
      failedGates: [{ id: "SIGNAL_TTL" }],
    },
    entrySignalTriggered: true,
    snipeFired: true,
    isEvSkipped: true,
    dynamicScanInFlight: true,
    snipeFiredAtRemainingSeconds: 120,
    dynamicLastScanAt: 1234,
    isLateFired: true,
  };

  resetEntryScannerItem(item, 3);

  assert.deepEqual(item.entryScanner, {
    status: "waiting",
    confirmationCount: 0,
    requiredConfirmations: 3,
  });
  assert.equal(item.entrySignalTriggered, false);
  assert.equal(item.snipeFired, false);
  assert.equal(item.isEvSkipped, false);
  assert.equal(item.dynamicScanInFlight, false);
  assert.equal("snipeFiredAtRemainingSeconds" in item, false);
  assert.equal("dynamicLastScanAt" in item, false);
  assert.equal("isLateFired" in item, false);
});

test("normalized terminal result exposes data and confirmation evidence for renderers", () => {
  const candidate = advanceEntryScannerState({}, snapshot({ forecastDirection: "UP" }), { confirmations: 3 });
  const expired = advanceEntryScannerState(candidate, snapshot({
    capturedAt: "2026-07-29T06:02:31.000Z",
    remainingSeconds: 119,
    forecastDirection: "DOWN",
  }), { confirmations: 3 });
  const result = normalizeEntryScannerResult(expired);

  assert.equal(result.outcome, "NO_ENTRY");
  assert.equal(result.diagnosticLean, "DOWN");
  assert.equal(result.dataStatus, "READY");
  assert.equal(result.maxConfirmationCount, 1);
  assert.equal(result.requiredConfirmations, 3);
  assert.equal(result.reason, "No valid edge before scan window ended.");
});

test("normalized watching result exposes current exact failed gates", () => {
  const watching = advanceEntryScannerState({}, snapshot({
    forecastDirection: "UP",
    sides: {
      UP: { fairProbability: 59, ask: 0.45, netEvCents: 10 },
      DOWN: { fairProbability: 41, ask: 0.56, netEvCents: -19 },
    },
  }));
  const result = normalizeEntryScannerResult(watching);

  assert.equal(result.completed, false);
  assert.deepEqual(result.failedGates.map((failure) => failure.message), [
    "Fair probability must be at least 60%.",
  ]);
});

test("missing remaining time stays unavailable and non-terminal while preserving evidence", () => {
  for (const remainingSeconds of [null, undefined, ""]) {
    const candidate = advanceEntryScannerState({}, snapshot(), { confirmations: 3 });
    const unavailableSnapshot = snapshot({
      capturedAt: "2026-07-29T06:01:05.000Z",
      remainingSeconds,
      sides: {
        UP: { fairProbability: 62, ask: 0.5, netEvCents: 8 },
        DOWN: { fairProbability: 38, ask: 0.51, netEvCents: -17 },
      },
    });
    const assessment = assessEntrySnapshot(unavailableSnapshot);
    const state = advanceEntryScannerState(candidate, unavailableSnapshot, { confirmations: 3 });

    assert.equal(assessment.status, "watching");
    assert.equal(assessment.dataStatus, "UNAVAILABLE");
    assert.equal(state.status, "watching");
    assert.notEqual(state.outcome, "NO_ENTRY");
    assert.equal(state.bestObserved, candidate.bestObserved);
    assert.equal(state.maxConfirmationCount, 1);
  }
});

test("missing remaining time does not revoke an issued entry signal", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const unavailable = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    remainingSeconds: null,
  }));

  assert.equal(unavailable.status, "entry");
  assert.equal(unavailable.outcome, "ENTRY");
  assert.equal(unavailable.signal, entry.signal);
  assert.equal(unavailable.latestAssessment.dataStatus, "UNAVAILABLE");
});

test("missing remaining time does not bypass entry TTL expiry", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const expired = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:16.000Z",
    remainingSeconds: null,
  }));

  assert.equal(expired.status, "no_chase");
  assert.equal(expired.outcome, "NO_CHASE");
  assert.match(expired.reason, /expired/i);
  assert.deepEqual(normalizeEntryScannerResult(expired).failedGates.map((failure) => failure.message), [
    "Entry signal expired before use.",
  ]);
});

test("missing remaining time does not bypass entry ask and edge revalidation", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z" }));
  const lostEdge = advanceEntryScannerState(entry, snapshot({
    capturedAt: "2026-07-29T06:01:06.000Z",
    remainingSeconds: null,
    sides: {
      UP: { fairProbability: 72, ask: 0.61, netEvCents: 7 },
      DOWN: { fairProbability: 28, ask: 0.4, netEvCents: -16 },
    },
  }));

  assert.equal(lostEdge.status, "no_chase");
  assert.equal(lostEdge.outcome, "NO_CHASE");
  assert.equal(lostEdge.reason, "Issued UP side no longer qualifies.");
});

test("exact best-observed ties use direction rather than ingestion order", () => {
  const upObserved = snapshot({
    sides: {
      UP: { fairProbability: 70, ask: 0.5, netEvCents: 16 },
      DOWN: { fairProbability: 30, ask: 0.51, netEvCents: -25 },
    },
  });
  const downObserved = snapshot({
    sides: {
      UP: { fairProbability: 30, ask: 0.51, netEvCents: -25 },
      DOWN: { fairProbability: 70, ask: 0.5, netEvCents: 16 },
    },
  });
  const upThenDown = advanceEntryScannerState(
    advanceEntryScannerState({}, upObserved, { confirmations: 9 }),
    downObserved,
    { confirmations: 9 }
  );
  const downThenUp = advanceEntryScannerState(
    advanceEntryScannerState({}, downObserved, { confirmations: 9 }),
    upObserved,
    { confirmations: 9 }
  );

  assert.equal(upThenDown.bestObserved.direction, "DOWN");
  assert.equal(downThenUp.bestObserved.direction, "DOWN");
});

test("missing oracle age is unavailable with MISSING_ORACLE instead of STALE_ORACLE", () => {
  for (const oracleAgeMs of [null, undefined, ""]) {
    const assessment = assessEntrySnapshot(snapshot({ oracleAgeMs }));
    const gateIds = assessment.sides.UP.failedGates.map((failure) => failure.id);

    assert.equal(assessment.dataStatus, "UNAVAILABLE");
    assert.equal(gateIds.includes("MISSING_ORACLE"), true);
    assert.equal(gateIds.includes("STALE_ORACLE"), false);
  }

  const stale = assessEntrySnapshot(snapshot({ oracleAgeMs: 15_001 }));
  assert.equal(stale.dataStatus, "STALE");
  assert.equal(stale.sides.UP.failedGates.some((failure) => failure.id === "STALE_ORACLE"), true);
  assert.equal(stale.sides.UP.failedGates.some((failure) => failure.id === "MISSING_ORACLE"), false);
});

test("qualification thresholds are inclusive at every exact boundary", () => {
  const cases = [
    ["MIN_FAIR_PROBABILITY", snapshot({
      sides: { UP: { fairProbability: 60, ask: 0.45, netEvCents: 11 } },
    })],
    ["MIN_NET_EV", snapshot({
      sides: { UP: { fairProbability: 72, ask: 0.6, netEvCents: 8 } },
    })],
    ["MAX_ASK", snapshot({
      sides: { UP: { fairProbability: 100, ask: 0.65, netEvCents: 31 } },
    })],
    ["STALE_ORACLE", snapshot({ oracleAgeMs: 15_000 })],
  ];

  for (const [boundaryGate, boundarySnapshot] of cases) {
    const assessment = assessEntrySnapshot(boundarySnapshot);
    assert.equal(assessment.sides.UP.failedGates.some((failure) => failure.id === boundaryGate), false);
    assert.equal(assessment.sides.UP.qualified, true);
  }
});
