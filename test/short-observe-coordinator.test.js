import assert from "node:assert/strict";
import test from "node:test";
import { createBtc15mObserveCoordinator } from "../src/short-observe-coordinator.js";

const config = {
  enabled: true,
  discoveryIntervalMs: 100,
  discoveryLookaheadMs: 100,
  discoveryTimeoutMs: 100,
  snapshotIntervalMs: 100,
  snapshotTimeoutMs: 100,
  freezeBeforeCloseMs: 20,
  lateStartGraceMs: 10,
  retries: 0,
  retryBackoffMs: 1,
  leaseTimeoutMs: 1000,
  shutdownTimeoutMs: 100,
};

function market(id = "m-1", start = 1_000, end = 1_500) {
  return {
    id, question: `BTC ${id} Up or Down`, asset: "btc", durationType: "15m",
    startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(),
    active: true, closed: false, enableOrderBook: true, resolutionSource: "https://data.chain.link/streams/btc-usd",
    outcomes: ["Up", "Down"], clobTokenIds: [`${id}-up`, `${id}-down`],
  };
}

function fakeTimers() {
  const timers = new Map(); let nextId = 1;
  return {
    timers,
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async fire(id) { const item = timers.get(id); if (!item) return; timers.delete(id); await item.fn(); },
  };
}

function fakeStorage() {
  const runs = new Map(); const attempts = [];
  return {
    runs, attempts,
    enroll(input) {
      const existing = [...runs.values()].find((run) => run.enrollment_key === input.enrollmentKey || (run.market_id === input.marketId && run.duration_type === input.durationType && run.asset === input.asset));
      if (existing) return existing;
      const run = { run_id: input.runId, enrollment_key: input.enrollmentKey, market_id: input.marketId, market_question: input.marketQuestion, asset: input.asset, duration_type: input.durationType, config_json: JSON.stringify(input.config), status: "scheduled", next_sequence: 0, next_scheduled_at: input.nextScheduledAt, lease_token: null, lease_owner: null, lease_expires_at: null };
      runs.set(run.run_id, run); return run;
    },
    list({ status }) { return [...runs.values()].filter((run) => run.status === status).map((run) => ({ ...run })); },
    claim({ runId, leaseOwner, leaseToken, leaseExpiresAt, now }) {
      const run = runs.get(runId); if (!run || !["scheduled", "observing"].includes(run.status) || (run.lease_token && run.lease_expires_at > now)) return null;
      run.lease_owner = leaseOwner; run.lease_token = leaseToken; run.lease_expires_at = leaseExpiresAt; run.status = "observing"; return { ...run };
    },
    release({ runId, leaseOwner, leaseToken }) { const run = runs.get(runId); if (!run || run.lease_owner !== leaseOwner || run.lease_token !== leaseToken) return false; run.lease_owner = run.lease_token = run.lease_expires_at = null; return true; },
    appendAttempt(input) {
      const run = runs.get(input.runId); if (!run || run.lease_owner !== input.leaseOwner || run.lease_token !== input.leaseToken || run.next_sequence !== input.sequence) return null;
      attempts.push(input); run.next_sequence += 1; run.next_scheduled_at = input.nextScheduledAt; return attempts.length;
    },
    terminal(input) { const run = runs.get(input.runId); if (!run || run.lease_owner !== input.leaseOwner || run.lease_token !== input.leaseToken) return null; run.status = input.status; run.lease_owner = run.lease_token = run.lease_expires_at = null; return { ...run }; },
  };
}

function collectorEvaluation() {
  return {
    deterministicSnapshot: {
      currentPrice: 100_000,
      priceToBeat: 99_900,
      oraclePublishTime: "1970-01-01T00:00:01.000Z",
      capturedAt: "1970-01-01T00:00:01.000Z",
      startDate: "1970-01-01T00:00:01.000Z",
      endDate: "1970-01-01T00:00:01.500Z",
      upAsk: 0.52,
      downAsk: 0.48,
    },
  };
}

