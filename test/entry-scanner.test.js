import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ENTRY_SCANNER_CONFIG,
  advanceEntryScannerState,
  qualifyEntrySnapshot,
} from "../public/entry-scanner.js";

function snapshot(overrides = {}) {
  return {
    capturedAt: "2026-07-29T06:01:00.000Z",
    remainingSeconds: 210,
    oracleAgeMs: 2_000,
    marketActive: true,
    acceptingOrders: true,
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
  assert.equal(qualifyEntrySnapshot(snapshot({ remainingSeconds: 250 })).status, "waiting");
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
  assert.match(noChase.reason, /edge|price/i);
});

test("confirmed signal remains valid across scan-stop while its TTL and edge remain valid", () => {
  const candidate = advanceEntryScannerState({}, snapshot({ remainingSeconds: 130 }));
  const entry = advanceEntryScannerState(candidate, snapshot({ capturedAt: "2026-07-29T06:01:05.000Z", remainingSeconds: 125 }));
  const revalidated = advanceEntryScannerState(entry, snapshot({ capturedAt: "2026-07-29T06:01:10.000Z", remainingSeconds: 118 }));

  assert.equal(revalidated.status, "entry");
});

test("transient snapshot errors preserve an existing candidate", () => {
  const candidate = advanceEntryScannerState({}, snapshot());
  const degraded = advanceEntryScannerState(candidate, { error: "temporary CLOB failure" });

  assert.equal(degraded.status, "candidate");
  assert.equal(degraded.confirmationCount, 1);
  assert.equal(degraded.degraded, true);
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
});
