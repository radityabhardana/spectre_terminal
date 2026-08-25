import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import {
  STRICT_OBSERVE_CONTRACT_VERSION,
  STRICT_OBSERVE_PARSER_VERSION,
} from "../src/short-observe-audit.js";
import { createBtc15mObserveCoordinator } from "../src/short-observe-coordinator.js";
import { SHORT_OBSERVE_CRYPTO_FINGERPRINT } from "../src/short-observe-contract.js";
import { parseClobBook } from "../src/short-market-sources.js";

const START_MS = Date.parse("2026-08-25T12:00:00.000Z");
const END_MS = START_MS + 900_000;
const FEED_ID = `0x0002${"a".repeat(60)}`;
// Live RTDS frames carry full_accuracy_value as an E18 fixed-point integer
// string (price * 1e18); Chainlink reports carry plain USD decimals.
const OPENING_USD = "112345.678901234567890123";
const OPENING_VALUE_E18 = "112345678901234567890123";
const BASE_CONFIG = Object.freeze({
  enabled: true,
  expectedChainlinkFeedId: FEED_ID,
  discoveryIntervalMs: 101,
  discoveryLookaheadMs: 900_000,
  discoveryTimeoutMs: 103,
  snapshotIntervalMs: 100_000,
  snapshotTimeoutMs: 107,
  freezeBeforeCloseMs: 20_000,
  lateStartGraceMs: 10_000,
  retries: 1,
  retryBackoffMs: 109,
  leaseTimeoutMs: 120_000,
  shutdownTimeoutMs: 113,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function identity(id = "market-100-a", startMs = START_MS) {
  return {
    eventId: `event-${id}`,
    marketId: id,
    conditionId: `condition-${id}`,
    seriesId: "10192",
    asset: "BTC",
    durationType: "15m",
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(startMs + 900_000).toISOString(),
    startMs,
    endMs: startMs + 900_000,
    cryptoFingerprint: structuredClone(SHORT_OBSERVE_CRYPTO_FINGERPRINT),
    tokenIds: { UP: `token-${id}-up`, DOWN: `token-${id}-down` },
  };
}

function candidate(id = "market-100-a", startMs = START_MS) {
  const marketIdentity = identity(id, startMs);
  const question = `BTC ${id} Up or Down`;
  return {
    identity: marketIdentity,
    question,
    discoveryPayload: {
      event: {
        id: marketIdentity.eventId,
        startTime: marketIdentity.startTime,
        series: [{ id: "10192" }],
        cryptoFingerprint: structuredClone(SHORT_OBSERVE_CRYPTO_FINGERPRINT),
      },
      market: {
        id,
        conditionId: marketIdentity.conditionId,
        question,
        eventStartTime: marketIdentity.startTime,
        endDate: marketIdentity.endTime,
        outcomes: ["Up", "Down"],
        clobTokenIds: [marketIdentity.tokenIds.UP, marketIdentity.tokenIds.DOWN],
      },
    },
  };
}

function registryRecord(item) {
  return {
    ...structuredClone(item.identity),
    question: item.question,
    parserVersion: "strict-identity-parser-v1",
    fingerprintHash: hash(item.identity.cryptoFingerprint),
    discoveryPayloadHash: hash(item.discoveryPayload),
    discoveryPayload: structuredClone(item.discoveryPayload),
  };
}

function persistedConfig(record, config = BASE_CONFIG) {
  return {
    expectedChainlinkFeedId: config.expectedChainlinkFeedId,
    freezeBeforeCloseMs: config.freezeBeforeCloseMs,
    lateStartGraceMs: config.lateStartGraceMs,
    observerContractVersion: STRICT_OBSERVE_CONTRACT_VERSION,
    observerParserVersion: STRICT_OBSERVE_PARSER_VERSION,
    registryReference: {
      discoveryPayloadHash: record.discoveryPayloadHash,
      fingerprintHash: record.fingerprintHash,
      marketId: record.marketId,
      parserVersion: record.parserVersion,
    },
    snapshotIntervalMs: config.snapshotIntervalMs,
  };
}

function rawBook(tokenId, offset = 0) {
  return {
    asset_id: tokenId,
    market: `condition-${tokenId}`,
    timestamp: String(START_MS + 20 + offset),
    bids: [{ price: offset ? "0.46" : "0.47", size: "3.00000000000000000001" }],
    asks: [{ price: offset ? "0.52" : "0.51", size: "4.00000000000000000001" }],
  };
}

function strictBookSource({ calls = [], hook = null } = {}) {
  return async (tokenId, options) => {
    calls.push({ tokenId, ...options });
    if (hook) {
      const hooked = await hook(tokenId, options, calls.length);
      if (hooked !== undefined) return hooked;
    }
    const raw = rawBook(tokenId, options.side === "DOWN" ? 1 : 0);
    return { rawBook: raw, parsed: parseClobBook(raw, tokenId) };
  };
}

function rtdsFrame(timestamp = START_MS, value = OPENING_VALUE_E18) {
  return {
    topic: "crypto_prices_twap_sixty",
    type: "update",
    payload: { symbol: "btc/usd", timestamp, value: 112345.67, full_accuracy_value: value },
  };
}

function chainlinkReport(value = OPENING_USD) {
  return { feedID: FEED_ID, observationsTimestamp: START_MS / 1000, price: value };
}

function boundarySource({ frame = rtdsFrame(), report = null, wait = null, fetchReport = null, order = [] } = {}) {
  const counts = { starts: 0, stops: 0, waits: 0, reports: 0 };
  return {
    counts,
    start() { counts.starts += 1; order.push("source-start"); return true; },
    stop() { counts.stops += 1; order.push("source-stop"); return true; },
    async waitForBoundary(timestamp, signal) {
      counts.waits += 1;
      if (wait) return wait(timestamp, signal);
      return frame;
    },
    async fetchChainlinkReport(timestamp, signal) {
      counts.reports += 1;
      if (fetchReport) return fetchReport(timestamp, signal);
      return report;
    },
  };
}

function fakeTimers() {
  const tasks = new Map();
  let nextId = 1;
  return {
    tasks,
    setTimeout(fn, delay) { const id = nextId++; tasks.set(id, { fn, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    idForDelay(delay) { return [...tasks].find(([, task]) => task.delay === delay)?.[0] ?? null; },
    async fire(id) {
      const task = tasks.get(id);
      assert.ok(task, `timer ${id} must exist`);
      tasks.delete(id);
      await task.fn();
    },
  };
}

function fakeStorage({ order = [] } = {}) {
  const registries = new Map();
  const runs = new Map();
  const attempts = [];
  const appendCalls = [];
  const api = {
    registries,
    runs,
    attempts,
    appendCalls,
    registerCalls: 0,
    enrollCalls: 0,
    appendHook: null,
    registerHook: null,
    enrollHook: null,
    seedRegistry(item = candidate()) {
      const record = registryRecord(item);
      registries.set(record.marketId, record);
      return record;
    },
    seedRun(record, config = BASE_CONFIG, overrides = {}) {
      const run = {
        run_id: `btc-15m-strict:${record.marketId}`,
        enrollment_key: `btc:15m:strict:${record.marketId}`,
        market_id: record.marketId,
        market_question: record.question,
        asset: "BTC",
        duration_type: "15m",
        config_json: JSON.stringify(persistedConfig(record, config)),
        status: "scheduled",
        next_sequence: 0,
        next_scheduled_at: record.startTime,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
        ...overrides,
      };
      runs.set(run.run_id, run);
      return run;
    },
    register(input) {
      api.registerCalls += 1;
      order.push("register");
      if (api.registerHook && api.registerHook(input, api.registerCalls) === false) return null;
      const item = { identity: input.identity, discoveryPayload: input.discoveryPayload, question: input.discoveryPayload.market.question };
      const record = registryRecord(item);
      assert.equal(input.fingerprintHash, record.fingerprintHash);
      assert.equal(input.discoveryPayloadHash, record.discoveryPayloadHash);
      registries.set(record.marketId, record);
      return record;
    },
    getMarket(marketId) { return registries.get(marketId) ?? null; },
    listMarkets({ endAfterMs, startAtOrBeforeMs }) {
      order.push("list-registries");
      return [...registries.values()].filter((record) => record.endMs > endAfterMs && record.startMs <= startAtOrBeforeMs);
    },
    enroll(input) {
      api.enrollCalls += 1;
      order.push("enroll");
      if (api.enrollHook && api.enrollHook(input, api.enrollCalls) === false) return null;
      const existing = [...runs.values()].find((run) => run.enrollment_key === input.enrollmentKey);
      if (existing) return { ...existing };
      const run = {
        run_id: input.runId,
        enrollment_key: input.enrollmentKey,
        market_id: input.marketId,
        market_question: input.marketQuestion,
        asset: input.asset,
        duration_type: input.durationType,
        config_json: JSON.stringify(input.config),
        status: "scheduled",
        next_sequence: 0,
        next_scheduled_at: input.nextScheduledAt,
        lease_owner: null,
        lease_token: null,
        lease_expires_at: null,
      };
      runs.set(run.run_id, run);
      return { ...run };
    },
    listRuns({ status }) { return [...runs.values()].filter((run) => run.status === status).map((run) => ({ ...run })); },
    claim({ runId, leaseOwner, leaseToken, leaseExpiresAt, now }) {
      order.push("claim");
      const run = runs.get(runId);
      if (!run || !["scheduled", "observing"].includes(run.status)
          || (run.lease_token && run.lease_expires_at > now)) return null;
      run.lease_owner = leaseOwner;
      run.lease_token = leaseToken;
      run.lease_expires_at = leaseExpiresAt;
      run.status = "observing";
      return { ...run };
    },
    release({ runId, leaseOwner, leaseToken }) {
      order.push("release");
      const run = runs.get(runId);
      if (!run || run.lease_owner !== leaseOwner || run.lease_token !== leaseToken) return false;
      run.lease_owner = null;
      run.lease_token = null;
      run.lease_expires_at = null;
      return true;
    },
    appendStrict(input) {
      order.push("append-strict");
      appendCalls.push(input);
      const run = runs.get(input.runId);
      if (!run || run.lease_owner !== input.leaseOwner || run.lease_token !== input.leaseToken || run.next_sequence !== input.sequence) return null;
      if (api.appendHook && api.appendHook(input, appendCalls.length) === false) return null;
      attempts.push(input);
      run.next_sequence += 1;
      run.next_scheduled_at = input.nextScheduledAt;
      return attempts.length;
    },
    terminal(input) {
      order.push(`terminal-${input.status}`);
      const run = runs.get(input.runId);
      if (!run || run.lease_owner !== input.leaseOwner || run.lease_token !== input.leaseToken) return null;
      run.status = input.status;
      run.error_code = input.errorCode;
      run.lease_owner = null;
      run.lease_token = null;
      run.lease_expires_at = null;
      return { ...run };
    },
  };
  return api;
}

function clock(value = START_MS) {
  return { value, now() { return this.value; } };
}

function coordinatorFixture({
  now = START_MS,
  config = BASE_CONFIG,
  storage = fakeStorage(),
  source = boundarySource(),
  discover = async () => ({ markets: [candidate()] }),
  fetchBook = strictBookSource(),
  timers = fakeTimers(),
  dependencies = {},
} = {}) {
  const fakeClock = clock(now);
  const coordinator = createBtc15mObserveCoordinator({
    clock: fakeClock,
    timers,
    storage,
    boundarySource: source,
    discover,
    fetchBook,
    assertShortObserverConfig: () => ({ ...config }),
    ...dependencies,
  });
  return { coordinator, clock: fakeClock, timers, storage, source };
}

async function stopFixture(fixture) {
  const stopped = fixture.coordinator.stop();
  if (stopped && typeof stopped.then === "function") await stopped;
}

function assertNoActionContent(value) {
  const forbiddenKey = /(recommendation|actionable|candidate|entry|play|stake|selected.?side|side.?selection|public|publication|publish)/i;
  const forbiddenValue = /\b(?:ENTRY|PLAY|PUBLIC|CANDIDATE)\b/i;
  if (Array.isArray(value)) return value.forEach(assertNoActionContent);
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.equal(forbiddenKey.test(key), false, key);
      assertNoActionContent(item);
    }
  } else if (typeof value === "string") {
    assert.equal(forbiddenValue.test(value), false, value);
  }
}

test("disabled coordinator has zero source, discovery, timer, or storage side effects", async () => {
  const timers = fakeTimers();
  const storage = fakeStorage();
  let constructions = 0;
  let discoveries = 0;
  const coordinator = createBtc15mObserveCoordinator({
    timers,
    storage,
    assertShortObserverConfig: () => ({ enabled: false }),
    createBoundarySource: () => { constructions += 1; return boundarySource(); },
    discover: async () => { discoveries += 1; return { markets: [] }; },
  });
  assert.equal(await coordinator.start(), false);
  assert.equal(constructions, 0);
  assert.equal(discoveries, 0);
  assert.equal(timers.tasks.size, 0);
  assert.equal(storage.registerCalls, 0);
  assert.equal(storage.enrollCalls, 0);
  assert.equal(storage.appendCalls.length, 0);
  assert.equal(coordinator.stop(), false);
});

test("enabled lifecycle constructs and starts boundary source once before discovery, then stops once after drain", async () => {
  const order = [];
  const storage = fakeStorage({ order });
  let constructions = 0;
  const source = boundarySource({ order });
  const coordinator = createBtc15mObserveCoordinator({
    clock: clock(START_MS - 1),
    timers: fakeTimers(),
    storage,
    assertShortObserverConfig: () => ({ ...BASE_CONFIG }),
    createBoundarySource: () => { constructions += 1; order.push("source-construct"); return source; },
    discover: async () => { order.push("discover"); return { markets: [] }; },
    fetchBook: strictBookSource(),
  });
  const firstStart = coordinator.start();
  const secondStart = coordinator.start();
  await Promise.all([firstStart, secondStart]);
  await coordinator.start();
  assert.equal(constructions, 1);
  assert.equal(source.counts.starts, 1);
  assert.ok(order.indexOf("source-start") < order.indexOf("discover"));
  await coordinator.stop();
  assert.equal(source.counts.stops, 1);
  assert.equal(order.at(-1), "source-stop");
});

test("dark discovery registers before enrollment and registration failure never enrolls", async () => {
  const order = [];
  const storage = fakeStorage({ order });
  const fixture = coordinatorFixture({ now: START_MS, storage, source: boundarySource({ order }) });
  await fixture.coordinator.start();
  assert.equal(storage.registerCalls, 1);
  assert.equal(storage.enrollCalls, 1);
  assert.equal(storage.attempts.length, 1);
  assert.ok(order.indexOf("register") < order.indexOf("enroll"));
  const run = [...storage.runs.values()][0];
  const saved = JSON.parse(run.config_json);
  assert.deepEqual(Object.keys(saved).sort(), [
    "expectedChainlinkFeedId", "freezeBeforeCloseMs", "lateStartGraceMs", "observerContractVersion",
    "observerParserVersion", "registryReference", "snapshotIntervalMs",
  ].sort());
  for (const forbiddenIdentity of ["eventId", "conditionId", "tokenIds", "startMs", "endMs", "market"]) assert.equal(forbiddenIdentity in saved, false);
  await stopFixture(fixture);

  const rejectedStorage = fakeStorage();
  rejectedStorage.registerHook = () => false;
  const rejected = coordinatorFixture({ now: START_MS - 1, storage: rejectedStorage });
  await rejected.coordinator.start();
  assert.equal(rejectedStorage.registerCalls, 1);
  assert.equal(rejectedStorage.enrollCalls, 0);
  assert.equal(rejectedStorage.runs.size, 0);
  await stopFixture(rejected);
});

test("registry enumeration recovers a crash between registration and enrollment on the next tick", async () => {
  const storage = fakeStorage();
  storage.enrollHook = (_input, call) => call !== 1;
  let discoveryCalls = 0;
  const fixture = coordinatorFixture({
    now: START_MS - 1,
    storage,
    discover: async () => ({ markets: discoveryCalls++ === 0 ? [candidate()] : [] }),
  });
  await fixture.coordinator.start();
  assert.equal(storage.registries.size, 1);
  assert.equal(storage.runs.size, 0);
  await fixture.coordinator.tick();
  assert.equal(storage.runs.size, 1);
  assert.equal(storage.enrollCalls, 2);
  await stopFixture(fixture);
});

test("rediscovery, discovery omission, and discovery error neither block nor duplicate persisted runs", async () => {
  for (const discover of [
    async () => ({ markets: [candidate()] }),
    async () => ({ markets: [] }),
    async () => { throw new Error("Gamma unavailable"); },
  ]) {
    const storage = fakeStorage();
    const record = storage.seedRegistry();
    storage.seedRun(record);
    const fixture = coordinatorFixture({ storage, discover });
    await fixture.coordinator.start();
    assert.equal(storage.attempts.length, 1);
    await stopFixture(fixture);
  }

});

test("persisted due work completes before Gamma timeout advances the clock beyond late grace", async () => {
  const config = { ...BASE_CONFIG, discoveryTimeoutMs: 20_000, lateStartGraceMs: 10_000 };
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("slow-discovery"));
  const run = storage.seedRun(record, config);
  const observedAt = [];
  const fixture = coordinatorFixture({
    config,
    storage,
    discover: async () => new Promise(() => {}),
    fetchBook: strictBookSource({ hook: () => { observedAt.push(fixture.clock.value); return undefined; } }),
  });
  const starting = fixture.coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(storage.attempts.length, 1);
  assert.deepEqual(observedAt, [START_MS, START_MS]);
  assert.notEqual(run.status, "missed");
  const firstTick = fixture.coordinator.tick();
  const overlappingTick = fixture.coordinator.tick();
  assert.strictEqual(overlappingTick, firstTick);

  const timeout = fixture.timers.idForDelay(config.discoveryTimeoutMs);
  assert.notEqual(timeout, null);
  fixture.clock.value += config.discoveryTimeoutMs;
  await fixture.timers.fire(timeout);
  await Promise.all([starting, firstTick]);
  assert.ok(fixture.clock.value > START_MS + config.lateStartGraceMs);
  assert.equal(storage.attempts.length, 1);
  assert.notEqual(run.status, "missed");
  await stopFixture(fixture);
});

test("every run reloads canonical registry tokens and missing or mismatched registry references terminalize invalid", async () => {
  const calls = [];
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("authority"));
  const run = storage.seedRun(record);
  const fixture = coordinatorFixture({ storage, discover: async () => ({ markets: [] }), fetchBook: strictBookSource({ calls }) });
  await fixture.coordinator.start();
  assert.deepEqual(calls.map((call) => call.tokenId), [record.tokenIds.UP, record.tokenIds.DOWN]);
  assert.equal(JSON.stringify(JSON.parse(run.config_json)).includes(record.tokenIds.UP), false);
  await stopFixture(fixture);

  for (const mutation of [
    (candidateStorage, candidateRun) => candidateStorage.registries.delete(candidateRun.market_id),
    (_candidateStorage, candidateRun) => {
      const saved = JSON.parse(candidateRun.config_json);
      saved.registryReference.discoveryPayloadHash = "f".repeat(64);
      candidateRun.config_json = JSON.stringify(saved);
    },
    (_candidateStorage, candidateRun) => {
      candidateRun.next_scheduled_at = new Date(START_MS + 1).toISOString();
    },
  ]) {
    const candidateStorage = fakeStorage();
    const candidateRecord = candidateStorage.seedRegistry(candidate(`invalid-${candidateStorage.runs.size}`));
    const candidateRun = candidateStorage.seedRun(candidateRecord);
    mutation(candidateStorage, candidateRun);
    let fetched = 0;
    const invalid = coordinatorFixture({
      storage: candidateStorage,
      discover: async () => ({ markets: [] }),
      fetchBook: async () => { fetched += 1; },
    });
    await invalid.coordinator.start();
    assert.equal(candidateRun.status, "invalid");
    assert.equal(fetched, 0);
    await stopFixture(invalid);
  }
});

test("strict direct books validate UP and DOWN asset IDs and never checkpoint malformed token evidence", async () => {
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("book-token"));
  const run = storage.seedRun(record);
  let calls = 0;
  const fixture = coordinatorFixture({
    storage,
    discover: async () => ({ markets: [] }),
    fetchBook: strictBookSource({
      hook: (tokenId, options) => {
        calls += 1;
        const raw = rawBook(options.side === "UP" ? record.tokenIds.DOWN : tokenId, options.side === "DOWN" ? 1 : 0);
        return { rawBook: raw, parsed: parseClobBook(raw, tokenId) };
      },
    }),
  });
  const starting = fixture.coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  const backoff = fixture.timers.idForDelay(BASE_CONFIG.retryBackoffMs);
  assert.notEqual(backoff, null);
  await fixture.timers.fire(backoff);
  await starting;
  assert.equal(calls, 4);
  assert.equal(storage.attempts.length, 0);
  assert.equal(run.next_sequence, 0);
  assert.equal(run.lease_token, null);
  await stopFixture(fixture);
});

