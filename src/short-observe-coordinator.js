import { randomUUID } from "node:crypto";
import { assertShortObserverConfig } from "./config.js";
import { getShortTermMarkets, getOrderBook } from "./polymarket.js";
import {
  buildObserveOnlyCollectorAudit,
  chainlinkSourceSpec,
  evaluateShortMarketCondition,
} from "./short_condition.js";
import {
  enrollShortObservationRun,
  getShortObservationRuns,
  claimShortObservationRun,
  releaseShortObservationRun,
  appendShortEvaluationSnapshotAttempt,
  terminalizeShortObservationRun,
} from "./storage.js";

const DURATION_TYPE = "15m";
const ASSET = "BTC";
const DEFAULT_OWNER = "btc-15m-observe-coordinator";
const COLLECTOR_CONTEXT = Object.freeze({ kind: "btc15m_observe_collector", collectionMode: "observe_only" });
const ATTEMPT_STATUSES = new Set(["completed", "failed", "cancelled", "missed"]);

function clockNow(clock) {
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  return Number(value == null ? Date.now() : value);
}

function iso(value) { return new Date(value).toISOString(); }

function abortError(code = "freeze_window") {
  const error = new Error(code === "shutdown_cancelled" ? "observe attempt cancelled by shutdown" : "observe attempt aborted");
  error.name = "AbortError";
  error.code = code;
  return error;
}

function tokenMapping(market) {
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
  const ids = Array.isArray(market?.clobTokenIds) ? market.clobTokenIds.map(String) : [];
  const upIndex = outcomes.findIndex((item) => String(item).trim().toUpperCase() === "UP");
  const downIndex = outcomes.findIndex((item) => String(item).trim().toUpperCase() === "DOWN");
  const UP = upIndex >= 0 ? ids[upIndex] : null;
  const DOWN = downIndex >= 0 ? ids[downIndex] : null;
  if (!UP || !DOWN || UP === DOWN) return null;
  return { UP, DOWN };
}

function canonicalMarket(market) {
  if (!market || String(market.asset || ASSET).toUpperCase() !== ASSET
      || String(market.durationType || market.duration_type) !== DURATION_TYPE) return null;
  const id = String(market.id || "").trim();
  const question = String(market.question || "");
  const startMs = Date.parse(market.startDate || "");
  const endMs = Date.parse(market.endDate || "");
  const tokens = tokenMapping(market);
  const source = chainlinkSourceSpec(market.resolutionSource, ASSET);
  if (!id || !question || market.enableOrderBook !== true || !Number.isFinite(startMs)
      || !Number.isFinite(endMs) || endMs <= startMs || !tokens || !source) return null;
  return { market, id, question, startMs, endMs, tokens, source };
}

function timerDefaults(timers = {}) {
  return {
    setTimeout: timers.setTimeout || globalThis.setTimeout,
    clearTimeout: timers.clearTimeout || globalThis.clearTimeout,
  };
}

function defaultStorage(overrides = {}) {
  return {
    enroll: overrides.enroll || overrides.enrollShortObservationRun || enrollShortObservationRun,
    list: overrides.list || overrides.getShortObservationRuns || getShortObservationRuns,
    claim: overrides.claim || overrides.claimShortObservationRun || claimShortObservationRun,
    release: overrides.release || overrides.releaseShortObservationRun || releaseShortObservationRun,
    appendAttempt: overrides.appendAttempt || overrides.appendShortEvaluationSnapshotAttempt || overrides.appendCollectorAttempt || appendShortEvaluationSnapshotAttempt,
    terminal: overrides.terminal || overrides.terminalizeShortObservationRun || terminalizeShortObservationRun,
  };
}

function defaultDiscovery({ clock, signal }) {
  return getShortTermMarkets("btc", { durationTypes: [DURATION_TYPE], clock: () => clockNow(clock), signal });
}