function books() {
  return { UP: { bids: [{ price: "0.50" }], asks: [{ price: "0.52" }] }, DOWN: { bids: [{ price: "0.46" }], asks: [{ price: "0.48" }] } };
}

test("disabled coordinator is a no-op with no timer, discovery, or enrollment", async () => {
  const clock = { value: 0, now() { return this.value; } }; const timers = fakeTimers(); let discovered = 0; const storage = fakeStorage();
  const coordinator = createBtc15mObserveCoordinator({ clock, timers, storage, assertShortObserverConfig: () => ({ enabled: false }) , discover: async () => { discovered += 1; return []; } });
  assert.equal(await coordinator.start(), false); assert.equal(discovered, 0); assert.equal(timers.timers.size, 0); assert.equal(storage.runs.size, 0); assert.equal(coordinator.stop(), false);
});

test("enabled coordinator discovers only 15m BTC markets and idempotently enrolls", async () => {
  const clock = { value: 900, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); const calls = []; let observations = 0;
  const m = market();
  const coordinator = createBtc15mObserveCoordinator({ clock, timers, storage, assertShortObserverConfig: () => config, discover: async (options) => { calls.push(options.durationTypes); return [m, { ...m, id: "bad", outcomes: ["Yes", "No"] }]; }, observe: async () => { observations += 1; return { books: { UP: { bids: [], asks: [] }, DOWN: { bids: [], asks: [] } } }; } });
  await coordinator.start(); await coordinator.tick();
  assert.deepEqual(calls[0], ["15m"]); assert.equal(storage.runs.size, 1); assert.equal(observations, 0); assert.equal(await coordinator.start(), true); coordinator.stop();
});

test("fixed sequence advances without overlap and publication stays observe-only", async () => {
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let release; let active = 0; let maxActive = 0;
  const coordinator = createBtc15mObserveCoordinator({ clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => [market()], observe: async ({ signal }) => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); }); active -= 1; return { books: books() }; }, evaluate: async () => collectorEvaluation() });
  const starting = coordinator.start(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 1); assert.equal(storage.attempts.length, 0); release(); await starting;
  assert.equal(storage.attempts[0].sequence, 0); assert.equal(storage.attempts[0].auditPayload.collector, "observe_only");
  assert.equal(Object.keys(storage.attempts[0].auditPayload).some((key) => ["recommendation", "actionable", "selected"].includes(key)), false); assert.equal(maxActive, 1); coordinator.stop();
});

