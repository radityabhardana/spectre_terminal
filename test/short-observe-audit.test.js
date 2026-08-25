import assert from "node:assert/strict";
import test from "node:test";
import {
  STRICT_OBSERVE_CONTRACT_VERSION,
  STRICT_OBSERVE_MODEL_VERSION,
  STRICT_OBSERVE_PARSER_VERSION,
  StrictObserveAuditError,
  buildStrictObserveOnlyAudit,
} from "../src/short-observe-audit.js";

const START_MS = 1_787_659_200_000;
const OPENING_DECIMAL = "112345.67890123456789012300";

function book(tokenId, { bid, ask, lowerBid, higherAsk, timestamp }) {
  return {
    timestamp,
    market: "condition-100-a",
    asks: [
      { size: "11.00000000000000000001", price: higherAsk },
      { price: ask, size: "13.25000000000000000000" },
    ],
    asset_id: tokenId,
    bids: [
      { size: "7.00000000000000000001", price: lowerBid },
      { price: bid, size: "9.12500000000000000000" },
    ],
    request: { endpoint: "clob-book", responseTag: `tag-${tokenId}` },
  };
}

function parsed(tokenId, { bid, ask, spread, timestamp }) {
  return {
    provenance: { timestamp, assetId: tokenId, source: "POLYMARKET_CLOB" },
    summary: { spread, askLevels: 2, tokenId, bestAsk: ask, bidLevels: 2, bestBid: bid },
    status: "OK",
  };
}

function evidenceReference({ side = null, tokenId = null, hash, key, kind, source, status = "OK", decimalValueText = null }) {
  return {
    status,
    canonicalHash: hash.repeat(64),
    idempotencyKey: key,
    marketId: "market-100-a",
    kind,
    source,
    decimalValueText,
    ...(side == null ? {} : { outcome: side, tokenId }),
  };
}

function validInput() {
  const up = {
    bid: "0.49000000000000000000",
    ask: "0.51000000000000000000",
    lowerBid: "0.47000000000000000001",
    higherAsk: "0.53000000000000000001",
    timestamp: "1787659260020",
  };
  const down = {
    bid: "0.48000000000000000000",
    ask: "0.52000000000000000000",
    lowerBid: "0.46000000000000000001",
    higherAsk: "0.54000000000000000001",
    timestamp: "1787659260020",
  };
  return {
    registry: {
      eventId: "event-100",
      marketId: "market-100-a",
      conditionId: "condition-100-a",
      seriesId: "10192",
      asset: "BTC",
      durationType: "15m",
      startTime: "2026-08-25T12:00:00.000Z",
      endTime: "2026-08-25T12:15:00.000Z",
      startMs: START_MS,
      endMs: START_MS + 900_000,
      tokenIds: { UP: "token-100-a-up", DOWN: "token-100-a-down" },
      fingerprintHash: "d".repeat(64),
      discoveryPayloadHash: "e".repeat(64),
      parserVersion: "strict-identity-parser-v1",
    },
    run: {
      runId: "observe:market-100-a",
      sequence: 4,
      scheduledAt: "2026-08-25T12:01:00.000Z",
      startedAt: "2026-08-25T12:01:00.010Z",
      capturedAt: "2026-08-25T12:01:00.020Z",
      finishedAt: "2026-08-25T12:01:00.030Z",
      attemptStatus: "completed",
      errorCode: null,
    },
    rawBooks: {
      UP: book("token-100-a-up", up),
      DOWN: book("token-100-a-down", down),
    },
    parsedBooks: {
      UP: parsed("token-100-a-up", { ...up, spread: "0.02" }),
      DOWN: parsed("token-100-a-down", { ...down, spread: "0.04000000000000000000" }),
    },
    openingBoundary: {
      timestampMs: START_MS,
      status: "OK",
      source: "RTDS",
      value: OPENING_DECIMAL,
      corroboratedBy: "CHAINLINK",
    },
    evidenceReferences: {
      opening: evidenceReference({
        hash: "a", key: "boundary:market-100-a:1787659200000", kind: "BOUNDARY_TWAP",
        source: "RTDS", decimalValueText: OPENING_DECIMAL,
      }),
      books: {
        UP: evidenceReference({
          side: "UP", tokenId: "token-100-a-up", hash: "b", key: "book:market-100-a:4:up",
          kind: "ORDER_BOOK", source: "POLYMARKET_CLOB",
        }),
        DOWN: evidenceReference({
          side: "DOWN", tokenId: "token-100-a-down", hash: "c", key: "book:market-100-a:4:down",
          kind: "ORDER_BOOK", source: "POLYMARKET_CLOB",
        }),
      },
    },
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseObjectKeys(value[key])]));
}