test("opening selector persists exact RTDS, exact Chainlink fallback, data gap, and disagreement quarantine without erasing books", async () => {
  const cases = [
    { source: boundarySource({ frame: rtdsFrame(), report: null }), status: "OK", expectedSource: "RTDS", value: OPENING_USD },
    { source: boundarySource({ frame: null, report: chainlinkReport() }), status: "OK", expectedSource: "CHAINLINK_FALLBACK", value: OPENING_USD },
    { source: boundarySource({ frame: null, report: null }), status: "DATA_GAP", expectedSource: null, value: null },
    { source: boundarySource({ frame: rtdsFrame(), report: chainlinkReport("112345.678901234567890124") }), status: "QUARANTINED", expectedSource: null, value: null },
  ];
  for (const item of cases) {
    const storage = fakeStorage();
    const record = storage.seedRegistry(candidate(`opening-${item.status.toLowerCase()}-${item.expectedSource || "none"}`));
    storage.seedRun(record);
    const fixture = coordinatorFixture({ storage, source: item.source, discover: async () => ({ markets: [] }) });
    await fixture.coordinator.start();
    const attempt = storage.attempts[0];
    assert.equal(attempt.auditPayload.openingEvidence.status, item.status);
    assert.equal(attempt.auditPayload.openingEvidence.source, item.expectedSource);
    assert.equal(attempt.auditPayload.openingEvidence.value, item.value);
    assert.equal(attempt.evidence[0].status, item.status);
    assert.equal(attempt.evidence.filter((evidence) => evidence.kind === "ORDER_BOOK").length, 2);
    assert.ok(attempt.auditPayload.authoritativeSnapshot.books.UP);
    assert.ok(attempt.auditPayload.authoritativeSnapshot.books.DOWN);
    await stopFixture(fixture);
  }
});