test("late discovery records a missed slot without backfilling observation", async () => {
  const clock = { value: 1_200, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let observations = 0;
  const coordinator = createBtc15mObserveCoordinator({ clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => [market()], observe: async () => { observations += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation() });
  await coordinator.start();
  assert.equal(storage.attempts[0].attemptStatus, "missed"); assert.equal(observations, 0); assert.equal(storage.attempts[0].sequence, 0); assert.equal(storage.runs.get("btc-15m:m-1").next_sequence, 1); assert.equal(storage.runs.get("btc-15m:m-1").status, "missed"); coordinator.stop();
});

test("valid observations call the deterministic evaluator once with both books and persist a strict projection", async () => {
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); const calls = [];
  const coordinator = createBtc15mObserveCoordinator({
    clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => [market()], observe: async () => ({ books: books() }),
    evaluate: async (input) => {
      calls.push(input);
      return {
        ...collectorEvaluation(),
        evaluation: {
          recommendation: "PLAY", actionable: true, selectedSide: "UP", publicCandidate: "PUBLIC CANDIDATE ENTRY PLAY",
        },
      };
    },
  });
  await coordinator.start();
  assert.equal(calls.length, 1); assert.equal(calls[0].includeAiExplanation, false); assert.deepEqual(calls[0].books, books());
  assert.equal(storage.attempts.length, 1);
  const serialized = JSON.stringify(storage.attempts[0].auditPayload).toLowerCase();
  for (const forbidden of ["recommendation", "actionable", "selected", "entry", "play", "public", "candidate"]) assert.equal(serialized.includes(forbidden), false);
  coordinator.stop();
});

test("stored runs recover when the newest discovery response omits their market", async () => {
  const storage = fakeStorage(); const initialTimers = fakeTimers(); const initialClock = { value: 900, now() { return this.value; } };
  const initial = createBtc15mObserveCoordinator({ clock: initialClock, timers: initialTimers, storage, assertShortObserverConfig: () => config, discover: async () => [market()] });
  await initial.start(); initial.stop();
  const recoveryTimers = fakeTimers(); const recoveryClock = { value: 1_000, now() { return this.value; } }; let observations = 0;
  const recovered = createBtc15mObserveCoordinator({
    clock: recoveryClock, timers: recoveryTimers, storage, assertShortObserverConfig: () => config, discover: async () => [],
    observe: async () => { observations += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation(),
  });
  await recovered.start();
  assert.equal(observations, 1); assert.equal(storage.attempts.length, 1); assert.equal(storage.attempts[0].sequence, 0);
  recovered.stop();
});

test("retries an observation before persisting, retaining its fixed sequence", async () => {
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let observations = 0;
  const coordinator = createBtc15mObserveCoordinator({
    clock, timers, storage, assertShortObserverConfig: () => ({ ...config, retries: 1, retryBackoffMs: 0 }), discover: async () => [market()],
    observe: async () => { observations += 1; if (observations === 1) throw new Error("temporary"); return { books: books() }; },
    evaluate: async () => collectorEvaluation(),
  });
  await coordinator.start();
  assert.equal(observations, 2); assert.equal(storage.attempts.length, 1); assert.equal(storage.attempts[0].sequence, 0); assert.equal(storage.runs.get("btc-15m:m-1").next_sequence, 1);
  coordinator.stop();
});

test("freeze aborts an in-flight attempt and records cancellation", async () => {
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let observedSignal;
  const coordinator = createBtc15mObserveCoordinator({ clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => [market()], observe: async ({ signal }) => { observedSignal = signal; await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); throw new Error("aborted"); } });
  const pending = coordinator.start(); await new Promise((resolve) => setImmediate(resolve)); clock.value = 1_480; const freezeTimer = [...timers.timers.entries()].find(([, item]) => item.delay === 480)?.[0]; assert.ok(freezeTimer); await timers.fire(freezeTimer); await pending;
  assert.equal(observedSignal.aborted, true); assert.equal(storage.attempts[0].attemptStatus, "cancelled"); coordinator.stop();
});

test("refreshes after discovery so a stale tick cannot start after freeze", async () => {
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let observations = 0;
  const coordinator = createBtc15mObserveCoordinator({
    clock, timers, storage, assertShortObserverConfig: () => config,
    discover: async () => { clock.value = 1_490; return [market()]; },
    observe: async () => { observations += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation(),
  });
  await coordinator.start();
  assert.equal(observations, 0); assert.equal(storage.attempts[0].attemptStatus, "missed"); assert.equal(storage.attempts[0].errorCode, "missed_slot");
  coordinator.stop();
});

test("late slots within grace collect, while slots beyond grace are terminal missed", async () => {
  const withinClock = { value: 1_005, now() { return this.value; } }; const withinStorage = fakeStorage(); const withinTimers = fakeTimers(); let withinObserved = 0;
  const within = createBtc15mObserveCoordinator({
    clock: withinClock, timers: withinTimers, storage: withinStorage, assertShortObserverConfig: () => config,
    discover: async () => [market()], observe: async () => { withinObserved += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation(),
  });
  await within.start();
  assert.equal(withinObserved, 1); assert.equal(withinStorage.attempts[0].attemptStatus, "completed"); within.stop();

  const beyondClock = { value: 1_011, now() { return this.value; } }; const beyondStorage = fakeStorage(); const beyondTimers = fakeTimers(); let beyondObserved = 0;
  const beyond = createBtc15mObserveCoordinator({
    clock: beyondClock, timers: beyondTimers, storage: beyondStorage, assertShortObserverConfig: () => config,
    discover: async () => [market()], observe: async () => { beyondObserved += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation(),
  });
  await beyond.start();
  assert.equal(beyondObserved, 0); assert.equal(beyondStorage.attempts[0].attemptStatus, "missed"); assert.equal(beyondStorage.runs.get("btc-15m:m-1").status, "missed"); beyond.stop();
});

test("discovery timeout or error still processes persisted runs from stored metadata", async () => {
  const storage = fakeStorage(); const seededClock = { value: 900, now() { return this.value; } }; const seededTimers = fakeTimers();
  const seeded = createBtc15mObserveCoordinator({ clock: seededClock, timers: seededTimers, storage, assertShortObserverConfig: () => config, discover: async () => [market()] });
  await seeded.start(); seeded.stop();
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); let observed = 0;
  const recovered = createBtc15mObserveCoordinator({
    clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => new Promise(() => {}),
    observe: async () => { observed += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation(),
  });
  const pending = recovered.start();
  const timeout = [...timers.timers.entries()].find(([, item]) => item.delay === config.discoveryTimeoutMs)?.[0]; assert.ok(timeout);
  await timers.fire(timeout); await pending;
  assert.equal(observed, 1); assert.equal(storage.attempts[0].sequence, 0); recovered.stop();

  const errorStorage = fakeStorage(); const errorSeed = createBtc15mObserveCoordinator({ clock: seededClock, timers: fakeTimers(), storage: errorStorage, assertShortObserverConfig: () => config, discover: async () => [market()] });
  await errorSeed.start(); errorSeed.stop(); let errorObserved = 0;
  const errored = createBtc15mObserveCoordinator({ clock, timers: fakeTimers(), storage: errorStorage, assertShortObserverConfig: () => config, discover: async () => { throw new Error("discovery unavailable"); }, observe: async () => { errorObserved += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation() });
  await errored.start(); assert.equal(errorObserved, 1); errored.stop();
});

test("snapshot timeout retries with the same sequence and honors retry backoff", async () => {
  const retryConfig = { ...config, retries: 1, retryBackoffMs: 7 }; const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let observed = 0;
  const coordinator = createBtc15mObserveCoordinator({
    clock, timers, storage, assertShortObserverConfig: () => retryConfig, discover: async () => [market()],
    observe: async () => { observed += 1; return new Promise(() => {}); }, evaluate: async () => collectorEvaluation(),
  });
  const pending = coordinator.start(); await new Promise((resolve) => setImmediate(resolve));
  let timeout = [...timers.timers.entries()].find(([, item]) => item.delay === retryConfig.snapshotTimeoutMs)?.[0]; assert.ok(timeout); await timers.fire(timeout); await new Promise((resolve) => setImmediate(resolve));
  const backoff = [...timers.timers.entries()].find(([, item]) => item.delay === retryConfig.retryBackoffMs)?.[0]; assert.ok(backoff); await timers.fire(backoff); await new Promise((resolve) => setImmediate(resolve));
  timeout = [...timers.timers.entries()].find(([, item]) => item.delay === retryConfig.snapshotTimeoutMs)?.[0]; assert.ok(timeout); await timers.fire(timeout); await pending;
  assert.equal(observed, 2); assert.equal(storage.attempts[0].attemptStatus, "failed"); assert.equal(storage.attempts[0].errorCode, "snapshot_timeout"); assert.equal(storage.attempts[0].sequence, 0);
  coordinator.stop();
});

test("stop drains an active attempt and persists shutdown_cancelled before releasing its lease", async () => {
  const clock = { value: 1_000, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage(); let signal;
  const coordinator = createBtc15mObserveCoordinator({
    clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => [market()],
    observe: async ({ signal: currentSignal }) => { signal = currentSignal; await new Promise((resolve) => currentSignal.addEventListener("abort", resolve, { once: true })); throw currentSignal.reason; },
    evaluate: async () => collectorEvaluation(),
  });
  const starting = coordinator.start(); await new Promise((resolve) => setImmediate(resolve)); const stopping = coordinator.stop();
  await Promise.all([starting, stopping]);
  assert.equal(signal.aborted, true); assert.equal(storage.attempts[0].attemptStatus, "cancelled"); assert.equal(storage.attempts[0].errorCode, "shutdown_cancelled"); assert.equal(storage.runs.get("btc-15m:m-1").lease_token, null);
});

test("lease release or terminalization failure rejects processing", async () => {
  const releaseClock = { value: 1_000, now() { return this.value; } }; const releaseTimers = fakeTimers(); const releaseStorage = fakeStorage(); releaseStorage.release = () => false;
  const releaseCoordinator = createBtc15mObserveCoordinator({ clock: releaseClock, timers: releaseTimers, storage: releaseStorage, assertShortObserverConfig: () => config, discover: async () => [market( "release", 1_000, 2_000)], observe: async () => ({ books: books() }), evaluate: async () => collectorEvaluation() });
  await assert.rejects(releaseCoordinator.start(), /lease release failed/); await releaseCoordinator.stop();

  const terminalClock = { value: 1_000, now() { return this.value; } }; const terminalTimers = fakeTimers(); const terminalStorage = fakeStorage(); terminalStorage.terminal = () => null;
  const terminalCoordinator = createBtc15mObserveCoordinator({ clock: terminalClock, timers: terminalTimers, storage: terminalStorage, assertShortObserverConfig: () => config, discover: async () => [market("terminal", 1_000, 1_100)], observe: async () => ({ books: books() }), evaluate: async () => collectorEvaluation() });
  await assert.rejects(terminalCoordinator.start(), /terminalization failed/); await terminalCoordinator.stop();
});

test("discovery lookahead prevents enrollment of markets outside the horizon", async () => {
  const clock = { value: 900, now() { return this.value; } }; const timers = fakeTimers(); const storage = fakeStorage();
  const coordinator = createBtc15mObserveCoordinator({ clock, timers, storage, assertShortObserverConfig: () => config, discover: async () => [market("future", 999, 1_500), market("too-far", 1_001 + config.discoveryLookaheadMs + 1, 1_600)] });
  await coordinator.start();
  assert.equal(storage.runs.has("btc-15m:future"), true); assert.equal(storage.runs.has("btc-15m:too-far"), false); coordinator.stop();
});

test("restart keeps the persisted late-grace policy when global config changes", async () => {
  const storage = fakeStorage(); const initialClock = { value: 900, now() { return this.value; } };
  const initialConfig = { ...config, lateStartGraceMs: 10 };
  const initial = createBtc15mObserveCoordinator({ clock: initialClock, timers: fakeTimers(), storage, assertShortObserverConfig: () => initialConfig, discover: async () => [market()] });
  await initial.start(); initial.stop();

  const restartClock = { value: 1_005, now() { return this.value; } }; const restartTimers = fakeTimers(); let observed = 0;
  const restarted = createBtc15mObserveCoordinator({
    clock: restartClock, timers: restartTimers, storage, assertShortObserverConfig: () => ({ ...config, lateStartGraceMs: 0 }), discover: async () => [],
    observe: async () => { observed += 1; return { books: books() }; }, evaluate: async () => collectorEvaluation(),
  });
  await restarted.start();
  assert.equal(observed, 1); assert.equal(storage.attempts[0].attemptStatus, "completed"); assert.equal(storage.attempts[0].sequence, 0);
  restarted.stop();
});
