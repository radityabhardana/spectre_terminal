import {
  SHORT_OBSERVE_ASSET,
  SHORT_OBSERVE_DURATION,
  SHORT_OBSERVE_DURATION_MS,
  SHORT_OBSERVE_SERIES_ID,
} from "./short-observe-contract.js";

export const STRICT_OBSERVE_CONTRACT_VERSION = "btc15m-strict-observer-v2";
export const STRICT_OBSERVE_MODEL_VERSION = "observe-only-snapshot-v2";
export const STRICT_OBSERVE_PARSER_VERSION = "strict-market-sources-v1";

const MIN_MILLISECOND_TIMESTAMP = 1_000_000_000_000;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PLAIN_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const ATTEMPT_STATUSES = new Set(["completed", "failed", "cancelled", "missed"]);
const OPENING_STATUSES = new Set(["OK", "DATA_GAP", "QUARANTINED"]);
const FORBIDDEN_KEY_PARTS = Object.freeze([
  "recommendation", "actionable", "candidate", "entry", "play", "stake",
  "selectedside", "sideselection", "public", "publication", "publish",
]);
const FORBIDDEN_VALUE_WORDS = new Set([
  "recommendation", "actionable", "candidate", "entry", "play", "stake",
  "public", "publication",
]);

export class StrictObserveAuditError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "StrictObserveAuditError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StrictObserveAuditError(code, message);
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value, field) {
  if (!isRecord(value)) fail("INVALID_OBJECT", `${field} must be a plain object`);
  return value;
}

function exactText(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail("INVALID_TEXT", `${field} must be nonempty exact text`);
  }
  return value;
}

function exactIso(value, field) {
  const text = exactText(value, field);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== text) {
    fail("INVALID_TIMESTAMP", `${field} must be a canonical ISO timestamp`);
  }
  return { text, milliseconds };
}

function timestampMs(value, field) {
  if (!Number.isSafeInteger(value) || value < MIN_MILLISECOND_TIMESTAMP) {
    fail("INVALID_TIMESTAMP", `${field} must be an integer millisecond timestamp`);
  }
  return value;
}

function sha256(value, field) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    fail("INVALID_HASH", `${field} must be lowercase sha256 hex`);
  }
  return value;
}

function decimalText(value, field, { positive = false, lessThanOne = false } = {}) {
  if (typeof value !== "string" || !PLAIN_DECIMAL.test(value)) {
    fail("INVALID_DECIMAL", `${field} must be plain decimal text; numeric conversion is forbidden`);
  }
  if (positive && compareDecimal(value, "0") <= 0) fail("INVALID_DECIMAL", `${field} must be positive`);
  if (lessThanOne && compareDecimal(value, "1") >= 0) fail("INVALID_DECIMAL", `${field} must be below one`);
  return value;
}

function compareDecimal(left, right) {
  const [leftInteger, leftFraction = ""] = left.split(".");
  const [rightInteger, rightFraction = ""] = right.split(".");
  if (leftInteger.length !== rightInteger.length) return leftInteger.length < rightInteger.length ? -1 : 1;
  if (leftInteger !== rightInteger) return leftInteger < rightInteger ? -1 : 1;
  const width = Math.max(leftFraction.length, rightFraction.length);
  const normalizedLeft = leftFraction.padEnd(width, "0");
  const normalizedRight = rightFraction.padEnd(width, "0");
  return normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
}

