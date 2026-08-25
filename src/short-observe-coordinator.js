import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { assertShortObserverConfig } from "./config.js";
import {
  STRICT_OBSERVE_CONTRACT_VERSION,
  STRICT_OBSERVE_MODEL_VERSION,
  STRICT_OBSERVE_PARSER_VERSION,
  buildStrictObserveOnlyAudit,
} from "./short-observe-audit.js";
import {
  SHORT_OBSERVE_ASSET,
  SHORT_OBSERVE_DURATION,
  SHORT_OBSERVE_DURATION_MS,
  SHORT_OBSERVE_SERIES_ID,
} from "./short-observe-contract.js";
import {
  canonicalizeChainlinkFeedId,
  parseClobBook,
  selectBoundaryTwap,
} from "./short-market-sources.js";
import {
  createClobMarketResolutionSource,
  createRtdsBoundarySource,
  discoverOfficialBtc15mMarkets,
  fetchOfficialGammaTerminalMarket,
  fetchOfficialClobBook,
} from "./short-observe-runtime-sources.js";
import { evaluateShortResolution } from "./short-resolution-evaluator.js";
import {
  appendStrictShortObservationAttempt,
  appendShortResolutionEvidenceBatch,
  claimShortObservationRun,
  enrollShortObservationRun,
  getShortObservationRuns,
  getStrictShortMarket,
  listStrictShortMarketsPendingResolution,
  listStrictShortMarketsForObservation,
  registerStrictShortMarket,
  releaseShortObservationRun,
  terminalizeShortObservationRun,
} from "./storage.js";

const DEFAULT_OWNER = "btc-15m-strict-observe-coordinator-v2";
const IDENTITY_PARSER_VERSION = "strict-identity-parser-v1";
const DISCOVERY_EVALUATOR_VERSION = "strict-discovery-v1";
const BOUNDARY_EVALUATOR_VERSION = "strict-boundary-selector-v1";
const BOOK_EVALUATOR_VERSION = "strict-clob-book-v1";
const RESOLUTION_EVALUATOR_VERSION = "strict-resolution-evaluator-v1";
const RESOLUTION_PARSER_VERSION = "strict-resolution-parser-v1";
const MAX_DISCOVERY_MARKETS = 500;
const MAX_RESOLUTION_MARKETS = 100;
const REQUIRED_POSITIVE_CONFIG = Object.freeze([
  "discoveryIntervalMs", "discoveryLookaheadMs", "discoveryTimeoutMs", "snapshotIntervalMs",
  "snapshotTimeoutMs", "freezeBeforeCloseMs", "lateStartGraceMs", "retries",
  "retryBackoffMs", "leaseTimeoutMs", "shutdownTimeoutMs",
]);

function clockNow(clock) {
  const value = typeof clock === "function" ? clock() : clock?.now?.();
  const now = value == null ? Date.now() : value;
  if (!Number.isSafeInteger(now)) throw new TypeError("observer clock must return a safe integer timestamp");
  return now;
}

function iso(value) {
  return new Date(value).toISOString();
}

function abortError(code = "freeze_window") {
  const error = new Error(code === "shutdown_cancelled" ? "strict observe attempt cancelled by shutdown" : "strict observe attempt aborted");
  error.name = "AbortError";
  error.code = code;
  return error;
}

function timerDefaults(timers = {}) {
  return {
    setTimeout: timers.setTimeout || globalThis.setTimeout,
    clearTimeout: timers.clearTimeout || globalThis.clearTimeout,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  const serialized = JSON.stringify(canonicalize(value));
  if (typeof serialized !== "string") throw new TypeError("canonical JSON payload is required");
  return serialized;
}

function hashText(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashPayload(value) {
  return hashText(canonicalJson(value));
}

function exactText(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value ? value : null;
}

function exactHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function exactConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("short observer configuration must be an object");
  if (value.enabled !== true) return { enabled: false };
  const feedId = canonicalizeChainlinkFeedId(value.expectedChainlinkFeedId);
  if (!feedId || feedId !== value.expectedChainlinkFeedId) throw new Error("enabled short observer requires a canonical Chainlink V2 feed ID");
  for (const field of REQUIRED_POSITIVE_CONFIG) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) throw new Error(`${field} must be a positive safe integer`);
  }
  return { ...value, expectedChainlinkFeedId: feedId };
}

