import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CRYPTO_FEE_POLICY_V2,
  buildGammaKeysetRequest,
  canonicalizeChainlinkFeedId,
  calculateObservationalFee,
  paginateGammaBtc15mMarkets,
  parseChainlinkBoundaryReport,
  parseClobBook,
  parseRtdsBoundaryTwap,
  selectBoundaryTwap,
} from "../src/short-market-sources.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "short-observer");
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(fixtureDir, name), "utf8"));
const boundary = 1_787_659_200_000;
const startTimeMin = "2026-08-25T12:00:00.000Z";
const startTimeMax = "2026-08-25T12:30:00.000Z";

test("injected Gamma keyset pagination uses the exact query and terminates on null cursor", async () => {
  const pages = [await fixture("gamma-keyset-page-1.json"), await fixture("gamma-keyset-page-2.json")];
  const requests = [];
  const result = await paginateGammaBtc15mMarkets({ startTimeMin, startTimeMax, fetchPage: async (request) => { requests.push(request); return pages.shift(); } });
  assert.equal(result.pageCount, 2); assert.equal(result.markets.length, 3);
  const baseQuery = { series_id: "10192", closed: "false", start_time_min: startTimeMin, start_time_max: startTimeMax, limit: "100" };
  assert.deepEqual(requests[0].query, baseQuery);
  assert.deepEqual(requests[1].query, { ...baseQuery, after_cursor: "event-100" });
  assert.equal(new URL(requests[0].url).pathname, "/events/keyset");
  assert.deepEqual(Object.fromEntries(new URL(requests[1].url).searchParams), requests[1].query);
  assert.deepEqual(buildGammaKeysetRequest({ startTimeMin, startTimeMax }).query, baseQuery);
  assert.equal("active" in requests[0].query, false);
  const sanitizedBase = buildGammaKeysetRequest({ startTimeMin, startTimeMax, baseUrl: "https://example.test/events/keyset?active=true#fragment" });
  assert.deepEqual(Object.fromEntries(new URL(sanitizedBase.url).searchParams), baseQuery);
  assert.equal(new URL(sanitizedBase.url).hash, "");
});

test("Gamma query rejects unbounded, malformed, reversed, and zero-width windows", () => {
  for (const input of [
    {},
    { startTimeMin, startTimeMax: null },
    { startTimeMin: "not-a-time", startTimeMax },
    { startTimeMin: startTimeMax, startTimeMax: startTimeMin },
    { startTimeMin, startTimeMax: startTimeMin },
  ]) assert.throws(() => buildGammaKeysetRequest(input), (error) => error.code === "INVALID_WINDOW");
});

test("Gamma pagination dedupes identical identities but fails closed on cursor loops and conflicts", async () => {
  const first = await fixture("gamma-keyset-page-1.json");
  await assert.rejects(paginateGammaBtc15mMarkets({ startTimeMin, startTimeMax, fetchPage: async () => ({ data: [], next_cursor: "loop" }) }), (error) => error.code === "CURSOR_LOOP");

  const duplicatePage = { data: [structuredClone(first.data[0])], next_cursor: null };
  let call = 0;
  const deduped = await paginateGammaBtc15mMarkets({ startTimeMin, startTimeMax, fetchPage: async () => call++ === 0 ? first : duplicatePage });
  assert.equal(deduped.markets.length, 2);

  const conflict = structuredClone(first.data[0]); conflict.markets[0].clobTokenIds = ["different-up", "different-down"];
  call = 0;
  await assert.rejects(paginateGammaBtc15mMarkets({ startTimeMin, startTimeMax, fetchPage: async () => call++ === 0 ? first : { data: [conflict], next_cursor: null } }), (error) => error.code === "CONFLICTING_IDENTITY");
});

test("RTDS accepts only the exact millisecond boundary and preserves full decimal text", async () => {
  const frame = await fixture("rtds-twap-frame.json");
  const exact = parseRtdsBoundaryTwap(frame, boundary);
  assert.equal(exact.status, "OK"); assert.equal(exact.value, "112345.678901234567890123");
  assert.notEqual(exact.value, String(frame.payload.value));
  for (const delta of [-1, 1]) assert.equal(parseRtdsBoundaryTwap(frame, boundary + delta).status, "DATA_GAP");
});

test("Chainlink fallback uses only the exact observationsTimestamp boundary contract", async () => {
  const report = await fixture("chainlink-report.json");
  const expectedFeedId = report.feedID;
  assert.equal(parseChainlinkBoundaryReport(report, boundary, expectedFeedId).status, "OK");
  for (const deltaSeconds of [-1, 1]) {
    assert.equal(parseChainlinkBoundaryReport({ ...report, observationsTimestamp: report.observationsTimestamp + deltaSeconds }, boundary, expectedFeedId).status, "DATA_GAP");
  }
  assert.equal(parseChainlinkBoundaryReport({ ...report, observationsTimestamp: undefined, timestamp: report.observationsTimestamp }, boundary, expectedFeedId).status, "DATA_GAP");
  assert.equal(parseChainlinkBoundaryReport({ ...report, observationsTimestamp: boundary }, boundary, expectedFeedId).status, "DATA_GAP");
  const fallback = selectBoundaryTwap({ boundaryTimestampMs: boundary, chainlinkReport: report, expectedChainlinkFeedId: expectedFeedId });
  assert.equal(fallback.status, "OK"); assert.equal(fallback.source, "CHAINLINK_FALLBACK");
  assert.equal(selectBoundaryTwap({ boundaryTimestampMs: boundary, chainlinkReport: report }).status, "DATA_GAP");
  assert.equal(parseChainlinkBoundaryReport({ ...report, receivedAt: "2099-01-01T00:00:00.000Z" }, boundary, expectedFeedId).status, "OK");
});