function decimalDifference(minuend, subtrahend) {
  const [leftInteger, leftFraction = ""] = minuend.split(".");
  const [rightInteger, rightFraction = ""] = subtrahend.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const left = BigInt(`${leftInteger}${leftFraction.padEnd(scale, "0")}`);
  const right = BigInt(`${rightInteger}${rightFraction.padEnd(scale, "0")}`);
  const difference = left - right;
  if (difference < 0n) fail("BOOK_MISMATCH", "book spread cannot be negative");
  if (scale === 0) return difference.toString();
  const digits = difference.toString().padStart(scale + 1, "0");
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function ownValue(source, names) {
  if (!isRecord(source)) return { present: false, value: undefined };
  const found = [];
  for (const name of names) {
    if (!Object.hasOwn(source, name) || source[name] === undefined) continue;
    found.push(source[name]);
  }
  if (found.length === 0) return { present: false, value: undefined };
  if (found.some((value) => !Object.is(value, found[0]))) fail("FIELD_MISMATCH", `${names.join("/")} aliases disagree`);
  return { present: true, value: found[0] };
}

function scalarFrom(sources, names, field, { required = true, normalize = (value) => value } = {}) {
  const found = [];
  for (const source of sources) {
    const candidate = ownValue(source, names);
    if (candidate.present) found.push(normalize(candidate.value));
  }
  if (found.length === 0) {
    if (required) fail("MISSING_FIELD", `${field} is required`);
    return { present: false, value: undefined };
  }
  if (found.some((value) => !Object.is(value, found[0]))) fail("FIELD_MISMATCH", `${field} disagrees across inputs`);
  return { present: true, value: found[0] };
}

function optionalRecord(value, field) {
  if (value == null) return null;
  return record(value, field);
}

function normalizeTokenMap(input, registryObjects, marketId) {
  const maps = [];
  for (const source of [input.tokenIds, ...registryObjects.map((item) => item?.tokenIds)]) {
    if (source === undefined) continue;
    const value = record(source, "registry.tokenIds");
    maps.push({
      UP: exactText(value.UP, "registry.tokenIds.UP"),
      DOWN: exactText(value.DOWN, "registry.tokenIds.DOWN"),
    });
  }

  const tokenRows = input.registryTokens ?? registryObjects.map((item) => item?.tokens).find((value) => value !== undefined);
  if (tokenRows !== undefined) {
    if (!Array.isArray(tokenRows) || tokenRows.length !== 2) fail("TOKEN_MISMATCH", "registry tokens must contain exactly UP and DOWN");
    const mapped = {};
    for (const [index, token] of tokenRows.entries()) {
      record(token, `registry.tokens[${index}]`);
      const outcome = exactText(token.outcome, `registry.tokens[${index}].outcome`);
      const tokenId = exactText(token.tokenId ?? token.token_id, `registry.tokens[${index}].tokenId`);
      const tokenMarketId = token.marketId ?? token.market_id;
      if (!["UP", "DOWN"].includes(outcome) || mapped[outcome]) fail("TOKEN_MISMATCH", "registry tokens must map UP and DOWN exactly once");
      if (tokenMarketId !== undefined && tokenMarketId !== marketId) fail("TOKEN_MISMATCH", "registry token market id mismatch");
      mapped[outcome] = tokenId;
    }
    maps.push(mapped);
  }

  if (maps.length === 0) fail("MISSING_FIELD", "registry.tokenIds is required");
  if (maps.some((mapping) => mapping.UP !== maps[0].UP || mapping.DOWN !== maps[0].DOWN)) {
    fail("TOKEN_MISMATCH", "registry token mappings disagree");
  }
  if (maps[0].UP === maps[0].DOWN) fail("TOKEN_MISMATCH", "UP and DOWN token ids must be distinct");
  return Object.freeze({ ...maps[0] });
}

function normalizeRegistry(input) {
  const supplied = input.registry ?? input.registryIdentity;
  const outer = record(supplied, "registry");
  const identity = optionalRecord(outer.identity, "registry.identity");
  const row = optionalRecord(outer.registry, "registry.registry");
  const hashes = optionalRecord(input.registryHashes ?? outer.hashes, "registry.hashes");
  const sources = [identity, outer, row, hashes].filter(Boolean);

  const eventId = exactText(scalarFrom(sources, ["eventId", "event_id"], "registry.eventId").value, "registry.eventId");
  const marketId = exactText(scalarFrom(sources, ["marketId", "market_id"], "registry.marketId").value, "registry.marketId");
  const conditionId = exactText(scalarFrom(sources, ["conditionId", "condition_id"], "registry.conditionId").value, "registry.conditionId");
  const seriesId = exactText(scalarFrom(sources, ["seriesId", "series_id"], "registry.seriesId").value, "registry.seriesId");
  const asset = exactText(scalarFrom(sources, ["asset"], "registry.asset", {
    normalize: (value) => typeof value === "string" ? value.toUpperCase() : value,
  }).value, "registry.asset");
  const durationType = exactText(scalarFrom(sources, ["durationType", "duration_type"], "registry.durationType").value, "registry.durationType");
  if (seriesId !== SHORT_OBSERVE_SERIES_ID || asset !== SHORT_OBSERVE_ASSET || durationType !== SHORT_OBSERVE_DURATION) fail("REGISTRY_MISMATCH", "registry is not the strict BTC 15m series");

  const startMs = timestampMs(scalarFrom(sources, ["startMs", "start_time_ms"], "registry.startMs").value, "registry.startMs");
  const endMs = timestampMs(scalarFrom(sources, ["endMs", "end_time_ms"], "registry.endMs").value, "registry.endMs");
  if (endMs - startMs !== SHORT_OBSERVE_DURATION_MS) fail("REGISTRY_MISMATCH", "registry interval must be exactly 900000ms");

  const startTime = scalarFrom(sources, ["startTime"], "registry.startTime", { required: false });
  const endTime = scalarFrom(sources, ["endTime"], "registry.endTime", { required: false });
  if (startTime.present && exactIso(startTime.value, "registry.startTime").milliseconds !== startMs) fail("REGISTRY_MISMATCH", "registry start time mismatch");
  if (endTime.present && exactIso(endTime.value, "registry.endTime").milliseconds !== endMs) fail("REGISTRY_MISMATCH", "registry end time mismatch");

  const fingerprintHash = sha256(scalarFrom(sources, ["fingerprintHash", "fingerprint_hash"], "registry.fingerprintHash").value, "registry.fingerprintHash");
  const discoveryPayloadHash = sha256(scalarFrom(sources, ["discoveryPayloadHash", "discovery_payload_hash"], "registry.discoveryPayloadHash").value, "registry.discoveryPayloadHash");
  const parserVersion = exactText(scalarFrom(sources, ["parserVersion", "parser_version"], "registry.parserVersion").value, "registry.parserVersion");
  const tokenIds = normalizeTokenMap(input, sources, marketId);

  return { eventId, marketId, conditionId, startMs, endMs, tokenIds, fingerprintHash, discoveryPayloadHash, parserVersion };
}

function normalizeAttempt(input) {
  const sources = [input, input.run, input.schedule, input.timestamps, input.attempt].filter((value) => value != null).map((value, index) => record(value, `run provenance ${index}`));
  for (const source of [...sources]) {
    for (const nested of [source.schedule, source.timestamps, source.attempt]) {
      if (nested != null) sources.push(record(nested, "nested run provenance"));
    }
  }

  const runId = exactText(scalarFrom(sources, ["runId", "run_id"], "run.runId").value, "run.runId");
  const sequence = scalarFrom(sources, ["sequence"], "run.sequence").value;
  if (!Number.isSafeInteger(sequence) || sequence < 0) fail("INVALID_SEQUENCE", "run.sequence must be a non-negative safe integer");
  const scheduledAt = exactIso(scalarFrom(sources, ["scheduledAt", "scheduled_at"], "run.scheduledAt").value, "run.scheduledAt");
  const startedAt = exactIso(scalarFrom(sources, ["startedAt", "started_at"], "run.startedAt").value, "run.startedAt");
  const finishedAt = exactIso(scalarFrom(sources, ["finishedAt", "finished_at"], "run.finishedAt").value, "run.finishedAt");
  const capturedAt = exactIso(scalarFrom(sources, ["capturedAt", "captured_at"], "run.capturedAt").value, "run.capturedAt");
  if (scheduledAt.milliseconds > startedAt.milliseconds || startedAt.milliseconds > finishedAt.milliseconds
      || capturedAt.milliseconds < startedAt.milliseconds || capturedAt.milliseconds > finishedAt.milliseconds) {
    fail("TIMESTAMP_MISMATCH", "run timestamps are out of order");
  }

  const attemptStatus = exactText(scalarFrom(sources, ["attemptStatus", "attempt_status", "status"], "run.attemptStatus").value, "run.attemptStatus");
  if (!ATTEMPT_STATUSES.has(attemptStatus)) fail("INVALID_STATUS", "run.attemptStatus is unsupported");
  const error = scalarFrom(sources, ["errorCode", "error_code"], "run.errorCode");
  const errorCode = error.value == null ? null : exactText(error.value, "run.errorCode");
  return {
    runId,
    sequence,
    schedule: { scheduledAt: scheduledAt.text },
    timestamps: { capturedAt: capturedAt.text, finishedAt: finishedAt.text, startedAt: startedAt.text },
    status: attemptStatus,
    errorCode,
  };
}

function sideObject(value, field) {
  const sides = record(value, field);
  const keys = Object.keys(sides).sort();
  if (keys.length !== 2 || keys[0] !== "DOWN" || keys[1] !== "UP") fail("SIDE_MISMATCH", `${field} must contain exactly UP and DOWN`);
  return sides;
}

function validateRawBook(rawBook, side, expectedTokenId) {
  const book = record(rawBook, `rawBooks.${side}`);
  if (book.asset_id !== expectedTokenId) fail("TOKEN_MISMATCH", `rawBooks.${side}.asset_id does not match registry ${side}`);
  const levelsByKind = {};
  for (const kind of ["bids", "asks"]) {
    const levels = book[kind];
    if (!Array.isArray(levels) || levels.length === 0) fail("INVALID_BOOK", `rawBooks.${side}.${kind} must be a non-empty array`);
    levelsByKind[kind] = levels.map((level, index) => {
      record(level, `rawBooks.${side}.${kind}[${index}]`);
      return {
        price: decimalText(level.price, `rawBooks.${side}.${kind}[${index}].price`, { positive: true, lessThanOne: true }),
        size: decimalText(level.size, `rawBooks.${side}.${kind}[${index}].size`, { positive: true }),
      };
    });
  }
  const bestBid = levelsByKind.bids.reduce((best, level) => compareDecimal(level.price, best.price) > 0 ? level : best).price;
  const bestAsk = levelsByKind.asks.reduce((best, level) => compareDecimal(level.price, best.price) < 0 ? level : best).price;
  if (compareDecimal(bestBid, bestAsk) >= 0) fail("INVALID_BOOK", `rawBooks.${side} is crossed`);
  return { book, bestBid, bestAsk, bidLevels: levelsByKind.bids.length, askLevels: levelsByKind.asks.length };
}

function normalizeEvidenceReference(value, field, { marketId, status, kind, outcome = null, tokenId = null, decimalValue = undefined, source = null }) {
  const reference = record(value, field);
  const idempotencyKey = exactText(scalarFrom([reference], ["idempotencyKey", "idempotency_key"], `${field}.idempotencyKey`).value, `${field}.idempotencyKey`);
  const canonicalHash = sha256(scalarFrom([reference], ["canonicalHash", "canonical_hash"], `${field}.canonicalHash`).value, `${field}.canonicalHash`);
  const referenceStatus = exactText(scalarFrom([reference], ["status"], `${field}.status`).value, `${field}.status`);
  if (referenceStatus !== status) fail("EVIDENCE_MISMATCH", `${field}.status does not match its observation`);

  const optionalChecks = [
    [["marketId", "market_id"], marketId, "market id"],
    [["kind"], kind, "kind"],
  ];
  if (outcome !== null) optionalChecks.push([["outcome"], outcome, "outcome"]);
  if (tokenId !== null) optionalChecks.push([["tokenId", "token_id", "assetId", "asset_id"], tokenId, "token id"]);
  if (source !== null) optionalChecks.push([["source"], source, "source"]);
  for (const [names, expected, label] of optionalChecks) {
    const supplied = scalarFrom([reference], names, `${field}.${label}`, { required: false });
    if (supplied.present && supplied.value !== expected) fail("EVIDENCE_MISMATCH", `${field} ${label} mismatch`);
  }

  const evidenceDecimal = scalarFrom([reference], ["decimalValueText", "decimal_value_text"], `${field}.decimalValueText`, { required: false });
  if (evidenceDecimal.present) {
    if (decimalValue === undefined) {
      if (evidenceDecimal.value !== null) {
        decimalText(evidenceDecimal.value, `${field}.decimalValueText`);
        fail("EVIDENCE_MISMATCH", `${field} must not contain a decimal value`);
      }
    } else if (decimalValue === null) {
      if (evidenceDecimal.value !== null) fail("EVIDENCE_MISMATCH", `${field} decimal value mismatch`);
    } else {
      const normalizedEvidenceDecimal = decimalText(evidenceDecimal.value, `${field}.decimalValueText`, { positive: true });
      if (normalizedEvidenceDecimal !== decimalValue) fail("EVIDENCE_MISMATCH", `${field} decimal value mismatch`);
    }
  }
  return { canonicalHash, idempotencyKey, status: referenceStatus };
}

function embeddedReference(value) {
  if (!isRecord(value)) return null;
  return value.evidenceReference ?? value.evidence_reference ?? value.evidence ?? null;
}

function normalizeBookProjection(parsedValue, raw, side, tokenId, evidenceValue, marketId) {
  const parsed = record(parsedValue, `parsedBooks.${side}`);
  const parsedStatus = scalarFrom([parsed], ["status"], `parsedBooks.${side}.status`, { required: false });
  if (parsedStatus.present && parsedStatus.value !== "OK") fail("BOOK_MISMATCH", `parsedBooks.${side} is not OK`);
  const summary = record(parsed.summary ?? parsed, `parsedBooks.${side}.summary`);
  const summaryTokenId = exactText(summary.tokenId ?? summary.token_id, `parsedBooks.${side}.summary.tokenId`);
  if (summaryTokenId !== tokenId) fail("TOKEN_MISMATCH", `parsedBooks.${side} token does not match registry ${side}`);
  const bestBid = decimalText(summary.bestBid ?? summary.best_bid, `parsedBooks.${side}.summary.bestBid`, { positive: true, lessThanOne: true });
  const bestAsk = decimalText(summary.bestAsk ?? summary.best_ask, `parsedBooks.${side}.summary.bestAsk`, { positive: true, lessThanOne: true });
  const spread = decimalText(summary.spread, `parsedBooks.${side}.summary.spread`);
  const bidLevels = summary.bidLevels ?? summary.bid_levels;
  const askLevels = summary.askLevels ?? summary.ask_levels;
  if (!Number.isSafeInteger(bidLevels) || bidLevels <= 0 || !Number.isSafeInteger(askLevels) || askLevels <= 0) {
    fail("BOOK_MISMATCH", `parsedBooks.${side} level counts are invalid`);
  }
  if (bestBid !== raw.bestBid || bestAsk !== raw.bestAsk || bidLevels !== raw.bidLevels || askLevels !== raw.askLevels
      || compareDecimal(spread, decimalDifference(bestAsk, bestBid)) !== 0) {
    fail("BOOK_MISMATCH", `parsedBooks.${side} does not describe its authoritative raw book`);
  }

  const provenance = parsed.provenance == null ? null : record(parsed.provenance, `parsedBooks.${side}.provenance`);
  if (provenance?.source !== undefined && provenance.source !== "POLYMARKET_CLOB") fail("BOOK_MISMATCH", `parsedBooks.${side} source mismatch`);
  if (provenance?.assetId !== undefined && provenance.assetId !== tokenId) fail("TOKEN_MISMATCH", `parsedBooks.${side} provenance token mismatch`);
  const rawTimestamp = raw.book.timestamp == null ? null : String(raw.book.timestamp);
  if (provenance?.timestamp !== undefined && provenance.timestamp !== rawTimestamp) fail("BOOK_MISMATCH", `parsedBooks.${side} timestamp mismatch`);

  const reference = normalizeEvidenceReference(evidenceValue, `evidenceReferences.books.${side}`, {
    marketId,
    status: "OK",
    kind: "ORDER_BOOK",
    outcome: side,
    tokenId,
    source: "POLYMARKET_CLOB",
  });
  const embedded = embeddedReference(parsed);
  if (embedded) {
    const normalizedEmbedded = normalizeEvidenceReference(embedded, `parsedBooks.${side}.embeddedEvidence`, {
      marketId,
      status: "OK",
      kind: "ORDER_BOOK",
      outcome: side,
      tokenId,
      source: "POLYMARKET_CLOB",
    });
    if (normalizedEmbedded.idempotencyKey !== reference.idempotencyKey || normalizedEmbedded.canonicalHash !== reference.canonicalHash) {
      fail("EVIDENCE_MISMATCH", `parsedBooks.${side} embedded evidence reference mismatch`);
    }
  }

  return {
    status: "OK",
    summary: { askLevels, bestAsk, bestBid, bidLevels, spread, tokenId },
    provenance: { assetId: tokenId, source: "POLYMARKET_CLOB", timestamp: rawTimestamp },
    evidenceReference: reference,
  };
}

function normalizeOpening(openingValue, evidenceValue, registry) {
  const opening = record(openingValue, "openingBoundary");
  const status = exactText(opening.status, "openingBoundary.status");
  if (!OPENING_STATUSES.has(status)) fail("INVALID_STATUS", "openingBoundary.status is unsupported");
  const suppliedTimestamp = scalarFrom([opening], ["timestampMs", "boundaryTimestampMs", "boundary_timestamp_ms"], "openingBoundary.timestampMs", { required: false });
  if (suppliedTimestamp.present && timestampMs(suppliedTimestamp.value, "openingBoundary.timestampMs") !== registry.startMs) {
    fail("EVIDENCE_MISMATCH", "opening boundary timestamp does not match the registry start");
  }

  const suppliedValue = scalarFrom([opening], ["value", "valueText", "decimalValueText", "decimal_value_text"], "openingBoundary.value", { required: false });
  let value = null;
  let source = null;
  let reason = null;
  if (status === "OK") {
    if (!suppliedValue.present) fail("MISSING_FIELD", "openingBoundary.value is required when status is OK");
    value = decimalText(suppliedValue.value, "openingBoundary.value", { positive: true });
    source = exactText(opening.source, "openingBoundary.source");
    if (!suppliedTimestamp.present) fail("MISSING_FIELD", "openingBoundary.timestampMs is required when status is OK");
  } else {
    if (suppliedValue.present && suppliedValue.value !== null) fail("INVALID_DECIMAL", "non-OK opening boundary cannot contain a value");
    reason = exactText(opening.reason, "openingBoundary.reason");
    if (opening.source != null) source = exactText(opening.source, "openingBoundary.source");
  }

  const reference = normalizeEvidenceReference(evidenceValue, "evidenceReferences.opening", {
    marketId: registry.marketId,
    status,
    kind: "BOUNDARY_TWAP",
    decimalValue: value,
    source,
  });
  const embedded = embeddedReference(opening);
  if (embedded) {
    const normalizedEmbedded = normalizeEvidenceReference(embedded, "openingBoundary.embeddedEvidence", {
      marketId: registry.marketId,
      status,
      kind: "BOUNDARY_TWAP",
      decimalValue: value,
      source,
    });
    if (normalizedEmbedded.idempotencyKey !== reference.idempotencyKey || normalizedEmbedded.canonicalHash !== reference.canonicalHash) {
      fail("EVIDENCE_MISMATCH", "opening boundary embedded evidence reference mismatch");
    }
  }

  const directHash = scalarFrom([opening], ["canonicalHash", "canonical_hash"], "openingBoundary.canonicalHash", { required: false });
  if (directHash.present && sha256(directHash.value, "openingBoundary.canonicalHash") !== reference.canonicalHash) {
    fail("EVIDENCE_MISMATCH", "opening boundary canonical hash mismatch");
  }
  return {
    boundaryTimestampMs: registry.startMs,
    evidenceReference: reference,
    reason,
    source,
    status,
    value,
  };
}

function forbiddenKey(key) {
  const compact = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FORBIDDEN_KEY_PARTS.some((part) => compact.includes(part));
}

function forbiddenValue(value) {
  const words = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.some((word) => FORBIDDEN_VALUE_WORDS.has(word))) return true;
  return (words.includes("selected") && words.includes("side")) || (words.includes("side") && words.includes("selection"));
}