async function defaultObserve({ tokenIds, getBook, signal }) {
  const [UP, DOWN] = await Promise.all([
    getBook(tokenIds.UP, signal),
    getBook(tokenIds.DOWN, signal),
  ]);
  if (!UP || !DOWN) throw new Error("both orderbooks are required");
  return { books: { UP, DOWN } };
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function bestPrice(levels, direction) {
  const prices = (Array.isArray(levels) ? levels : []).map((level) => numeric(level?.price ?? level?.[0])).filter((value) => value != null);
  if (!prices.length) return null;
  return direction === "min" ? Math.min(...prices) : Math.max(...prices);
}

function marketPrices(books) {
  const upBid = bestPrice(books?.UP?.bids, "max");
  const downBid = bestPrice(books?.DOWN?.bids, "max");
  const upAsk = bestPrice(books?.UP?.asks, "min");
  const downAsk = bestPrice(books?.DOWN?.asks, "min");
  return {
    upAsk,
    downAsk,
    upTokenAsk: upAsk,
    downTokenAsk: downAsk,
    upMidpoint: upAsk == null || upBid == null ? null : (upAsk + upBid) / 2,
    downMidpoint: downAsk == null || downBid == null ? null : (downAsk + downBid) / 2,
  };
}

function parseRunConfig(run) {
  try {
    const value = typeof run?.config_json === "string" ? JSON.parse(run.config_json) : run?.config_json;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function storedMarket(run) {
  const config = parseRunConfig(run);
  const snapshot = config?.market;
  if (!snapshot) return null;
  const savedTokens = snapshot.clobTokenIds || snapshot.clob_token_ids || {};
  return canonicalMarket({
    ...snapshot,
    id: run.market_id,
    question: run.market_question,
    asset: run.asset,
    durationType: run.duration_type,
    outcomes: ["UP", "DOWN"],
    clobTokenIds: [savedTokens.UP || savedTokens.up, savedTokens.DOWN || savedTokens.down],
    resolutionSource: snapshot.resolutionSource || snapshot.resolution_source,
    enableOrderBook: snapshot.enableOrderBook !== false,
  });
}

function sameIdentity(meta, run) {
  if (!meta || String(run.market_id) !== meta.id || String(run.market_question) !== meta.question
      || String(run.asset).toUpperCase() !== ASSET || String(run.duration_type) !== DURATION_TYPE) return false;
  const saved = storedMarket(run);
  if (!saved) return true;
  return saved.id === meta.id && saved.question === meta.question
    && saved.startMs === meta.startMs && saved.endMs === meta.endMs
    && saved.tokens.UP === meta.tokens.UP && saved.tokens.DOWN === meta.tokens.DOWN
    && saved.source.kind === meta.source.kind && saved.source.windowSeconds === meta.source.windowSeconds;
}

function snapshotConfig(meta, config) {
  return {
    asset: ASSET,
    durationType: DURATION_TYPE,
    snapshotIntervalMs: config.snapshotIntervalMs,
    freezeBeforeCloseMs: config.freezeBeforeCloseMs,
    lateStartGraceMs: config.lateStartGraceMs,
    market: {
      id: meta.id,
      question: meta.question,
      startDate: meta.market.startDate,
      endDate: meta.market.endDate,
      enableOrderBook: true,
      outcomes: ["UP", "DOWN"],
      clobTokenIds: { UP: meta.tokens.UP, DOWN: meta.tokens.DOWN },
      resolutionSource: meta.market.resolutionSource,
    },
  };
}

export function createBtc15mObserveCoordinator(dependencies = {}) {
  const timers = timerDefaults(dependencies.timers || dependencies);
  const clock = dependencies.clock || { now: () => Date.now() };
  const storage = defaultStorage(dependencies.storage);
  const discover = dependencies.discover || dependencies.discovery || dependencies.discoverMarkets || defaultDiscovery;
  const customObserve = dependencies.observe || dependencies.observeMarket;
  const observe = customObserve || defaultObserve;
  const getBook = dependencies.getOrderBook || getOrderBook;
  const evaluate = dependencies.evaluate || dependencies.evaluator || dependencies.evaluateShortMarketCondition
    || evaluateShortMarketCondition;
  const validateConfig = dependencies.assertShortObserverConfig || assertShortObserverConfig;
  const owner = String(dependencies.owner || DEFAULT_OWNER);
  const state = {
    started: false, starting: null, timer: null, activeAttempt: false, attemptController: null,
    tickInFlight: false, tickPromise: null, stopPromise: null, activeRun: null, activeLease: null,
    marketById: new Map(), discovered: 0, lastError: null,
  };

  function runConfig() {
    state.config = validateConfig();
    return state.config;
  }

  function schedule(delay) {
    if (!state.started || state.timer != null) return;
    state.timer = timers.setTimeout(async () => {
      state.timer = null;
      try { await tick(); } catch (error) { state.lastError = error; }
      schedule(delayForNextWork());
    }, Math.max(0, delay));
  }

  function delayForNextWork() {
    const config = state.config;
    if (!config) return 60_000;
    return Math.max(1, Math.min(config.discoveryIntervalMs, config.snapshotIntervalMs));
  }

  function runInterval(run) {
    const saved = parseRunConfig(run);
    return Number(saved?.snapshotIntervalMs) || state.config.snapshotIntervalMs;
  }

  function runFreeze(run) {
    const saved = parseRunConfig(run);
    return Number(saved?.freezeBeforeCloseMs) || state.config.freezeBeforeCloseMs;
  }

  function runLateGrace(run) {
    const saved = parseRunConfig(run);
    const persisted = Number(saved?.lateStartGraceMs);
    return Number.isFinite(persisted) && persisted >= 0 ? persisted : state.config.lateStartGraceMs;
  }

  function firstSlot(run) {
    const value = Date.parse(run?.next_scheduled_at || "");
    return Number.isFinite(value) ? value : NaN;
  }

  function lastSequence(meta, run) {
    const freezeAt = meta.endMs - runFreeze(run);
    return Math.max(0, Math.floor((freezeAt - meta.startMs) / runInterval(run)));
  }

  function runIdentity(meta) {
    return {
      runId: `btc-15m:${meta.id}`,
      enrollmentKey: `btc:15m:${meta.id}`,
      marketId: meta.id,
      marketQuestion: meta.question,
      asset: ASSET,
      durationType: DURATION_TYPE,
    };
  }

  function auditPayload(meta, run, now, status, errorCode, books, evaluation, collectedData) {
    return buildObserveOnlyCollectorAudit({
      market: meta.market,
      tokenIds: meta.tokens,
      books,
      evaluation,
      collectedData,
      capturedAt: iso(now),
      scheduledAt: run.next_scheduled_at,
      status,
      errorCode,
      sourceVerified: true,
    });
  }

  function normalizeAttemptStatus(status) {
    const normalized = String(status || "").toLowerCase();
    if (ATTEMPT_STATUSES.has(normalized)) return normalized;
    if (["complete", "success", "succeeded", "observed"].includes(normalized)) return "completed";
    if (["abort", "aborted"].includes(normalized)) return "cancelled";
    return "failed";
  }

  function terminalizeInvalidRun(run, now, errorCode) {
    now = clockNow(clock);
    const leaseToken = randomUUID();
    const lease = storage.claim({
      runId: run.run_id,
      leaseOwner: owner,
      leaseToken,
      leaseExpiresAt: iso(now + state.config.leaseTimeoutMs),
      now: iso(now),
    });
    if (!lease) return false;
    const terminal = storage.terminal({
      runId: run.run_id,
      status: "invalid",
      errorCode,
      leaseOwner: owner,
      leaseToken: lease.lease_token,
      now: iso(now),
      terminalAt: iso(now),
    });
    if (!terminal) throw new Error("collector invalidation failed");
    return true;
  }

  async function enrollMarkets(markets, now) {
    const lookaheadAt = now + state.config.discoveryLookaheadMs;
    for (const market of Array.isArray(markets) ? markets : []) {
      const meta = canonicalMarket(market);
      if (!meta || market.active !== true || market.closed === true) continue;
      if (meta.startMs > lookaheadAt || meta.endMs <= now) continue;
      const identity = runIdentity(meta);
      const run = storage.enroll({
        ...identity,
        config: snapshotConfig(meta, state.config),
        nextScheduledAt: iso(meta.startMs),
        createdAt: iso(now),
        updatedAt: iso(now),
      });
      if (run) state.discovered += 1;
    }
  }

  async function waitRetry(delay, signal) {
    if (!(delay > 0)) return;
    await new Promise((resolve, reject) => {
      let timer = timers.setTimeout(() => {
        timer = null;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        if (timer != null) timers.clearTimeout(timer);
        timer = null;
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  function discoveryWithTimeout(now) {
    const controller = new AbortController();
    const parentSignal = state.discoveryController?.signal;
    const onParentAbort = () => controller.abort(parentSignal.reason || abortError("shutdown_cancelled"));
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const discovery = Promise.resolve().then(() => discover({
      durationTypes: [DURATION_TYPE], clock, now, signal: controller.signal,
    }));
    const timeout = state.config.discoveryTimeoutMs;
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        timer = null;
        controller.abort(new Error("discovery timeout"));
        reject(Object.assign(new Error("discovery timeout"), { code: "discovery_timeout" }));
      }, timeout);
    });
    return Promise.race([discovery, deadline]).finally(() => {
      if (timer != null) timers.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    });
  }

  async function collect(meta, startedAt, freezeAt, controller) {
    let lastError = null;
    for (let attempt = 0; attempt <= state.config.retries; attempt += 1) {
      // Never carry a book or a model result from an earlier attempt.
      let books = null;
      if (clockNow(clock) >= freezeAt) {
        return { status: "cancelled", errorCode: "freeze_window", books: null, evaluation: null };
      }
      const attemptController = new AbortController();
      let snapshotReject;
      const onParentAbort = () => {
        const reason = controller.signal.reason || abortError("freeze_window");
        attemptController.abort(reason);
        snapshotReject?.(reason);
      };
      controller.signal.addEventListener("abort", onParentAbort, { once: true });
      let snapshotTimer = null;
      const snapshotDeadline = new Promise((_, reject) => { snapshotReject = reject; });
      if (controller.signal.aborted) onParentAbort();
      try {
        snapshotTimer = timers.setTimeout(() => {
          const error = Object.assign(new Error("snapshot timeout"), { code: "snapshot_timeout" });
          attemptController.abort(error);
          snapshotReject(error);
        }, state.config.snapshotTimeoutMs);
        const attemptNow = clockNow(clock);
        if (attemptNow >= freezeAt) return { status: "cancelled", errorCode: "freeze_window", books: null, evaluation: null };
        const observed = await Promise.race([
          Promise.resolve().then(() => observe({ market: meta.market, tokenIds: meta.tokens, getBook, signal: attemptController.signal, now: attemptNow })),
          snapshotDeadline,
        ]);
        books = observed?.books || observed;
        if (!books?.UP || !books?.DOWN) throw new Error("both orderbooks are required");
        if (attemptController.signal.aborted) throw attemptController.signal.reason || abortError("freeze_window");
        const prices = marketPrices(books);
        const evaluation = await Promise.race([
          Promise.resolve().then(() => evaluate({
            signal: attemptController.signal,
            marketId: meta.id,
            asset: ASSET,
            marketQuestion: meta.question,
            durationType: DURATION_TYPE,
            startDate: meta.market.startDate,
            endDate: meta.market.endDate,
            resolutionSource: meta.market.resolutionSource,
            marketActive: meta.market.active === true,
            marketClosed: meta.market.closed === true,
            acceptingOrders: meta.market.acceptingOrders !== false,
            ...prices,
            books,
            collectorContext: COLLECTOR_CONTEXT,
            includeAiExplanation: false,
            nowMs: attemptNow,
          })),
          snapshotDeadline,
        ]);
        if (attemptController.signal.aborted) throw attemptController.signal.reason || abortError("freeze_window");
        if (clockNow(clock) >= freezeAt) return { status: "cancelled", errorCode: "freeze_window", books: null, evaluation: null };
        return { status: "completed", errorCode: null, books, evaluation };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) break;
        const current = clockNow(clock);
        if (current >= freezeAt) return { status: "cancelled", errorCode: "freeze_window", books: null, evaluation: null };
        if (attempt < state.config.retries) {
          try {
            await waitRetry(state.config.retryBackoffMs, controller.signal);
          } catch (retryError) {
            lastError = retryError;
            break;
          }
          if (clockNow(clock) >= freezeAt) return { status: "cancelled", errorCode: "freeze_window", books: null, evaluation: null };
        }
      } finally {
        if (snapshotTimer != null) timers.clearTimeout(snapshotTimer);
        controller.signal.removeEventListener("abort", onParentAbort);
      }
    }
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      return { status: "cancelled", errorCode: reason?.code || "freeze_window", books: null, evaluation: null };
    }
    return {
      status: "failed",
      errorCode: String(lastError?.code || "collector_failed"),
      books: null,
      evaluation: null,
    };
  }

  async function writeAttempt(meta, run, now, startedAt, result, lease) {
    const sequence = Number(run.next_sequence);
    const nextScheduledAt = iso(firstSlot(run) + runInterval(run));
    return storage.appendAttempt({
      runId: run.run_id,
      sequence,
      marketId: meta.id,
      marketQuestion: meta.question,
      durationType: DURATION_TYPE,
      asset: ASSET,
      capturedAt: iso(now),
      scheduledAt: run.next_scheduled_at,
      nextScheduledAt,
      startedAt: iso(startedAt),
      finishedAt: iso(now),
      collectionMode: "observe_only",
      attemptStatus: normalizeAttemptStatus(result.status),
      errorCode: result.errorCode,
      auditPayload: auditPayload(meta, run, now, result.status, result.errorCode, result.books, result.evaluation, result.evaluation),
      leaseOwner: owner,
      leaseToken: lease.lease_token,
      now: iso(now),
    });
  }

  async function processRun(run, now) {
    if (state.activeAttempt) return false;
    now = clockNow(clock);
    const scheduledAt = firstSlot(run);
    if (!Number.isFinite(scheduledAt) || now < scheduledAt) return false;

    const discovered = state.marketById.get(String(run.market_id));
    const discoveredMeta = discovered ? canonicalMarket(discovered) : null;
    if (discovered && !discoveredMeta) {
      return terminalizeInvalidRun(run, now, "market_identity_mismatch");
    }
    const meta = discoveredMeta || storedMarket(run);
    if (!meta) return terminalizeInvalidRun(run, now, "stored_market_invalid");
    // A current discovery with the same id is not sufficient.  Revalidate all
    // persisted identity fields before using its books.
    if (discovered && !sameIdentity(meta, run)) {
      return terminalizeInvalidRun(run, now, "market_identity_mismatch");
    }

    const freezeAt = meta.endMs - runFreeze(run);
    now = clockNow(clock);
    if (now < scheduledAt) return false;
    const leaseToken = randomUUID();
    const lease = storage.claim({ runId: run.run_id, leaseOwner: owner, leaseToken, leaseExpiresAt: iso(now + state.config.leaseTimeoutMs), now: iso(now) });
    if (!lease) return false;
    now = clockNow(clock);
    state.activeAttempt = true;
    state.activeRun = run;
    state.activeLease = lease;
    const controller = new AbortController();
    state.attemptController = controller;
    let freezeTimer = null;
    const late = now > scheduledAt + runLateGrace(run);
    const frozen = scheduledAt >= freezeAt || now >= freezeAt;
    if (!frozen) freezeTimer = timers.setTimeout(() => controller.abort(abortError("freeze_window")), freezeAt - now);
    const startedAt = now;
    try {
      let result;
      if (late) {
        result = { status: "missed", errorCode: "missed_slot", books: null, evaluation: null };
      } else if (frozen) {
        result = { status: "cancelled", errorCode: "freeze_window", books: null, evaluation: null };
      } else {
        result = await collect(meta, now, freezeAt, controller);
      }
      const written = await writeAttempt(meta, run, clockNow(clock), startedAt, result, lease);
      if (written == null) throw new Error("collector attempt persistence failed");
      const sequence = Number(run.next_sequence);
      const terminalStatus = result.errorCode === "shutdown_cancelled"
        ? null
        : result.status === "missed" || result.status === "cancelled"
          ? "missed"
          : sequence >= lastSequence(meta, run) ? "completed" : null;
      if (terminalStatus) {
        const terminal = storage.terminal({
          runId: run.run_id,
          status: terminalStatus,
          errorCode: result.errorCode,
          leaseOwner: owner,
          leaseToken: lease.lease_token,
          now: iso(clockNow(clock)),
          terminalAt: iso(clockNow(clock)),
        });
        if (!terminal) throw new Error("collector terminalization failed");
      } else {
        const released = storage.release({ runId: run.run_id, leaseOwner: owner, leaseToken: lease.lease_token, now: iso(clockNow(clock)) });
        if (!released) throw new Error("collector lease release failed");
      }
      return true;
    } finally {
      if (freezeTimer != null) timers.clearTimeout(freezeTimer);
      state.attemptController = null;
      state.activeRun = null;
      state.activeLease = null;
      state.activeAttempt = false;
    }
  }

  async function runTick() {
    if (!state.started || !state.config?.enabled || state.tickInFlight) return false;
    state.tickInFlight = true;
    try {
      const now = clockNow(clock);
      let markets = null;
      try {
        markets = await discoveryWithTimeout(now);
        if (state.started) {
          const discovered = new Map((Array.isArray(markets) ? markets : []).map((market) => [String(market.id), market]));
          state.marketById = new Map([...state.marketById, ...discovered]);
          await enrollMarkets(markets, clockNow(clock));
        }
      } catch (error) {
        state.lastError = error;
        // Discovery is advisory after enrollment. Persisted runs continue from
        // their stored snapshot or the last valid cached market metadata.
      }
      if (!state.started) return false;
      const runs = [
        ...storage.list({ status: "scheduled", limit: 1000 }),
        ...storage.list({ status: "observing", limit: 1000 }),
      ];
      for (const run of runs) {
        if (state.activeAttempt) break;
        await processRun(run, clockNow(clock));
      }
      return true;
    } finally {
      state.tickInFlight = false;
    }
  }

  function tick() {
    if (state.tickPromise) return state.tickPromise;
    const promise = runTick();
    state.tickPromise = promise;
    const clearPromise = () => {
      if (state.tickPromise === promise) state.tickPromise = null;
    };
    promise.then(clearPromise, clearPromise);
    return promise;
  }

  async function start() {
    if (state.started) return state.starting || true;
    const config = runConfig();
    if (!config.enabled) return false;
    state.started = true;
    state.discoveryController = new AbortController();
    state.starting = tick().finally(() => {
      state.starting = null;
      schedule(delayForNextWork());
    });
    await state.starting;
    return true;
  }

  function stop() {
    if (state.stopPromise) return state.stopPromise;
    if (!state.started && state.timer == null && !state.tickPromise) return false;
    state.started = false;
    if (state.timer != null) { timers.clearTimeout(state.timer); state.timer = null; }
    state.discoveryController?.abort(abortError("shutdown_cancelled"));
    state.attemptController?.abort(abortError("shutdown_cancelled"));
    state.discoveryController = null;
    const drain = (async () => {
      const pending = state.tickPromise;
      if (!pending) return true;
      let shutdownTimer = null;
      const shutdownDeadline = new Promise((_, reject) => {
        shutdownTimer = timers.setTimeout(() => reject(new Error("shutdown timeout")), state.config?.shutdownTimeoutMs || 1);
      });
      try {
        await Promise.race([pending, shutdownDeadline]);
        return true;
      } catch (error) {
        state.lastError = error;
        if (state.activeRun && state.activeLease) {
          const released = storage.release({ runId: state.activeRun.run_id, leaseOwner: owner, leaseToken: state.activeLease.lease_token, now: iso(clockNow(clock)) });
          if (!released) throw new Error("collector shutdown lease release failed");
        }
        return false;
      } finally {
        if (shutdownTimer != null) timers.clearTimeout(shutdownTimer);
      }
    })();
    state.stopPromise = drain.finally(() => { state.stopPromise = null; });
    return state.stopPromise;
  }

  return { start, stop, tick, getState: () => ({ ...state }) };
}

const moduleCoordinator = createBtc15mObserveCoordinator();
export async function startBtc15mObserveCollector() { return moduleCoordinator.start(); }
export function stopBtc15mObserveCollector() { return moduleCoordinator.stop(); }