test("one atomic strict storage call carries three evidence records; rollback leaves the sequence retryable", async () => {
  const order = [];
  const storage = fakeStorage({ order });
  const record = storage.seedRegistry(candidate("atomic"));
  const run = storage.seedRun(record);
  storage.appendHook = (_input, call) => call !== 1;
  const fixture = coordinatorFixture({ storage, discover: async () => ({ markets: [] }) });
  await fixture.coordinator.start();
  assert.equal(storage.appendCalls.length, 1);
  assert.equal(storage.attempts.length, 0);
  assert.equal(run.next_sequence, 0);
  assert.equal(run.lease_token, null);
  await fixture.coordinator.tick();
  assert.equal(storage.appendCalls.length, 2);
  assert.equal(storage.appendCalls[0].sequence, 0);
  assert.equal(storage.appendCalls[1].sequence, 0);
  assert.equal(storage.appendCalls[1].evidence.length, 3);
  assert.equal(storage.attempts.length, 1);
  assert.equal(run.next_sequence, 1);
  assert.ok(order.indexOf("append-strict") < order.lastIndexOf("release"));
  await stopFixture(fixture);
});

test("collector has no legacy evaluator, manual audit, or legacy market/book runtime dependency and emits no action content", async () => {
  const sourceText = await fs.readFile(new URL("../src/short-observe-coordinator.js", import.meta.url), "utf8");
  for (const forbiddenDependency of [
    "getShortTermMarkets", "getOrderBook", "chainlinkSourceSpec", "evaluateShortMarketCondition", "buildObserveOnlyCollectorAudit",
  ]) assert.equal(sourceText.includes(forbiddenDependency), false, forbiddenDependency);

  let legacyCalls = 0;
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("no-legacy"));
  storage.seedRun(record);
  const fixture = coordinatorFixture({
    storage,
    discover: async () => ({ markets: [] }),
    dependencies: {
      evaluate: () => { legacyCalls += 1; return { recommendation: "PLAY" }; },
      getOrderBook: () => { legacyCalls += 1; },
    },
  });
  await fixture.coordinator.start();
  assert.equal(legacyCalls, 0);
  assert.deepEqual(storage.attempts[0].auditPayload.ai, { requested: false, status: "disabled", used: false });
  assertNoActionContent(storage.attempts[0].auditPayload);
  await stopFixture(fixture);
});