test("Chainlink feed ID is injected, canonical V2, and exact for feedID or feedId", async () => {
  const report = await fixture("chainlink-report.json");
  const expected = report.feedID;
  assert.equal(canonicalizeChainlinkFeedId(expected.toUpperCase().replace("0X", "0x")), expected);
  for (const invalid of [null, "", "0x0002abcd", `0x0001${"a".repeat(60)}`, `0002${"a".repeat(60)}`]) {
    assert.equal(parseChainlinkBoundaryReport(report, boundary, invalid).status, "DATA_GAP");
  }
  assert.equal(parseChainlinkBoundaryReport({ ...report, feedID: undefined }, boundary, expected).status, "DATA_GAP");
  assert.equal(parseChainlinkBoundaryReport({ ...report, feedID: "malformed" }, boundary, expected).status, "DATA_GAP");
  const otherV2Feed = `0x0002${"b".repeat(60)}`;
  const feedIdAlias = { ...report, feedID: undefined, feedId: expected };
  assert.equal(parseChainlinkBoundaryReport(feedIdAlias, boundary, expected).status, "OK");
  assert.equal(parseChainlinkBoundaryReport({ ...report, feedId: expected }, boundary, expected).status, "OK");
  assert.equal(parseChainlinkBoundaryReport({ ...report, feedId: otherV2Feed }, boundary, expected).status, "QUARANTINED");
  assert.equal(parseChainlinkBoundaryReport({ ...report, feedID: otherV2Feed }, boundary, otherV2Feed).status, "OK");
  assert.equal(parseChainlinkBoundaryReport(report, boundary, otherV2Feed).status, "QUARANTINED");
  assert.equal(selectBoundaryTwap({ boundaryTimestampMs: boundary, rtdsFrame: await fixture("rtds-twap-frame.json"), chainlinkReport: report, expectedChainlinkFeedId: otherV2Feed }).status, "QUARANTINED");
});

test("TWAP source disagreement quarantines while exact agreement uses RTDS", async () => {
  const frame = await fixture("rtds-twap-frame.json"); const report = await fixture("chainlink-report.json");
  const expectedChainlinkFeedId = report.feedID;
  const agreed = selectBoundaryTwap({ boundaryTimestampMs: boundary, rtdsFrame: frame, chainlinkReport: report, expectedChainlinkFeedId });
  assert.equal(agreed.status, "OK"); assert.equal(agreed.source, "RTDS");
  const disagreement = selectBoundaryTwap({ boundaryTimestampMs: boundary, rtdsFrame: frame, chainlinkReport: { ...report, price: "112345.678901234567890124" }, expectedChainlinkFeedId });
  assert.equal(disagreement.status, "QUARANTINED"); assert.equal(disagreement.reason, "SOURCE_DISAGREEMENT");
});

test("CLOB book parser selects extrema from unsorted/permuted levels and emits compact provenance", async () => {
  const book = await fixture("clob-book-unsorted.json");
  const parsed = parseClobBook(book, "token-100-a-up");
  assert.equal(parsed.status, "OK");
  assert.deepEqual(parsed.summary, { tokenId: "token-100-a-up", bestBid: "0.47", bestAsk: "0.51", spread: "0.04", bidLevels: 3, askLevels: 3 });
  assert.equal(parsed.provenance.assetId, book.asset_id);
  assert.equal("bids" in parsed, false); assert.equal("asks" in parsed, false);
  const permuted = { ...book, bids: [...book.bids].reverse(), asks: [book.asks[1], book.asks[2], book.asks[0]] };
  assert.deepEqual(parseClobBook(permuted, book.asset_id).summary, parsed.summary);
});

test("CLOB book parser rejects token mismatch, malformed, out-of-range, crossed, and empty books", async () => {
  const book = await fixture("clob-book-unsorted.json");
  const cases = [
    [book, "wrong-token"],
    [{ ...book, bids: [] }, book.asset_id],
    [{ ...book, asks: [{ price: "not-decimal", size: "1" }] }, book.asset_id],
    [{ ...book, bids: [{ price: "1", size: "1" }] }, book.asset_id],
    [{ ...book, bids: [{ price: "0.60", size: "1" }], asks: [{ price: "0.59", size: "1" }] }, book.asset_id],
  ];
  for (const [candidate, token] of cases) assert.equal(parseClobBook(candidate, token).status, "DATA_GAP");
});

test("effective fee policy uses Decimal vectors while the 0.2 rebate stays observational", () => {
  const policy = { ...CRYPTO_FEE_POLICY_V2 };
  assert.deepEqual(policy, { feesEnabled: true, feeType: "crypto_fees_v2", rate: "0.07", exponent: 1, takerOnly: true, rebateRate: "0.2" });
  assert.deepEqual(calculateObservationalFee({ price: "0.5", shares: "100", ...policy }), {
    status: "OK", policy: "OBSERVATIONAL_ONLY", price: "0.5", shares: "100", ...policy,
    fee: "1.75", notional: "50", effectiveFeeRate: "0.035",
  });
  const second = calculateObservationalFee({ price: "0.2", shares: "10", ...policy });
  assert.equal(second.fee, "0.112"); assert.equal(second.notional, "2"); assert.equal(second.effectiveFeeRate, "0.056");
  assert.equal(calculateObservationalFee({ price: "0.5", ...policy }).status, "DATA_GAP");
  for (const mismatch of [
    { feesEnabled: false }, { feeType: "legacy" }, { rate: "0.070" }, { exponent: 2 }, { takerOnly: false }, { rebateRate: "0.1" },
  ]) assert.equal(calculateObservationalFee({ price: "0.5", shares: "100", ...policy, ...mismatch }).status, "DATA_GAP");
});