function assertNoObserveOnlyForbiddenContent(value) {
  const forbiddenKeys = /(recommendation|actionable|candidate|entry|play|stake|selected.?side|side.?selection|public|publication|publish)/i;
  const forbiddenWords = new Set(["recommendation", "actionable", "candidate", "entry", "play", "stake", "public", "publication"]);
  if (Array.isArray(value)) {
    value.forEach(assertNoObserveOnlyForbiddenContent);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.equal(forbiddenKeys.test(key), false, `forbidden key: ${key}`);
      assertNoObserveOnlyForbiddenContent(item);
    }
    return;
  }
  if (typeof value === "string") {
    const words = value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    assert.equal(words.some((word) => forbiddenWords.has(word)), false, `forbidden value: ${value}`);
  }
}

test("strict collector audit is canonical and deterministic under recursive input key order", () => {
  const first = buildStrictObserveOnlyAudit(validInput());
  const reordered = buildStrictObserveOnlyAudit(reverseObjectKeys(validInput()));
  assert.deepEqual(reordered, first);
  assert.equal(JSON.stringify(reordered), JSON.stringify(first));
  assert.deepEqual(first.observer, {
    contractVersion: STRICT_OBSERVE_CONTRACT_VERSION,
    mode: "observe_only",
    modelVersion: STRICT_OBSERVE_MODEL_VERSION,
    parserVersion: STRICT_OBSERVE_PARSER_VERSION,
  });
  assert.equal(Object.isFrozen(first), true);
});

test("audit is an allow-listed observe-only projection with no forbidden keys or values recursively", () => {
  const input = validInput();
  input.recommendation = "PLAY";
  input.parsedBooks.UP.model = {
    actionable: true,
    nested: { selectedSide: "UP", publicCandidate: "PUBLIC CANDIDATE ENTRY PLAY" },
  };
  input.openingBoundary.analysis = { stake: "10", publication: "PUBLIC" };
  input.evidenceReferences.opening.extra = { recommendation: "ENTRY" };
  const audit = buildStrictObserveOnlyAudit(input);
  assertNoObserveOnlyForbiddenContent(audit);
  assert.equal("model" in audit.bookProjections.UP, false);

  const rawContamination = validInput();
  rawContamination.rawBooks.UP.request.nested = { publicCandidate: "PLAY" };
  assert.throws(() => buildStrictObserveOnlyAudit(rawContamination), (error) => error instanceof StrictObserveAuditError && error.code === "FORBIDDEN_CONTENT");
});

test("opening and book decimals remain exact text without lossy numeric conversion", () => {
  const input = validInput();
  const audit = buildStrictObserveOnlyAudit(input);
  assert.equal(audit.openingEvidence.value, OPENING_DECIMAL);
  assert.equal(typeof audit.openingEvidence.value, "string");
  assert.equal(audit.bookProjections.UP.summary.bestBid, "0.49000000000000000000");
  assert.equal(audit.bookProjections.DOWN.summary.spread, "0.04000000000000000000");
  assert.equal(audit.authoritativeSnapshot.books.UP.bids[1].size, "9.12500000000000000000");

  for (const mutate of [
    (candidate) => { candidate.openingBoundary.value = 112345.6789; },
    (candidate) => { candidate.evidenceReferences.opening.decimalValueText = 112345.6789; },
    (candidate) => { candidate.parsedBooks.UP.summary.bestBid = 0.49; },
    (candidate) => { candidate.rawBooks.DOWN.asks[1].price = 0.52; },
  ]) {
    const candidate = validInput();
    mutate(candidate);
    assert.throws(() => buildStrictObserveOnlyAudit(candidate), (error) => error instanceof StrictObserveAuditError && error.code === "INVALID_DECIMAL");
  }
});

