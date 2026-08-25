import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import * as storage from "../src/storage.js";
import { enrollShortObservationRun, claimShortObservationRun, appendShortEvaluationSnapshotAttempt, getShortEvaluationSnapshotAttempts, getShortObservationRun, terminalizeShortObservationRun } from "../src/storage.js";

function run() { const id = randomUUID(); return { runId: `run-${id}`, enrollmentKey: `enroll-${id}`, marketId: `market-${id}`, marketQuestion: "BTC 15m observe-only", asset: "BTC", durationType: "15m", config: { b: 2, a: 1 }, nextScheduledAt: "2026-08-24T00:15:00.000Z", createdAt: "2026-08-24T00:00:00.000Z" }; }

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