function parseRunConfig(run) {
  try {
    const parsed = typeof run?.config_json === "string" ? JSON.parse(run.config_json) : run?.config_json;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictMarket(value, question = null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const registry = value.registry && typeof value.registry === "object" ? value.registry : {};
  const eventId = exactText(value.eventId ?? value.event_id);
  const marketId = exactText(value.marketId ?? value.market_id);
  const conditionId = exactText(value.conditionId ?? value.condition_id);
  const seriesId = value.seriesId ?? value.series_id;
  const asset = String(value.asset || "").toUpperCase();
  const durationType = value.durationType ?? value.duration_type;
  const startMs = value.startMs ?? value.start_time_ms;
  const endMs = value.endMs ?? value.end_time_ms;
  const tokenIds = value.tokenIds;
  const parserVersion = exactText(value.parserVersion ?? value.parser_version ?? registry.parser_version);
  if (!eventId || !marketId || !conditionId || seriesId !== SHORT_OBSERVE_SERIES_ID
      || asset !== SHORT_OBSERVE_ASSET || durationType !== SHORT_OBSERVE_DURATION
      || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)
      || endMs - startMs !== SHORT_OBSERVE_DURATION_MS || !parserVersion
      || !exactText(tokenIds?.UP) || !exactText(tokenIds?.DOWN) || tokenIds.UP === tokenIds.DOWN) return null;

  const startTime = value.startTime ?? iso(startMs);
  const endTime = value.endTime ?? iso(endMs);
  if (Date.parse(startTime) !== startMs || iso(startMs) !== startTime
      || Date.parse(endTime) !== endMs || iso(endMs) !== endTime) return null;
  const cryptoFingerprint = value.cryptoFingerprint;
  if (!cryptoFingerprint || typeof cryptoFingerprint !== "object" || Array.isArray(cryptoFingerprint)) return null;
  const calculatedFingerprintHash = hashPayload(cryptoFingerprint);
  const fingerprintHash = exactHash(value.fingerprintHash ?? value.fingerprint_hash ?? registry.fingerprint_hash ?? calculatedFingerprintHash);
  if (!fingerprintHash || fingerprintHash !== calculatedFingerprintHash) return null;

  const discoveryPayload = value.discoveryPayload;
  const calculatedDiscoveryHash = discoveryPayload == null ? null : hashPayload(discoveryPayload);
  const discoveryPayloadHash = exactHash(
    value.discoveryPayloadHash
      ?? value.discovery_payload_hash
      ?? value.discoveryEvidence?.canonicalHash
      ?? registry.discovery_payload_hash
      ?? calculatedDiscoveryHash,
  );
  if (!discoveryPayloadHash || (calculatedDiscoveryHash && calculatedDiscoveryHash !== discoveryPayloadHash)) return null;
  const resolvedQuestion = exactText(question)
    ?? exactText(value.question)
    ?? exactText(discoveryPayload?.market?.question)
    ?? exactText(discoveryPayload?.question);
  return {
    eventId,
    marketId,
    conditionId,
    seriesId,
    asset,
    durationType,
    startTime,
    endTime,
    startMs,
    endMs,
    cryptoFingerprint,
    tokenIds: { UP: tokenIds.UP, DOWN: tokenIds.DOWN },
    parserVersion,
    fingerprintHash,
    discoveryPayloadHash,
    question: resolvedQuestion,
  };
}

function sameMarketIdentity(left, right) {
  return Boolean(left && right
    && left.eventId === right.eventId
    && left.marketId === right.marketId
    && left.conditionId === right.conditionId
    && left.seriesId === right.seriesId
    && left.asset === right.asset
    && left.durationType === right.durationType
    && left.startMs === right.startMs
    && left.endMs === right.endMs
    && left.tokenIds.UP === right.tokenIds.UP
    && left.tokenIds.DOWN === right.tokenIds.DOWN
    && left.fingerprintHash === right.fingerprintHash
    && left.discoveryPayloadHash === right.discoveryPayloadHash
    && left.parserVersion === right.parserVersion);
}

function snapshotConfig(market, config) {
  return {
    expectedChainlinkFeedId: config.expectedChainlinkFeedId,
    freezeBeforeCloseMs: config.freezeBeforeCloseMs,
    lateStartGraceMs: config.lateStartGraceMs,
    observerContractVersion: STRICT_OBSERVE_CONTRACT_VERSION,
    observerParserVersion: STRICT_OBSERVE_PARSER_VERSION,
    registryReference: {
      discoveryPayloadHash: market.discoveryPayloadHash,
      fingerprintHash: market.fingerprintHash,
      marketId: market.marketId,
      parserVersion: market.parserVersion,
    },
    snapshotIntervalMs: config.snapshotIntervalMs,
  };
}

function validPersistedReference(market, run, currentConfig) {
  const saved = parseRunConfig(run);
  const reference = saved?.registryReference;
  if (!saved || !reference || typeof reference !== "object" || Array.isArray(reference)) return false;
  const allowedRoot = [
    "expectedChainlinkFeedId", "freezeBeforeCloseMs", "lateStartGraceMs", "observerContractVersion",
    "observerParserVersion", "registryReference", "snapshotIntervalMs",
  ];
  const allowedReference = ["discoveryPayloadHash", "fingerprintHash", "marketId", "parserVersion"];
  if (Object.keys(saved).sort().join("\u0000") !== allowedRoot.sort().join("\u0000")
      || Object.keys(reference).sort().join("\u0000") !== allowedReference.sort().join("\u0000")) return false;
  return String(run.market_id) === market.marketId
    && String(run.asset) === SHORT_OBSERVE_ASSET
    && String(run.duration_type) === SHORT_OBSERVE_DURATION
    && exactText(run.market_question) !== null
    && reference.marketId === market.marketId
    && reference.fingerprintHash === market.fingerprintHash
    && reference.discoveryPayloadHash === market.discoveryPayloadHash
    && reference.parserVersion === market.parserVersion
    && saved.observerContractVersion === STRICT_OBSERVE_CONTRACT_VERSION
    && saved.observerParserVersion === STRICT_OBSERVE_PARSER_VERSION
    && saved.expectedChainlinkFeedId === currentConfig.expectedChainlinkFeedId
    && Number.isSafeInteger(saved.snapshotIntervalMs) && saved.snapshotIntervalMs > 0
    && Number.isSafeInteger(saved.freezeBeforeCloseMs) && saved.freezeBeforeCloseMs > 0
    && Number.isSafeInteger(saved.lateStartGraceMs) && saved.lateStartGraceMs > 0;
}

function runPolicy(run) {
  const saved = parseRunConfig(run);
  return {
    intervalMs: saved.snapshotIntervalMs,
    freezeMs: saved.freezeBeforeCloseMs,
    lateGraceMs: saved.lateStartGraceMs,
  };
}

function runIdentity(market) {
  return {
    runId: `btc-15m-strict:${market.marketId}`,
    enrollmentKey: `btc:15m:strict:${market.marketId}`,
    marketId: market.marketId,
    marketQuestion: market.question,
    asset: SHORT_OBSERVE_ASSET,
    durationType: SHORT_OBSERVE_DURATION,
  };
}

function defaultStorage(overrides = {}) {
  // A supplied test/runtime storage is authoritative.  In particular, do not
  // silently fall through to the process database for a storage double that
  // predates the resolution port.
  const supplied = Object.keys(overrides).length > 0;
  return {
    register: overrides.register ?? overrides.registerStrictShortMarket ?? registerStrictShortMarket,
    listMarkets: overrides.listMarkets ?? overrides.listStrictShortMarketsForObservation ?? listStrictShortMarketsForObservation,
    getMarket: overrides.getMarket ?? overrides.getStrictShortMarket ?? getStrictShortMarket,
    enroll: overrides.enroll ?? overrides.enrollShortObservationRun ?? enrollShortObservationRun,
    listRuns: overrides.listRuns ?? overrides.getShortObservationRuns ?? getShortObservationRuns,
    claim: overrides.claim ?? overrides.claimShortObservationRun ?? claimShortObservationRun,
    release: overrides.release ?? overrides.releaseShortObservationRun ?? releaseShortObservationRun,
    appendStrict: overrides.appendStrict ?? overrides.appendStrictShortObservationAttempt ?? appendStrictShortObservationAttempt,
    appendResolution: overrides.appendResolution ?? overrides.appendResolutionEvidenceBatch
      ?? overrides.appendShortResolutionEvidenceBatch
      ?? (supplied ? null : appendShortResolutionEvidenceBatch),
    listPendingResolution: overrides.listPendingResolution ?? overrides.listPendingResolutions
      ?? overrides.listStrictShortMarketsPendingResolution
      ?? (supplied ? null : listStrictShortMarketsPendingResolution),
    terminal: overrides.terminal ?? overrides.terminalizeShortObservationRun ?? terminalizeShortObservationRun,
  };
}

async function captureOfficialBook(tokenId, { signal, fetchImpl }) {
  let rawBook = null;
  const parsed = await fetchOfficialClobBook(tokenId, {
    signal,
    fetchImpl: async (url, options) => {
      const response = await fetchImpl(url, options);
      if (!response?.ok) return response;
      if (typeof response.json !== "function") return response;
      rawBook = await response.json();
      return { ok: true, status: response.status, async json() { return rawBook; } };
    },
  });
  if (!rawBook) throw new Error("strict CLOB source did not retain its raw book");
  return { rawBook, parsed };
}

function normalizeBookCapture(value, tokenId) {
  let rawBook = value?.rawBook ?? value?.raw ?? value?.book ?? null;
  let parsed = value?.parsed ?? value?.parsedBook ?? value?.result ?? null;
  if (!rawBook && value?.asset_id !== undefined) rawBook = value;
  if (!parsed && value?.status !== undefined && value?.summary !== undefined) parsed = value;
  if (rawBook && !parsed) parsed = parseClobBook(rawBook, tokenId);
  if (!rawBook || typeof rawBook !== "object" || Array.isArray(rawBook)
      || !parsed || parsed.status !== "OK" || parsed.summary?.tokenId !== tokenId) {
    const error = new Error("strict CLOB book is unavailable or invalid");
    error.code = parsed?.reason || "strict_book_invalid";
    throw error;
  }
  return { rawBook, parsed };
}

function sourceTimestamp(rawBook) {
  const raw = rawBook?.timestamp;
  const number = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(number) && number >= 1_000_000_000_000 ? number : null;
}

function evidenceReference(evidence, tokenId = null) {
  return {
    idempotencyKey: evidence.idempotencyKey,
    canonicalHash: evidence.canonicalHash,
    status: evidence.status,
    marketId: evidence.marketId,
    kind: evidence.kind,
    source: evidence.source,
    outcome: evidence.outcome,
    decimalValueText: evidence.decimalValueText,
    ...(tokenId === null ? {} : { tokenId }),
  };
}

function prepareBookEvidence({ market, run, sequence, side, capture, capturedAt, capturedMs }) {
  const payload = {
    marketId: market.marketId,
    observedAt: capturedAt,
    outcome: side,
    parserVersion: STRICT_OBSERVE_PARSER_VERSION,
    provenance: capture.parsed.provenance,
    summary: capture.parsed.summary,
    tokenId: market.tokenIds[side],
  };
  const canonicalHash = hashPayload(payload);
  return {
    candidateKey: `strict-observe:${market.marketId}:${run.run_id}:${sequence}`,
    marketId: market.marketId,
    kind: "ORDER_BOOK",
    source: "POLYMARKET_CLOB",
    status: "OK",
    sourceTimestampMs: sourceTimestamp(capture.rawBook),
    effectiveTimestampMs: capturedMs,
    receivedTimestampMs: capturedMs,
    decimalValueText: null,
    outcome: side,
    reasonCode: null,
    parserVersion: STRICT_OBSERVE_PARSER_VERSION,
    evaluatorVersion: BOOK_EVALUATOR_VERSION,
    payload,
    rawPayloadHash: hashPayload(capture.rawBook),
    canonicalHash,
    idempotencyKey: `strict:book:${market.marketId}:${run.run_id}:${sequence}:${side}`,
    createdAt: capturedAt,
  };
}

function openingProjection(result, market) {
  return {
    boundaryTimestampMs: market.startMs,
    reason: result.reason ?? null,
    source: result.source ?? null,
    status: result.status,
    value: result.value ?? null,
  };
}

function prepareOpeningEvidence({ market, run, sequence, opening, capturedAt, capturedMs }) {
  const projection = openingProjection(opening.result, market);
  const source = projection.status === "OK" ? projection.source : "OBSERVER";
  const payload = {
    marketId: market.marketId,
    observedAt: capturedAt,
    parserVersion: STRICT_OBSERVE_PARSER_VERSION,
    opening: projection,
  };
  const canonicalHash = hashPayload(payload);
  const rawSources = {};
  if (opening.rtdsFrame) rawSources.rtdsFrame = opening.rtdsFrame;
  if (opening.chainlinkReport) rawSources.chainlinkReport = opening.chainlinkReport;
  return {
    candidateKey: `strict-observe:${market.marketId}:${run.run_id}:${sequence}`,
    marketId: market.marketId,
    kind: "BOUNDARY_TWAP",
    source,
    status: projection.status,
    sourceTimestampMs: projection.status === "OK" ? market.startMs : null,
    effectiveTimestampMs: market.startMs,
    receivedTimestampMs: capturedMs,
    decimalValueText: projection.value,
    outcome: null,
    reasonCode: projection.reason,
    parserVersion: STRICT_OBSERVE_PARSER_VERSION,
    evaluatorVersion: BOUNDARY_EVALUATOR_VERSION,
    payload,
    rawPayloadHash: Object.keys(rawSources).length ? hashPayload(rawSources) : null,
    canonicalHash,
    idempotencyKey: `strict:opening:${market.marketId}:${run.run_id}:${sequence}`,
    createdAt: capturedAt,
  };
}

export function createBtc15mObserveCoordinator(dependencies = {}) {
  const timers = timerDefaults(dependencies.timers || dependencies);
  const clock = dependencies.clock || { now: () => Date.now() };
  const storage = defaultStorage(dependencies.storage);
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const discover = dependencies.discoverStrictMarkets
    ?? dependencies.discover
    ?? ((input) => discoverOfficialBtc15mMarkets({ ...input, fetchImpl }));
  const fetchBook = dependencies.fetchStrictBook
    ?? dependencies.fetchBook
    ?? ((tokenId, options) => captureOfficialBook(tokenId, { ...options, fetchImpl }));
  const fetchGammaTerminal = dependencies.fetchGammaTerminal
    ?? dependencies.fetchGammaResolution
    ?? dependencies.fetchOfficialGammaTerminalMarket
    ?? ((market, options) => fetchOfficialGammaTerminalMarket(market, { ...options, fetchImpl }));
  const validateConfig = dependencies.assertShortObserverConfig || assertShortObserverConfig;
  const owner = exactText(String(dependencies.owner || DEFAULT_OWNER));
  const state = {
    started: false,
    starting: null,
    timer: null,
    tickInFlight: false,
    tickPromise: null,
    stopPromise: null,
    discoveryController: null,
    activeAttempt: false,
    attemptController: null,
    activeRun: null,
    activeLease: null,
    boundarySource: null,
    boundarySourceStarted: false,
    resolutionSource: null,
    resolutionSourceStarted: false,
    resolutionController: null,
    watchedResolutionMarkets: new Set(),
    finalizedResolutionMarkets: new Set(),
    resolutionAttemptTimestamps: new Map(),
    config: null,
    discovered: 0,
    lastError: null,
  };

  function boundarySource() {
    if (state.boundarySource) return state.boundarySource;
    if (dependencies.boundarySource) {
      state.boundarySource = dependencies.boundarySource;
    } else {
      const factory = dependencies.createBoundarySource ?? dependencies.createRtdsBoundarySource ?? createRtdsBoundarySource;
      const options = {
        timers,
        WebSocketImpl: Object.hasOwn(dependencies, "WebSocketImpl") ? dependencies.WebSocketImpl : WebSocket,
        chainlinkReportTransport: dependencies.chainlinkReportTransport ?? null,
        ...(dependencies.boundarySourceOptions || {}),
      };
      state.boundarySource = factory(options);
    }
    if (!state.boundarySource || typeof state.boundarySource.start !== "function"
        || typeof state.boundarySource.stop !== "function"
        || typeof state.boundarySource.waitForBoundary !== "function"
        || typeof state.boundarySource.fetchChainlinkReport !== "function") {
      throw new TypeError("strict RTDS boundary source contract is required");
    }
    return state.boundarySource;
  }

  function resolutionConfigured() {
    return Boolean(storage.appendResolution && storage.listPendingResolution)
      || Boolean(dependencies.resolutionSource || dependencies.createResolutionSource
        || dependencies.createClobResolutionSource || dependencies.createClobMarketResolutionSource);
  }

  function resolutionSource() {
    if (state.resolutionSource) return state.resolutionSource;
    if (dependencies.resolutionSource) {
      state.resolutionSource = dependencies.resolutionSource;
    } else {
      const factory = dependencies.createResolutionSource
        ?? dependencies.createClobResolutionSource
        ?? dependencies.createClobMarketResolutionSource
        ?? createClobMarketResolutionSource;
      state.resolutionSource = factory({
        timers,
        WebSocketImpl: Object.hasOwn(dependencies, "resolutionWebSocketImpl")
          ? dependencies.resolutionWebSocketImpl
          : (Object.hasOwn(dependencies, "WebSocketImpl") ? dependencies.WebSocketImpl : WebSocket),
        ...(dependencies.resolutionSourceOptions || {}),
      });
    }
    const source = state.resolutionSource;
    if (!source || typeof source.start !== "function" || typeof source.stop !== "function"
        || typeof source.watchMarket !== "function" || typeof source.getResolution !== "function") {
      throw new TypeError("strict CLOB resolution source contract is required");
    }
    return source;
  }

  function resolutionPolicy() {
    const configuredInterval = state.config?.resolutionIntervalMs;
    const intervalMs = Number.isSafeInteger(configuredInterval) && configuredInterval > 0
      ? configuredInterval : state.config.snapshotIntervalMs;
    const configuredTimeout = state.config?.resolutionTimeoutMs;
    const timeoutMs = Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout : state.config.snapshotTimeoutMs;
    const configuredGrace = state.config?.resolutionGraceMs;
    const graceMs = Number.isSafeInteger(configuredGrace) && configuredGrace > 0
      ? configuredGrace : intervalMs;
    return { intervalMs, timeoutMs, graceMs };
  }

  function schedule(delay) {
    if (!state.started || state.timer !== null) return;
    state.timer = timers.setTimeout(async () => {
      state.timer = null;
      try { await tick(); } catch (error) { state.lastError = error; }
      schedule(delayForNextWork());
    }, Math.max(1, delay));
  }

  function delayForNextWork() {
    const resolutionInterval = resolutionPolicy().intervalMs;
    return Math.max(1, Math.min(state.config.discoveryIntervalMs, state.config.snapshotIntervalMs, resolutionInterval));
  }

  async function registerCandidate(candidate, now) {
    const identity = candidate?.identity ?? candidate;
    const discoveryPayload = candidate?.discoveryPayload;
    const question = exactText(candidate?.question) ?? exactText(discoveryPayload?.market?.question);
    if (!identity || !discoveryPayload) return null;
    const proposed = strictMarket({
      ...identity,
      parserVersion: IDENTITY_PARSER_VERSION,
      fingerprintHash: hashPayload(identity.cryptoFingerprint),
      discoveryPayload,
      discoveryPayloadHash: hashPayload(discoveryPayload),
    }, question);
    if (!proposed) return null;

    const existingValue = await Promise.resolve(storage.getMarket(proposed.marketId));
    if (existingValue) {
      const existing = strictMarket(existingValue, question);
      return sameMarketIdentity(existing, proposed) ? { ...existing, question } : null;
    }

    const createdAt = iso(now);
    const registeredValue = await Promise.resolve(storage.register({
      identity,
      discoveryPayload,
      discoveryPayloadHash: proposed.discoveryPayloadHash,
      fingerprintHash: proposed.fingerprintHash,
      parserVersion: IDENTITY_PARSER_VERSION,
      createdAt,
      evidenceMetadata: {
        candidateKey: `strict-discovery:${proposed.marketId}`,
        idempotencyKey: `strict:discovery:${proposed.marketId}`,
        source: "GAMMA",
        status: "OK",
        sourceTimestampMs: proposed.startMs,
        effectiveTimestampMs: proposed.startMs,
        receivedTimestampMs: now,
        evaluatorVersion: DISCOVERY_EVALUATOR_VERSION,
        rawPayloadHash: null,
        canonicalHash: proposed.discoveryPayloadHash,
      },
    }));
    if (!registeredValue) return null;
    const registered = strictMarket(registeredValue, question);
    return sameMarketIdentity(registered, proposed) ? { ...registered, question } : null;
  }

  async function enrollMarket(market, now) {
    if (!market?.question || market.startMs > now + state.config.discoveryLookaheadMs || market.endMs <= now) return null;
    await ensureResolutionWatch(market, now);
    const identity = runIdentity(market);
    const enrolled = await Promise.resolve(storage.enroll({
      ...identity,
      config: snapshotConfig(market, state.config),
      nextScheduledAt: iso(market.startMs),
      createdAt: iso(now),
      updatedAt: iso(now),
    }));
    if (enrolled) state.discovered += 1;
    return enrolled;
  }

  function discoveryWithTimeout(now) {
    const controller = new AbortController();
    const parentSignal = state.discoveryController?.signal;
    const onParentAbort = () => controller.abort(parentSignal.reason || abortError("shutdown_cancelled"));
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    const work = Promise.resolve().then(() => discover({
      nowMs: now,
      lookaheadMs: state.config.discoveryLookaheadMs,
      signal: controller.signal,
    }));
    let timer = null;
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        timer = null;
        const error = Object.assign(new Error("strict discovery timeout"), { code: "discovery_timeout" });
        controller.abort(error);
        reject(error);
      }, state.config.discoveryTimeoutMs);
    });
    return Promise.race([work, deadline]).finally(() => {
      if (timer !== null) timers.clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    });
  }

  async function recoverRegisteredMarkets(now) {
    try {
      const registered = await Promise.resolve(storage.listMarkets({
        endAfterMs: now,
        startAtOrBeforeMs: now + state.config.discoveryLookaheadMs,
        limit: MAX_DISCOVERY_MARKETS,
      }));
      for (const value of Array.isArray(registered) ? registered : []) {
        const market = strictMarket(value);
        if (market) {
          await ensureResolutionWatch(market, clockNow(clock));
          await enrollMarket(market, clockNow(clock));
        }
      }
    } catch (error) {
      state.lastError = error;
    }
  }

  async function discoverAndEnrollNew(now) {
    const enrolledRunIds = new Set();
    try {
      const result = await discoveryWithTimeout(now);
      const candidates = Array.isArray(result) ? result : result?.markets;
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const marketId = exactText(candidate?.identity?.marketId ?? candidate?.marketId);
        if (!marketId) continue;
        try {
          const registered = await registerCandidate(candidate, clockNow(clock));
          if (!registered) continue;
          await ensureResolutionWatch(registered, clockNow(clock));
          const enrolled = await enrollMarket(registered, clockNow(clock));
          const runId = exactText(enrolled?.run_id ?? enrolled?.runId);
          if (runId) enrolledRunIds.add(runId);
        } catch (error) {
          state.lastError = error;
        }
      }
    } catch (error) {
      state.lastError = error;
    }
    return enrolledRunIds;
  }

  async function processAvailableRuns(processedRunIds, onlyRunIds = null) {
    let runs = [];
    try {
      const scheduled = await Promise.resolve(storage.listRuns({ status: "scheduled", limit: 1000 }));
      const observing = await Promise.resolve(storage.listRuns({ status: "observing", limit: 1000 }));
      const byId = new Map([...scheduled, ...observing].map((run) => [run.run_id, run]));
      runs = [...byId.values()];
    } catch (error) {
      state.lastError = error;
    }
    for (const run of runs) {
      if (!state.started || state.activeAttempt) break;
      const runId = exactText(run?.run_id);
      if (!runId || processedRunIds.has(runId) || (onlyRunIds && !onlyRunIds.has(runId))) continue;
      processedRunIds.add(runId);
      await processRun(run);
    }
  }

  async function terminalizeInvalidRun(run, now, errorCode) {
    const leaseToken = randomUUID();
    const lease = await Promise.resolve(storage.claim({
      runId: run.run_id,
      leaseOwner: owner,
      leaseToken,
      leaseExpiresAt: iso(now + state.config.leaseTimeoutMs),
      now: iso(now),
    }));
    if (!lease) return false;
    const terminal = await Promise.resolve(storage.terminal({
      runId: run.run_id,
      status: "invalid",
      errorCode,
      leaseOwner: owner,
      leaseToken: lease.lease_token,
      now: iso(clockNow(clock)),
      terminalAt: iso(clockNow(clock)),
    }));
    if (!terminal) {
      await Promise.resolve(storage.release({
        runId: run.run_id,
        leaseOwner: owner,
        leaseToken: lease.lease_token,
        now: iso(clockNow(clock)),
      }));
      throw new Error("strict collector invalidation failed");
    }
    return true;
  }

  async function waitRetry(delay, signal) {
    await new Promise((resolve, reject) => {
      let timer = timers.setTimeout(() => {
        timer = null;
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        if (timer !== null) timers.clearTimeout(timer);
        timer = null;
        reject(signal.reason || abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  async function captureBoundary(market, signal) {
    const source = boundarySource();
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(signal.reason || abortError());
    signal.addEventListener("abort", onParentAbort, { once: true });
    let rtdsFrame = null;
    let chainlinkReport = null;
    let timer = null;
    const calls = Promise.all([
      Promise.resolve().then(() => source.waitForBoundary(market.startMs, controller.signal))
        .then((value) => { rtdsFrame = value ?? null; })
        .catch((error) => { if (signal.aborted) throw error; }),
      Promise.resolve().then(() => source.fetchChainlinkReport(market.startMs, controller.signal))
        .then((value) => { chainlinkReport = value ?? null; })
        .catch((error) => { if (signal.aborted) throw error; }),
    ]);
    const deadline = new Promise((resolve) => {
      timer = timers.setTimeout(() => {
        timer = null;
        controller.abort(Object.assign(new Error("opening boundary wait expired"), { code: "opening_boundary_timeout" }));
        resolve();
      }, Math.max(1, Math.floor(state.config.snapshotTimeoutMs / 2)));
    });
    try {
      await Promise.race([calls, deadline]);
      if (signal.aborted) throw signal.reason || abortError();
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
      signal.removeEventListener("abort", onParentAbort);
    }
    return {
      result: selectBoundaryTwap({
        boundaryTimestampMs: market.startMs,
        rtdsFrame,
        chainlinkReport,
        expectedChainlinkFeedId: state.config.expectedChainlinkFeedId,
      }),
      rtdsFrame,
      chainlinkReport,
    };
  }

  async function captureClosingBoundary(market, signal) {
    const source = boundarySource();
    let rtdsFrame = null;
    let chainlinkReport = null;
    // Closing evidence is deliberately a point lookup.  Waiting for a nearby
    // frame would turn a close boundary into an inferred value.
    if (typeof source.getBoundary === "function") {
      try {
        rtdsFrame = await Promise.resolve(source.getBoundary(market.endMs));
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    try {
      chainlinkReport = await Promise.resolve(source.fetchChainlinkReport(market.endMs, signal));
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return {
      result: selectBoundaryTwap({
        boundaryTimestampMs: market.endMs,
        rtdsFrame,
        chainlinkReport,
        expectedChainlinkFeedId: state.config.expectedChainlinkFeedId,
      }),
      rtdsFrame,
      chainlinkReport,
    };
  }

  function prepareClosingBoundaryEvidence({ market, closing, attemptTimestampMs }) {
    const projection = closing.result;
    const status = projection.status;
    const source = status === "OK" ? projection.source : "OBSERVER";
    const payload = {
      boundaryTimestampMs: market.endMs,
      marketId: market.marketId,
      parserVersion: RESOLUTION_PARSER_VERSION,
      reason: projection.reason ?? null,
      source,
      status,
      value: projection.value ?? null,
    };
    const rawSources = {};
    if (closing.rtdsFrame) rawSources.rtdsFrame = closing.rtdsFrame;
    if (closing.chainlinkReport) rawSources.chainlinkReport = closing.chainlinkReport;
    return {
      candidateKey: `strict-resolution:${market.marketId}:boundary:${attemptTimestampMs}`,
      marketId: market.marketId,
      kind: "BOUNDARY_TWAP",
      source,
      status,
      sourceTimestampMs: status === "OK" ? market.endMs : null,
      effectiveTimestampMs: market.endMs,
      receivedTimestampMs: attemptTimestampMs,
      decimalValueText: status === "OK" ? projection.value : null,
      outcome: null,
      reasonCode: status === "OK" ? null : (projection.reason || "BOUNDARY_VALUE_UNAVAILABLE"),
      parserVersion: RESOLUTION_PARSER_VERSION,
      evaluatorVersion: BOUNDARY_EVALUATOR_VERSION,
      payload,
      rawPayloadHash: Object.keys(rawSources).length ? hashPayload(rawSources) : null,
      canonicalHash: hashPayload(payload),
      idempotencyKey: `strict:resolution:boundary:${market.marketId}:${market.endMs}:attempt:${attemptTimestampMs}`,
      createdAt: iso(attemptTimestampMs),
    };
  }

  function aggregateResolutionEvidence({ market, state: resolution, observations, attemptTimestampMs }) {
    const payload = {
      marketId: market.marketId,
      observations: observations.map((item) => item.raw ?? null),
      parserVersion: RESOLUTION_PARSER_VERSION,
      reason: resolution.reason ?? null,
      status: resolution.status,
      outcome: resolution.outcome ?? null,
      source: resolution.source ?? null,
    };
    const resolved = resolution.status === "RESOLVED";
    const quarantined = resolution.status === "QUARANTINED";
    return {
      candidateKey: `strict-resolution:${market.marketId}:aggregate:${attemptTimestampMs}`,
      marketId: market.marketId,
      kind: "RESOLUTION",
      source: resolved ? resolution.source : "OBSERVER",
      status: resolution.status,
      sourceTimestampMs: null,
      effectiveTimestampMs: market.endMs,
      receivedTimestampMs: attemptTimestampMs,
      decimalValueText: null,
      outcome: resolved ? resolution.outcome : null,
      reasonCode: resolved ? null : (resolution.reason || (quarantined ? "SOURCE_DISAGREEMENT" : "PLATFORM_NOT_TERMINAL")),
      parserVersion: RESOLUTION_PARSER_VERSION,
      evaluatorVersion: RESOLUTION_EVALUATOR_VERSION,
      payload,
      rawPayloadHash: observations.length ? hashPayload(observations.map((item) => item.raw ?? null)) : null,
      canonicalHash: hashPayload(payload),
      idempotencyKey: `strict:resolution:${market.marketId}:aggregate:attempt:${attemptTimestampMs}`,
      createdAt: iso(attemptTimestampMs),
    };
  }

  function resolutionAttemptTimestamp(market, now) {
    const latest = (Array.isArray(market?.resolutionEvidence) ? market.resolutionEvidence : [])
      .reduce((value, evidence) => Number.isSafeInteger(evidence?.receivedTimestampMs)
        ? Math.max(value ?? evidence.receivedTimestampMs, evidence.receivedTimestampMs)
        : value, null);
    const inMemory = state.resolutionAttemptTimestamps.get(market?.marketId) ?? null;
    const previous = Math.max(latest ?? Number.MIN_SAFE_INTEGER, inMemory ?? Number.MIN_SAFE_INTEGER);
    const candidate = previous === Number.MIN_SAFE_INTEGER ? now : Math.max(now, previous + 1);
    return Number.isSafeInteger(candidate) ? candidate : now;
  }

  async function resolutionFetchWithTimeout(market, controller) {
    const policy = resolutionPolicy();
    const child = new AbortController();
    const onParentAbort = () => child.abort(controller.signal.reason || abortError("shutdown_cancelled"));
    controller.signal.addEventListener("abort", onParentAbort, { once: true });
    let timer = null;
    const work = Promise.resolve().then(() => fetchGammaTerminal(market, { signal: child.signal }));
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        timer = null;
        const error = Object.assign(new Error("strict resolution timeout"), { code: "resolution_timeout" });
        child.abort(error);
        reject(error);
      }, policy.timeoutMs);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
      controller.signal.removeEventListener("abort", onParentAbort);
    }
  }

  async function ensureResolutionWatch(market, now) {
    if (!resolutionConfigured() || !market || market.endMs < now
        && now > market.endMs + resolutionPolicy().graceMs) return false;
    const source = resolutionSource();
    if (state.watchedResolutionMarkets.has(market.marketId)) return true;
    source.watchMarket({
      marketId: market.marketId,
      conditionId: market.conditionId,
      tokenIds: market.tokenIds,
    });
    state.watchedResolutionMarkets.add(market.marketId);
    return true;
  }

  function unwatchResolutionMarket(market) {
    if (!market || !state.resolutionSource) return;
    try { state.resolutionSource.unwatchMarket?.(market); } catch (error) { state.lastError = error; }
    state.watchedResolutionMarkets.delete(market.marketId);
  }

  async function reconcileResolutionMarket(market, now, parentController) {
    if (!market || now < market.endMs || state.finalizedResolutionMarkets.has(market.marketId)) return false;
    if (now > market.endMs + resolutionPolicy().graceMs) {
      state.finalizedResolutionMarkets.add(market.marketId);
      unwatchResolutionMarket(market);
      return false;
    }
    await ensureResolutionWatch(market, now);
    const source = resolutionSource();
    const attemptTimestampMs = resolutionAttemptTimestamp(market, clockNow(clock));
    const closing = await captureClosingBoundary(market, parentController.signal);
    const observations = [];
    const buffered = source.getResolution(market);
    if (buffered?.message) observations.push({ source: "CLOB", message: buffered.message, raw: buffered.message });

    let gammaMarket = null;
    try {
      const gamma = await resolutionFetchWithTimeout(market, parentController);
      gammaMarket = gamma?.market ?? gamma?.rawMarket ?? gamma ?? null;
      if (gammaMarket) observations.push({ source: "GAMMA", market: gammaMarket, raw: gammaMarket });
    } catch (error) {
      if (parentController.signal.aborted) throw error;
      state.lastError = error;
    }

    const resolution = evaluateShortResolution(market, observations);
    const evidence = [
      prepareClosingBoundaryEvidence({ market, closing, attemptTimestampMs }),
      aggregateResolutionEvidence({ market, state: resolution, observations, attemptTimestampMs }),
    ];
    const written = await Promise.resolve(storage.appendResolution({ marketId: market.marketId, evidence }));
    if (written == null) return false;
    state.resolutionAttemptTimestamps.set(market.marketId, attemptTimestampMs);
    if (resolution.status === "RESOLVED") {
      state.finalizedResolutionMarkets.add(market.marketId);
      unwatchResolutionMarket(market);
    }
    return true;
  }

  async function reconcileResolutions(now) {
    if (!resolutionConfigured()) return false;
    const policy = resolutionPolicy();
    let pending;
    try {
      pending = await Promise.resolve(storage.listPendingResolution({
        endAtOrBeforeMs: now,
        endAtOrAfterMs: now - policy.graceMs,
        retryBeforeMs: now - policy.intervalMs,
        limit: MAX_RESOLUTION_MARKETS,
      }));
    } catch (error) {
      state.lastError = error;
      return false;
    }
    const controller = new AbortController();
    state.resolutionController = controller;
    try {
      for (const market of Array.isArray(pending) ? pending : []) {
        if (!state.started) break;
        try { await reconcileResolutionMarket(market, clockNow(clock), controller); } catch (error) {
          state.lastError = error;
        }
      }
    } finally {
      if (state.resolutionController === controller) state.resolutionController = null;
    }
    return Array.isArray(pending) && pending.length > 0;
  }

  async function collectOnce(market, signal) {
    const [UP, DOWN, opening] = await Promise.all([
      Promise.resolve().then(() => fetchBook(market.tokenIds.UP, { signal, side: "UP", market }))
        .then((value) => normalizeBookCapture(value, market.tokenIds.UP)),
      Promise.resolve().then(() => fetchBook(market.tokenIds.DOWN, { signal, side: "DOWN", market }))
        .then((value) => normalizeBookCapture(value, market.tokenIds.DOWN)),
      captureBoundary(market, signal),
    ]);
    return { books: { UP, DOWN }, opening };
  }

  async function collect(market, freezeAt, parentController) {
    let lastError = null;
    for (let retry = 0; retry <= state.config.retries; retry += 1) {
      if (clockNow(clock) >= freezeAt) return { status: "cancelled", errorCode: "freeze_window" };
      const controller = new AbortController();
      let deadlineReject = null;
      const onParentAbort = () => {
        const reason = parentController.signal.reason || abortError();
        controller.abort(reason);
        deadlineReject?.(reason);
      };
      parentController.signal.addEventListener("abort", onParentAbort, { once: true });
      let timer = null;
      const deadline = new Promise((_, reject) => { deadlineReject = reject; });
      if (parentController.signal.aborted) onParentAbort();
      try {
        timer = timers.setTimeout(() => {
          timer = null;
          const error = Object.assign(new Error("strict snapshot timeout"), { code: "snapshot_timeout" });
          controller.abort(error);
          deadlineReject(error);
        }, state.config.snapshotTimeoutMs);
        const captured = await Promise.race([collectOnce(market, controller.signal), deadline]);
        if (controller.signal.aborted) throw controller.signal.reason || abortError();
        if (clockNow(clock) >= freezeAt) return { status: "cancelled", errorCode: "freeze_window" };
        return { status: "completed", errorCode: null, ...captured };
      } catch (error) {
        lastError = error;
        if (!controller.signal.aborted) controller.abort(error);
        if (parentController.signal.aborted) break;
        if (clockNow(clock) >= freezeAt) return { status: "cancelled", errorCode: "freeze_window" };
        if (retry < state.config.retries) {
          try {
            await waitRetry(state.config.retryBackoffMs, parentController.signal);
          } catch (retryError) {
            lastError = retryError;
            break;
          }
        }
      } finally {
        if (timer !== null) timers.clearTimeout(timer);
        parentController.signal.removeEventListener("abort", onParentAbort);
      }
    }
    if (parentController.signal.aborted) {
      return { status: "cancelled", errorCode: parentController.signal.reason?.code || "freeze_window" };
    }
    return { status: "failed", errorCode: String(lastError?.code || "strict_collection_failed") };
  }

  async function appendAuthoritativeAttempt(market, run, lease, startedAt, result) {
    const sequence = Number(run.next_sequence);
    const capturedMs = clockNow(clock);
    const capturedAt = iso(capturedMs);
    const openingEvidence = prepareOpeningEvidence({ market, run, sequence, opening: result.opening, capturedAt, capturedMs });
    const upEvidence = prepareBookEvidence({ market, run, sequence, side: "UP", capture: result.books.UP, capturedAt, capturedMs });
    const downEvidence = prepareBookEvidence({ market, run, sequence, side: "DOWN", capture: result.books.DOWN, capturedAt, capturedMs });
    const evidence = [openingEvidence, upEvidence, downEvidence];
    const auditPayload = buildStrictObserveOnlyAudit({
      registry: market,
      run: {
        runId: run.run_id,
        sequence,
        scheduledAt: run.next_scheduled_at,
        startedAt: iso(startedAt),
        capturedAt,
        finishedAt: capturedAt,
        attemptStatus: "completed",
        errorCode: null,
      },
      rawBooks: { UP: result.books.UP.rawBook, DOWN: result.books.DOWN.rawBook },
      parsedBooks: { UP: result.books.UP.parsed, DOWN: result.books.DOWN.parsed },
      openingBoundary: result.opening.result,
      evidenceReferences: {
        opening: evidenceReference(openingEvidence),
        books: {
          UP: evidenceReference(upEvidence, market.tokenIds.UP),
          DOWN: evidenceReference(downEvidence, market.tokenIds.DOWN),
        },
      },
    });
    const policy = runPolicy(run);
    return Promise.resolve(storage.appendStrict({
      runId: run.run_id,
      sequence,
      marketId: market.marketId,
      marketQuestion: run.market_question,
      durationType: SHORT_OBSERVE_DURATION,
      asset: SHORT_OBSERVE_ASSET,
      capturedAt,
      createdAt: capturedAt,
      contractVersion: STRICT_OBSERVE_CONTRACT_VERSION,
      modelVersion: STRICT_OBSERVE_MODEL_VERSION,
      auditPayload,
      collectionMode: "observe_only",
      scheduledAt: run.next_scheduled_at,
      startedAt: iso(startedAt),
      finishedAt: capturedAt,
      attemptStatus: "completed",
      errorCode: null,
      nextScheduledAt: iso(Date.parse(run.next_scheduled_at) + policy.intervalMs),
      evidence,
      leaseOwner: owner,
      leaseToken: lease.lease_token,
      now: capturedAt,
    }));
  }

  async function processRun(run) {
    if (state.activeAttempt) return false;
    let now = clockNow(clock);
    const registryValue = await Promise.resolve(storage.getMarket(String(run.market_id || "")));
    const market = strictMarket(registryValue, run.market_question);
    if (!market) return terminalizeInvalidRun(run, now, "strict_registry_missing_or_invalid");
    if (!validPersistedReference(market, run, state.config)) {
      return terminalizeInvalidRun(run, now, "strict_registry_reference_mismatch");
    }
    const policy = runPolicy(run);
    const sequence = Number(run.next_sequence);
    const scheduledAt = Date.parse(run.next_scheduled_at || "");
    const expectedScheduledAt = market.startMs + sequence * policy.intervalMs;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(expectedScheduledAt)
        || !Number.isFinite(scheduledAt) || iso(scheduledAt) !== run.next_scheduled_at
        || scheduledAt !== expectedScheduledAt) {
      return terminalizeInvalidRun(run, now, "strict_schedule_reference_mismatch");
    }
    if (now < scheduledAt) return false;
    const freezeAt = market.endMs - policy.freezeMs;
    const leaseToken = randomUUID();
    const lease = await Promise.resolve(storage.claim({
      runId: run.run_id,
      leaseOwner: owner,
      leaseToken,
      leaseExpiresAt: iso(now + state.config.leaseTimeoutMs),
      now: iso(now),
    }));
    if (!lease) return false;

    state.activeAttempt = true;
    state.activeRun = run;
    state.activeLease = lease;
    const controller = new AbortController();
    state.attemptController = controller;
    now = clockNow(clock);
    const late = now > scheduledAt + policy.lateGraceMs;
    const frozen = scheduledAt >= freezeAt || now >= freezeAt;
    let freezeTimer = null;
    if (!late && !frozen) freezeTimer = timers.setTimeout(() => controller.abort(abortError("freeze_window")), freezeAt - now);
    let leaseSettled = false;
    const startedAt = now;

    const releaseLease = async (required = true) => {
      if (leaseSettled) return true;
      const released = await Promise.resolve(storage.release({
        runId: run.run_id,
        leaseOwner: owner,
        leaseToken: lease.lease_token,
        now: iso(clockNow(clock)),
      }));
      if (released) leaseSettled = true;
      if (!released && required) throw new Error("strict collector lease release failed");
      return released;
    };

    const terminalMissed = async (errorCode) => {
      const terminal = await Promise.resolve(storage.terminal({
        runId: run.run_id,
        status: "missed",
        errorCode,
        leaseOwner: owner,
        leaseToken: lease.lease_token,
        now: iso(clockNow(clock)),
        terminalAt: iso(clockNow(clock)),
      }));
      if (!terminal) throw new Error("strict collector terminalization failed");
      leaseSettled = true;
      return true;
    };

    try {
      if (late) return await terminalMissed("missed_slot");
      if (frozen) return await terminalMissed("freeze_window");
      const result = await collect(market, freezeAt, controller);
      if (result.status !== "completed") {
        if (result.errorCode === "freeze_window") return await terminalMissed(result.errorCode);
        await releaseLease();
        return false;
      }

      const written = await appendAuthoritativeAttempt(market, run, lease, startedAt, result);
      if (written == null) {
        await releaseLease();
        return false;
      }
      const lastSequence = Math.max(0, Math.ceil((freezeAt - market.startMs) / policy.intervalMs) - 1);
      if (sequence >= lastSequence) {
        const terminal = await Promise.resolve(storage.terminal({
          runId: run.run_id,
          status: "completed",
          errorCode: null,
          leaseOwner: owner,
          leaseToken: lease.lease_token,
          now: iso(clockNow(clock)),
          terminalAt: iso(clockNow(clock)),
        }));
        if (!terminal) throw new Error("strict collector terminalization failed");
        leaseSettled = true;
      } else {
        await releaseLease();
      }
      return true;
    } catch (error) {
      await releaseLease(false);
      throw error;
    } finally {
      if (freezeTimer !== null) timers.clearTimeout(freezeTimer);
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
      const processedRunIds = new Set();
      await recoverRegisteredMarkets(clockNow(clock));
      await processAvailableRuns(processedRunIds);
      if (!state.started) return false;
      await reconcileResolutions(clockNow(clock));
      if (!state.started) return false;
      const newlyEnrolledRunIds = await discoverAndEnrollNew(clockNow(clock));
      if (!state.started) return false;
      if (newlyEnrolledRunIds.size > 0) await processAvailableRuns(processedRunIds, newlyEnrolledRunIds);
      return true;
    } finally {
      state.tickInFlight = false;
    }
  }

  function tick() {
    if (state.tickPromise) return state.tickPromise;
    const promise = runTick();
    state.tickPromise = promise;
    const clear = () => { if (state.tickPromise === promise) state.tickPromise = null; };
    promise.then(clear, clear);
    return promise;
  }

  function start() {
    if (state.starting) return state.starting;
    if (state.started) return Promise.resolve(true);
    const startup = (async () => {
      const config = exactConfig(validateConfig());
      state.config = config;
      if (!config.enabled) return false;
      const source = boundarySource();
      state.started = true;
      state.discoveryController = new AbortController();
      try {
        await Promise.resolve(source.start());
        if (!state.started) {
          await Promise.resolve(source.stop());
          return false;
        }
        state.boundarySourceStarted = true;
        if (resolutionConfigured()) {
          const resolution = resolutionSource();
          await Promise.resolve(resolution.start());
          if (!state.started) {
            await Promise.resolve(resolution.stop());
            await Promise.resolve(source.stop());
            state.boundarySourceStarted = false;
            return false;
          }
          state.resolutionSourceStarted = true;
        }
        await tick();
        schedule(delayForNextWork());
        return true;
      } catch (error) {
        state.started = false;
        state.discoveryController?.abort(abortError("shutdown_cancelled"));
        state.discoveryController = null;
        if (state.boundarySourceStarted) {
          try { await Promise.resolve(source.stop()); } finally { state.boundarySourceStarted = false; }
        }
        if (state.resolutionSourceStarted) {
          try { await Promise.resolve(state.resolutionSource.stop()); } finally { state.resolutionSourceStarted = false; }
        }
        throw error;
      }
    })();
    const wrapped = startup.finally(() => {
      if (state.starting === wrapped) state.starting = null;
    });
    state.starting = wrapped;
    return wrapped;
  }

  async function stopBoundarySourceBounded() {
    let timer = null;
    const stopping = Promise.resolve().then(() => state.boundarySource.stop());
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        timer = null;
        reject(new Error("strict boundary source stop timeout"));
      }, state.config?.shutdownTimeoutMs || 1);
    });
    try {
      return await Promise.race([stopping, deadline]);
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
    }
  }

  async function stopResolutionSourceBounded() {
    if (!state.resolutionSource) return true;
    let timer = null;
    const stopping = Promise.resolve().then(() => state.resolutionSource.stop());
    const deadline = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        timer = null;
        reject(new Error("strict resolution source stop timeout"));
      }, state.config?.shutdownTimeoutMs || 1);
    });
    try {
      return await Promise.race([stopping, deadline]);
    } finally {
      if (timer !== null) timers.clearTimeout(timer);
    }
  }

  function stop() {
    if (state.stopPromise) return state.stopPromise;
    if (!state.started && state.timer === null && !state.tickPromise && !state.boundarySourceStarted) return false;
    state.started = false;
    if (state.timer !== null) { timers.clearTimeout(state.timer); state.timer = null; }
    state.discoveryController?.abort(abortError("shutdown_cancelled"));
    state.attemptController?.abort(abortError("shutdown_cancelled"));
    state.resolutionController?.abort(abortError("shutdown_cancelled"));
    state.discoveryController = null;
    const drain = (async () => {
      let drained = true;
      const pending = state.tickPromise || state.starting;
      if (pending) {
        let shutdownTimer = null;
        const deadline = new Promise((_, reject) => {
          shutdownTimer = timers.setTimeout(() => reject(new Error("strict collector shutdown timeout")), state.config?.shutdownTimeoutMs || 1);
        });
        try {
          await Promise.race([pending, deadline]);
        } catch (error) {
          state.lastError = error;
          drained = false;
          if (state.activeRun && state.activeLease) {
            await Promise.resolve(storage.release({
              runId: state.activeRun.run_id,
              leaseOwner: owner,
              leaseToken: state.activeLease.lease_token,
              now: iso(clockNow(clock)),
            }));
          }
        } finally {
          if (shutdownTimer !== null) timers.clearTimeout(shutdownTimer);
        }
      }
      if (state.boundarySourceStarted) {
        try {
          await stopBoundarySourceBounded();
        } catch (error) {
          state.lastError = error;
          drained = false;
        } finally {
          state.boundarySourceStarted = false;
        }
      }
      if (state.resolutionSourceStarted) {
        try {
          await stopResolutionSourceBounded();
        } catch (error) {
          state.lastError = error;
          drained = false;
        } finally {
          state.resolutionSourceStarted = false;
        }
      }
      return drained;
    })();
    state.stopPromise = drain.finally(() => { state.stopPromise = null; });
    return state.stopPromise;
  }

  return { start, stop, tick, getState: () => ({ ...state }) };
}

const moduleCoordinator = createBtc15mObserveCoordinator();
export async function startBtc15mObserveCollector() { return moduleCoordinator.start(); }
export function stopBtc15mObserveCollector() { return moduleCoordinator.stop(); }