test("bounded collection retries with the fixed sequence and honors backoff", async () => {
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("retry"));
  storage.seedRun(record);
  let failures = 0;
  const calls = [];
  const fetchBook = strictBookSource({
    calls,
    hook: (_token, options) => {
      if (options.side === "UP" && failures++ === 0) throw Object.assign(new Error("temporary CLOB failure"), { code: "temporary_clob" });
      return undefined;
    },
  });
  const fixture = coordinatorFixture({ storage, discover: async () => ({ markets: [] }), fetchBook });
  const starting = fixture.coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  const backoff = fixture.timers.idForDelay(BASE_CONFIG.retryBackoffMs);
  assert.notEqual(backoff, null);
  await fixture.timers.fire(backoff);
  await starting;
  assert.equal(storage.attempts.length, 1);
  assert.equal(storage.attempts[0].sequence, 0);
  assert.ok(calls.length >= 3);
  await stopFixture(fixture);
});

test("freeze and late grace remain fail-closed without book backfill", async () => {
  const freezeStorage = fakeStorage();
  const freezeRecord = freezeStorage.seedRegistry(candidate("freeze"));
  const freezeRun = freezeStorage.seedRun(freezeRecord);
  let signals = [];
  const freezeFixture = coordinatorFixture({
    storage: freezeStorage,
    discover: async () => ({ markets: [] }),
    fetchBook: async (_token, { signal }) => {
      signals.push(signal);
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const pending = freezeFixture.coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  const freezeAt = END_MS - BASE_CONFIG.freezeBeforeCloseMs;
  const freezeTimer = freezeFixture.timers.idForDelay(freezeAt - START_MS);
  assert.notEqual(freezeTimer, null);
  freezeFixture.clock.value = freezeAt;
  await freezeFixture.timers.fire(freezeTimer);
  await pending;
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(freezeRun.status, "missed");
  assert.equal(freezeStorage.attempts.length, 0);
  await stopFixture(freezeFixture);

  const lateStorage = fakeStorage();
  const lateRecord = lateStorage.seedRegistry(candidate("late"));
  const lateRun = lateStorage.seedRun(lateRecord);
  let fetched = 0;
  const lateFixture = coordinatorFixture({
    now: START_MS + BASE_CONFIG.lateStartGraceMs + 1,
    storage: lateStorage,
    discover: async () => ({ markets: [] }),
    fetchBook: async () => { fetched += 1; },
  });
  await lateFixture.coordinator.start();
  assert.equal(fetched, 0);
  assert.equal(lateRun.status, "missed");
  assert.equal(lateRun.error_code, "missed_slot");
  await stopFixture(lateFixture);
});

test("restart retains persisted timing policy while an active foreign lease prevents overlap", async () => {
  const storage = fakeStorage();
  let discoveryCalls = 0;
  const initial = coordinatorFixture({
    now: START_MS - 1,
    storage,
    config: { ...BASE_CONFIG, lateStartGraceMs: 10_000 },
    discover: async () => ({ markets: discoveryCalls++ === 0 ? [candidate("restart")] : [] }),
  });
  await initial.coordinator.start();
  await stopFixture(initial);

  const restart = coordinatorFixture({
    now: START_MS + 5_000,
    storage,
    config: { ...BASE_CONFIG, lateStartGraceMs: 1 },
    discover: async () => ({ markets: [] }),
  });
  await restart.coordinator.start();
  assert.equal(storage.attempts.length, 1);
  await stopFixture(restart);

  const leasedStorage = fakeStorage();
  const leasedRecord = leasedStorage.seedRegistry(candidate("leased"));
  leasedStorage.seedRun(leasedRecord, BASE_CONFIG, {
    status: "observing",
    lease_owner: "other-worker",
    lease_token: "other-token",
    lease_expires_at: new Date(START_MS + 60_000).toISOString(),
  });
  let leasedFetches = 0;
  const leased = coordinatorFixture({
    storage: leasedStorage,
    discover: async () => ({ markets: [] }),
    fetchBook: async () => { leasedFetches += 1; },
  });
  await leased.coordinator.start();
  assert.equal(leasedFetches, 0);
  assert.equal(leasedStorage.attempts.length, 0);
  await stopFixture(leased);
});

test("shutdown aborts and drains an active attempt before stopping the boundary source and releasing its lease", async () => {
  const order = [];
  const storage = fakeStorage({ order });
  const record = storage.seedRegistry(candidate("shutdown"));
  const run = storage.seedRun(record);
  const source = boundarySource({ order });
  let active = 0;
  const fixture = coordinatorFixture({
    storage,
    source,
    discover: async () => ({ markets: [] }),
    fetchBook: async (_token, { signal }) => {
      active += 1;
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => { active -= 1; reject(signal.reason); }, { once: true }));
    },
  });
  const starting = fixture.coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 2);
  const stopping = fixture.coordinator.stop();
  await Promise.all([starting, stopping]);
  assert.equal(active, 0);
  assert.equal(run.lease_token, null);
  assert.equal(source.counts.stops, 1);
  assert.ok(order.indexOf("release") < order.indexOf("source-stop"));
});