function canonicalClone(value, field = "audit", active = new WeakSet()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (forbiddenValue(value)) fail("FORBIDDEN_CONTENT", `${field} contains forbidden observe-only content`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail("NON_CANONICAL_VALUE", `${field} contains a non-canonical number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (active.has(value)) fail("NON_CANONICAL_VALUE", `${field} contains a cycle`);
    const arrayKeys = Reflect.ownKeys(value);
    const expectedKeys = new Set(["length"]);
    for (let index = 0; index < value.length; index += 1) {
      expectedKeys.add(String(index));
      if (!Object.hasOwn(value, index)) fail("NON_CANONICAL_VALUE", `${field} contains a sparse array`);
    }
    if (arrayKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))) fail("NON_CANONICAL_VALUE", `${field} contains non-JSON array data`);
    active.add(value);
    const output = value.map((item, index) => canonicalClone(item, `${field}[${index}]`, active));
    active.delete(value);
    return output;
  }
  if (!isRecord(value)) fail("NON_CANONICAL_VALUE", `${field} must contain only JSON-compatible data`);
  if (active.has(value)) fail("NON_CANONICAL_VALUE", `${field} contains a cycle`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail("NON_CANONICAL_VALUE", `${field} contains symbol keys`);
  if (ownKeys.some((key) => !Object.getOwnPropertyDescriptor(value, key)?.enumerable)) {
    fail("NON_CANONICAL_VALUE", `${field} contains non-enumerable data`);
  }
  active.add(value);
  const output = {};
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("NON_CANONICAL_VALUE", `${field}.${key} is not plain data`);
    if (forbiddenKey(key)) fail("FORBIDDEN_CONTENT", `${field}.${key} is forbidden in observe-only audit data`);
    output[key] = canonicalClone(descriptor.value, `${field}.${key}`, active);
  }
  active.delete(value);
  return output;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function selectedInput(input, primary, fallback, field) {
  if (input[primary] !== undefined && input[fallback] !== undefined && input[primary] !== input[fallback]) {
    fail("FIELD_MISMATCH", `${primary} and ${fallback} are ambiguous`);
  }
  const value = input[primary] ?? input[fallback];
  if (value === undefined) fail("MISSING_FIELD", `${field} is required`);
  return value;
}

/**
 * Builds the collector-v2 observe-only audit projection. This function performs
 * validation and canonical cloning only; it has no evaluator, AI, storage, or
 * transport dependencies.
 */
export function buildStrictObserveOnlyAudit(input = {}) {
  record(input, "input");
  const registry = normalizeRegistry(input);
  const attempt = normalizeAttempt(input);
  const rawBooks = sideObject(selectedInput(input, "rawBooks", "books", "rawBooks"), "rawBooks");
  const parsedBooks = sideObject(selectedInput(input, "parsedBooks", "bookSummaries", "parsedBooks"), "parsedBooks");
  const evidenceInput = input.evidenceReferences ?? input.preparedEvidenceReferences ?? input.evidence;
  if (evidenceInput === undefined) fail("MISSING_FIELD", "evidenceReferences is required");
  const evidence = record(evidenceInput, "evidenceReferences");
  const directBookEvidence = evidence.UP === undefined && evidence.DOWN === undefined ? undefined : { UP: evidence.UP, DOWN: evidence.DOWN };
  const bookEvidence = sideObject(evidence.books ?? evidence.orderBooks ?? directBookEvidence, "evidenceReferences.books");
  const openingEvidence = evidence.opening ?? evidence.openingBoundary;
  if (openingEvidence === undefined) fail("MISSING_FIELD", "evidenceReferences.opening is required");
  const openingBoundary = selectedInput(input, "openingBoundary", "opening", "openingBoundary");

  const validatedRaw = {
    UP: validateRawBook(rawBooks.UP, "UP", registry.tokenIds.UP),
    DOWN: validateRawBook(rawBooks.DOWN, "DOWN", registry.tokenIds.DOWN),
  };
  const projections = {
    UP: normalizeBookProjection(parsedBooks.UP, validatedRaw.UP, "UP", registry.tokenIds.UP, bookEvidence.UP, registry.marketId),
    DOWN: normalizeBookProjection(parsedBooks.DOWN, validatedRaw.DOWN, "DOWN", registry.tokenIds.DOWN, bookEvidence.DOWN, registry.marketId),
  };
  const opening = normalizeOpening(openingBoundary, openingEvidence, registry);

  const evidenceKeys = [
    opening.evidenceReference.idempotencyKey,
    projections.UP.evidenceReference.idempotencyKey,
    projections.DOWN.evidenceReference.idempotencyKey,
  ];
  if (new Set(evidenceKeys).size !== evidenceKeys.length) fail("EVIDENCE_MISMATCH", "evidence idempotency keys must be distinct");

  const audit = {
    ai: { requested: false, status: "disabled", used: false },
    attempt,
    authoritativeSnapshot: {
      books: { DOWN: validatedRaw.DOWN.book, UP: validatedRaw.UP.book },
      capturedAt: attempt.timestamps.capturedAt,
    },
    bookProjections: { DOWN: projections.DOWN, UP: projections.UP },
    observer: {
      contractVersion: STRICT_OBSERVE_CONTRACT_VERSION,
      mode: "observe_only",
      modelVersion: STRICT_OBSERVE_MODEL_VERSION,
      parserVersion: STRICT_OBSERVE_PARSER_VERSION,
    },
    openingEvidence: opening,
    registryReference: {
      discoveryPayloadHash: registry.discoveryPayloadHash,
      fingerprintHash: registry.fingerprintHash,
      marketId: registry.marketId,
      parserVersion: registry.parserVersion,
    },
  };
  return deepFreeze(canonicalClone(audit));
}