test("registry stays a hashed reference and evidence references remain explicit", () => {
  const audit = buildStrictObserveOnlyAudit(validInput());
  assert.deepEqual(audit.registryReference, {
    discoveryPayloadHash: "e".repeat(64),
    fingerprintHash: "d".repeat(64),
    marketId: "market-100-a",
    parserVersion: "strict-identity-parser-v1",
  });
  for (const mutableIdentityField of ["eventId", "conditionId", "startMs", "endMs", "tokenIds", "identity"]) {
    assert.equal(mutableIdentityField in audit.registryReference, false);
  }
  assert.deepEqual(audit.openingEvidence.evidenceReference, {
    canonicalHash: "a".repeat(64),
    idempotencyKey: "boundary:market-100-a:1787659200000",
    status: "OK",
  });
  assert.equal(audit.bookProjections.UP.evidenceReference.canonicalHash, "b".repeat(64));
  assert.equal(audit.bookProjections.DOWN.evidenceReference.idempotencyKey, "book:market-100-a:4:down");
});

test("authoritative snapshot retains complete raw UP and DOWN books while projections stay compact", () => {
  const input = validInput();
  const expectedBooks = structuredClone(input.rawBooks);
  const audit = buildStrictObserveOnlyAudit(input);
  assert.deepEqual(audit.authoritativeSnapshot.books, expectedBooks);
  assert.notStrictEqual(audit.authoritativeSnapshot.books.UP, input.rawBooks.UP);
  assert.deepEqual(Object.keys(audit.bookProjections.UP).sort(), ["evidenceReference", "provenance", "status", "summary"]);
  assert.equal("bids" in audit.bookProjections.UP, false);
  assert.equal("asks" in audit.bookProjections.UP, false);
  input.rawBooks.UP.bids[0].price = "0.01";
  assert.equal(audit.authoritativeSnapshot.books.UP.bids[0].price, "0.47000000000000000001");
});

test("opening data-gap remains explicit and cannot fabricate a decimal value", () => {
  const input = validInput();
  input.openingBoundary = { status: "DATA_GAP", reason: "BOUNDARY_VALUE_UNAVAILABLE" };
  input.evidenceReferences.opening = evidenceReference({
    hash: "a", key: "boundary:market-100-a:1787659200000", kind: "BOUNDARY_TWAP",
    source: "OBSERVER", status: "DATA_GAP", decimalValueText: null,
  });
  const audit = buildStrictObserveOnlyAudit(input);
  assert.deepEqual({ status: audit.openingEvidence.status, value: audit.openingEvidence.value, reason: audit.openingEvidence.reason }, {
    status: "DATA_GAP", value: null, reason: "BOUNDARY_VALUE_UNAVAILABLE",
  });
});

test("required fields, hashes, schedules, sides, tokens, summaries, and evidence fail closed", () => {
  const mutations = [
    (candidate) => { delete candidate.registry.marketId; },
    (candidate) => { candidate.registry.fingerprintHash = "A".repeat(64); },
    (candidate) => { candidate.registry.seriesId = 10192; },
    (candidate) => { candidate.registry.endMs += 1; },
    (candidate) => { candidate.registry.tokenIds.DOWN = candidate.registry.tokenIds.UP; },
    (candidate) => { delete candidate.run.errorCode; },
    (candidate) => { candidate.run.sequence = "4"; },
    (candidate) => { candidate.run.startedAt = "2026-08-25T12:01:00.040Z"; },
    (candidate) => { delete candidate.rawBooks.DOWN; },
    (candidate) => { candidate.rawBooks.UP.asset_id = "token-100-a-down"; },
    (candidate) => { candidate.parsedBooks.DOWN.summary.tokenId = "token-100-a-up"; },
    (candidate) => { candidate.parsedBooks.UP.summary.bestBid = "0.48"; },
    (candidate) => { candidate.evidenceReferences.books.UP.outcome = "DOWN"; },
    (candidate) => { candidate.evidenceReferences.books.DOWN.tokenId = "token-100-a-up"; },
    (candidate) => { candidate.evidenceReferences.opening.status = "DATA_GAP"; },
    (candidate) => { candidate.openingBoundary.timestampMs += 1; },
    (candidate) => { candidate.evidenceReferences.books.UP.idempotencyKey = candidate.evidenceReferences.books.DOWN.idempotencyKey; },
    (candidate) => { delete candidate.openingBoundary; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const candidate = validInput();
    mutate(candidate);
    assert.throws(() => buildStrictObserveOnlyAudit(candidate), StrictObserveAuditError, `invalid case ${index}`);
  }
  assert.throws(() => buildStrictObserveOnlyAudit(), StrictObserveAuditError);
});

test("AI is always exactly disabled", () => {
  const input = validInput();
  input.ai = { requested: true, used: true, status: "used" };
  const audit = buildStrictObserveOnlyAudit(input);
  assert.deepEqual(audit.ai, { requested: false, status: "disabled", used: false });
});