test("capturedAt is taken after completed I/O rather than before collection", async () => {
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("capture-time"));
  storage.seedRun(record);
  const fakeClock = clock(START_MS);
  const calls = [];
  const fetchBook = strictBookSource({
    calls,
    hook: (_token, options) => {
      if (options.side === "DOWN") fakeClock.value = START_MS + 42;
      return undefined;
    },
  });
  const fixture = coordinatorFixture({ storage, discover: async () => ({ markets: [] }), fetchBook });
  fixture.clock.value = fakeClock.value;
  const originalNow = fixture.clock.now.bind(fixture.clock);
  fixture.clock.now = () => fakeClock.value;
  await fixture.coordinator.start();
  assert.equal(storage.attempts[0].capturedAt, new Date(START_MS + 42).toISOString());
  assert.equal(storage.attempts[0].auditPayload.authoritativeSnapshot.capturedAt, new Date(START_MS + 42).toISOString());
  fixture.clock.now = originalNow;
  await stopFixture(fixture);
});

test("resolution retries use deterministic attempt-scoped idempotency for unchanged close evidence", async () => {
  const storage = fakeStorage();
  const record = storage.seedRegistry(candidate("resolution-retry-key"));
  const pending = { ...record, resolutionEvidence: [] };
  const batches = [];
  let pendingQuery = null;
  storage.listRuns = () => [];
  storage.listMarkets = () => [];
  storage.listPendingResolution = (query) => {
    pendingQuery = query;
    return pending.resolutionEvidence.some((item) => item.status === "RESOLVED") ? [] : [pending];
  };
  storage.appendResolution = ({ evidence }) => {
    batches.push(evidence);
    const resolution = evidence.find((item) => item.kind === "RESOLUTION");
    pending.resolutionEvidence.push({
      status: resolution.status,
      receivedTimestampMs: resolution.receivedTimestampMs,
    });
    return evidence.length;
  };

  const closeFrame = rtdsFrame(END_MS, "11234567890123456789012300");
  const source = boundarySource({ frame: null, report: null });
  source.getBoundary = (timestamp) => timestamp === END_MS ? closeFrame : null;
  const resolutionSource = {
    starts: 0,
    stops: 0,
    watchCalls: 0,
    start() { this.starts += 1; },
    stop() { this.stops += 1; },
    watchMarket() { this.watchCalls += 1; },
    unwatchMarket() {},
    getResolution() { return null; },
  };
  let gammaCalls = 0;
  const gamma = {
    id: record.marketId,
    conditionId: record.conditionId,
    closed: true,
    umaResolutionStatus: "resolved",
    outcomes: ["Up", "Down"],
    clobTokenIds: [record.tokenIds.UP, record.tokenIds.DOWN],
    outcomePrices: ["0.5", "0.5"],
  };
  const resolvedGamma = { ...gamma, outcomePrices: ["1", "0"] };
  const fixture = coordinatorFixture({
    now: END_MS,
    config: { ...BASE_CONFIG, resolutionIntervalMs: 1, resolutionTimeoutMs: 1, resolutionGraceMs: 100 },
    storage,
    source,
    discover: async () => ({ markets: [] }),
    dependencies: {
      resolutionSource,
      fetchGammaTerminal: async () => ({ market: gammaCalls++ === 0 ? gamma : resolvedGamma }),
    },
  });

  await fixture.coordinator.start();
  assert.equal(pendingQuery.endAtOrAfterMs, END_MS - 100);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].status, "OK");
  assert.equal(batches[0][1].status, "UNRESOLVED");

  await fixture.coordinator.tick();
  assert.equal(batches.length, 2);
  assert.notEqual(batches[0][0].idempotencyKey, batches[1][0].idempotencyKey);
  assert.notEqual(batches[0][1].idempotencyKey, batches[1][1].idempotencyKey);
  assert.equal(batches[1][0].canonicalHash, batches[0][0].canonicalHash);
  assert.equal(batches[1][1].status, "RESOLVED");
  assert.equal(batches[1][1].outcome, "UP");
  assert.equal(pending.resolutionEvidence.at(-1).status, "RESOLVED");
  assert.equal(gammaCalls, 2);
  assert.equal(resolutionSource.watchCalls, 1);
  await stopFixture(fixture);
});
