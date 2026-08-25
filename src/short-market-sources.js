import Decimal from "decimal.js";
import {
  SHORT_OBSERVE_SERIES_ID,
  ShortObserveContractError,
  parseBtc15mGammaEvents,
  sameShortMarketIdentity,
  shortMarketIdentityKey,
} from "./short-observe-contract.js";

const ExactDecimal = Decimal.clone({ precision: 50, rounding: Decimal.ROUND_HALF_UP });
const ExactDecimal_E18 = new ExactDecimal("1e18");

export const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events/keyset";
export const GAMMA_KEYSET_PAGE_SIZE = 100;
export const RTDS_TWAP_TOPIC = "crypto_prices_twap_sixty";
export const RTDS_BTC_SYMBOL = "btc/usd";
export const CRYPTO_FEE_POLICY_V2 = Object.freeze({
  feesEnabled: true,
  feeType: "crypto_fees_v2",
  rate: "0.07",
  exponent: 1,
  takerOnly: true,
  rebateRate: "0.2",
});

function dataGap(reason, details = null) {
  return { status: "DATA_GAP", reason, details };
}

function quarantined(reason, details = null) {
  return { status: "QUARANTINED", reason, details };
}

function decimalText(value, field, { allowZero = false, maxOne = false } = {}) {
  if (typeof value !== "string" || value !== value.trim() || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new ShortObserveContractError("INVALID_DECIMAL", `${field} must be plain decimal text`);
  }
  const decimal = new ExactDecimal(value);
  if (!decimal.isFinite() || (allowZero ? decimal.isNegative() : !decimal.isPositive()) || (maxOne && decimal.gt(1))) {
    throw new ShortObserveContractError("INVALID_DECIMAL", `${field} is outside its accepted range`);
  }
  return decimal;
}

function exactIso(value, field) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ShortObserveContractError("INVALID_WINDOW", `${field} must be a canonical ISO timestamp`);
  }
  return parsed;
}

export function buildGammaKeysetRequest({ startTimeMin, startTimeMax, cursor = null, baseUrl = GAMMA_EVENTS_URL } = {}) {
  const startMs = exactIso(startTimeMin, "startTimeMin");
  const endMs = exactIso(startTimeMax, "startTimeMax");
  if (endMs <= startMs) throw new ShortObserveContractError("INVALID_WINDOW", "startTimeMax must be later than startTimeMin");
  if (cursor !== null && (typeof cursor !== "string" || !cursor)) {
    throw new ShortObserveContractError("INVALID_CURSOR", "Gamma cursor must be null or a non-empty string");
  }
  const query = {
    series_id: SHORT_OBSERVE_SERIES_ID,
    closed: "false",
    start_time_min: startTimeMin,
    start_time_max: startTimeMax,
    limit: String(GAMMA_KEYSET_PAGE_SIZE),
  };
  if (cursor !== null) query.after_cursor = cursor;
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return Object.freeze({ url: url.toString(), query: Object.freeze(query), cursor });
}

function exactGammaPage(page) {
  if (!page || typeof page !== "object" || Array.isArray(page) || !Array.isArray(page.data)) {
    throw new ShortObserveContractError("INVALID_PAGE", "Gamma keyset page must contain a data array");
  }
  const nextCursor = page.next_cursor;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor)) {
    throw new ShortObserveContractError("INVALID_CURSOR", "next_cursor must be null or a non-empty string");
  }
  return { events: page.data, nextCursor };
}

export async function paginateGammaBtc15mMarkets({ fetchPage, startTimeMin, startTimeMax, signal = null, baseUrl = GAMMA_EVENTS_URL } = {}) {
  if (typeof fetchPage !== "function") throw new TypeError("fetchPage injection is required");
  const seenCursors = new Set();
  const identitiesByKey = new Map();
  const events = [];
  let cursor = null;
  let pageCount = 0;

  for (;;) {
    if (signal?.aborted) throw signal.reason || new Error("Gamma pagination aborted");
    const request = buildGammaKeysetRequest({ startTimeMin, startTimeMax, cursor, baseUrl });
    const page = exactGammaPage(await fetchPage(request, { signal }));
    pageCount += 1;
    const identities = parseBtc15mGammaEvents(page.events);
    for (const identity of identities) {
      const key = shortMarketIdentityKey(identity);
      const existing = identitiesByKey.get(key);
      if (existing) {
        if (sameShortMarketIdentity(existing, identity)) continue;
        throw new ShortObserveContractError("CONFLICTING_IDENTITY", `${key} has conflicting metadata across Gamma pages`);
      }
      identitiesByKey.set(key, identity);
    }
    events.push(...page.events);
    if (page.nextCursor === null) break;
    if (page.nextCursor === cursor || seenCursors.has(page.nextCursor)) {
      throw new ShortObserveContractError("CURSOR_LOOP", `Gamma cursor repeated: ${page.nextCursor}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return Object.freeze({
    status: "OK",
    pageCount,
    events: Object.freeze(events),
    markets: Object.freeze([...identitiesByKey.values()]),
  });
}

function boundaryMs(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

// Live RTDS frames carry full_accuracy_value as an E18 fixed-point integer
// string (price * 1e18). Rescale exactly (decimal shift) for USD consumption
// and cross-source comparison; non-integer legacy text stays unscaled.
function rescaleRtdsValue(rawValue) {
  const text = String(rawValue ?? "").trim();
  if (!/^-?\d+$/.test(text)) return null;
  try {
    const usdPriceText = new ExactDecimal(text).div(ExactDecimal_E18).toFixed();
    return Object.freeze({ usdPriceText, usdPrice: Number(usdPriceText) });
  } catch {
    return null;
  }
}

export function parseRtdsBoundaryTwap(frame, boundaryTimestampMs) {
  const boundary = boundaryMs(boundaryTimestampMs);
  if (boundary === null) return dataGap("INVALID_BOUNDARY");
  if (!frame || typeof frame !== "object" || frame.topic !== RTDS_TWAP_TOPIC || frame.type !== "update") {
    return dataGap("RTDS_FRAME_MISMATCH");
  }
  const payload = frame.payload;
  if (!payload || typeof payload !== "object" || payload.symbol !== RTDS_BTC_SYMBOL) return dataGap("RTDS_FRAME_MISMATCH");
  if (!Number.isSafeInteger(payload.timestamp) || payload.timestamp !== boundary) return dataGap("RTDS_BOUNDARY_MISMATCH");
  try {
    decimalText(payload.full_accuracy_value, "payload.full_accuracy_value");
  } catch (error) {
    return dataGap(error.code || "RTDS_VALUE_INVALID");
  }
  const rescaled = rescaleRtdsValue(payload.full_accuracy_value);
  if (!rescaled || !Number.isFinite(rescaled.usdPrice) || rescaled.usdPrice <= 0) {
    return dataGap("RTDS_VALUE_SCALE_INVALID");
  }
  return Object.freeze({
    status: "OK",
    source: "RTDS",
    timestampMs: boundary,
    value: payload.full_accuracy_value,
    usdPriceText: rescaled.usdPriceText,
    usdPrice: rescaled.usdPrice,
    provenance: Object.freeze({ topic: frame.topic, type: frame.type, symbol: payload.symbol, field: "full_accuracy_value", scale: "E18" }),
  });
}

export function parseRtdsCurrentSnapshot(frame, {
  topic = RTDS_TWAP_TOPIC,
  symbol = RTDS_BTC_SYMBOL,
  nowMs = Date.now(),
  maxAgeMs = 15_000,
  maxFutureSkewMs = 2_000,
} = {}) {
  if (typeof topic !== "string" || !topic || typeof symbol !== "string" || !symbol) return dataGap("RTDS_EXPECTED_SOURCE_INVALID");
  if (!Number.isSafeInteger(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || !Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) {
    return dataGap("RTDS_CURRENT_WINDOW_INVALID");
  }
  if (!frame || typeof frame !== "object" || frame.topic !== topic || frame.type !== "update") {
    return dataGap("RTDS_FRAME_MISMATCH");
  }
  const payload = frame.payload;
  if (!payload || typeof payload !== "object" || payload.symbol !== symbol) return dataGap("RTDS_FRAME_MISMATCH");
  if (!Number.isSafeInteger(payload.timestamp)) return dataGap("RTDS_TIMESTAMP_INVALID");
  const ageMs = nowMs - payload.timestamp;
  if (ageMs > maxAgeMs) return dataGap("RTDS_TIMESTAMP_STALE");
  if (ageMs < -maxFutureSkewMs) return dataGap("RTDS_TIMESTAMP_FUTURE");
  try {
    decimalText(payload.full_accuracy_value, "payload.full_accuracy_value");
  } catch (error) {
    return dataGap(error.code || "RTDS_VALUE_INVALID");
  }
  const rescaled = rescaleRtdsValue(payload.full_accuracy_value);
  if (!rescaled || !Number.isFinite(rescaled.usdPrice) || rescaled.usdPrice <= 0) {
    return dataGap("RTDS_VALUE_SCALE_INVALID");
  }
  return Object.freeze({
    status: "OK",
    source: "RTDS",
    timestampMs: payload.timestamp,
    value: payload.full_accuracy_value,
    usdPriceText: rescaled.usdPriceText,
    usdPrice: rescaled.usdPrice,
    provenance: Object.freeze({ topic: frame.topic, type: frame.type, symbol: payload.symbol, field: "full_accuracy_value", scale: "E18" }),
  });
}

export function canonicalizeChainlinkFeedId(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const canonical = `0x${value.slice(2).toLowerCase()}`;
  return canonical.startsWith("0x0002") ? canonical : null;
}

export function parseChainlinkBoundaryReport(report, boundaryTimestampMs, expectedFeedId) {
  const boundary = boundaryMs(boundaryTimestampMs);
  if (boundary === null) return dataGap("INVALID_BOUNDARY");
  const expected = canonicalizeChainlinkFeedId(expectedFeedId);
  if (!expected) return dataGap("CHAINLINK_EXPECTED_FEED_ID_INVALID");
  if (!report || typeof report !== "object" || !Number.isSafeInteger(report.observationsTimestamp)) {
    return dataGap("CHAINLINK_REPORT_INVALID");
  }
  const hasFeedID = Object.hasOwn(report, "feedID") && report.feedID !== undefined;
  const hasFeedId = Object.hasOwn(report, "feedId") && report.feedId !== undefined;
  if (hasFeedID && hasFeedId) {
    const upperVariant = canonicalizeChainlinkFeedId(report.feedID);
    const lowerVariant = canonicalizeChainlinkFeedId(report.feedId);
    if (!upperVariant || !lowerVariant) return dataGap("CHAINLINK_FEED_ID_INVALID");
    if (upperVariant !== lowerVariant) return quarantined("CHAINLINK_REPORT_FEED_ID_CONFLICT");
  }
  const reportedFeedId = hasFeedID ? report.feedID : report.feedId;
  const reported = canonicalizeChainlinkFeedId(reportedFeedId);
  if (!reported) return dataGap("CHAINLINK_FEED_ID_INVALID");
  if (reported !== expected) return quarantined("CHAINLINK_FEED_ID_MISMATCH", Object.freeze({ expected, reported }));
  if (boundary % 1000 !== 0 || report.observationsTimestamp !== boundary / 1000) return dataGap("CHAINLINK_BOUNDARY_MISMATCH");
  try {
    decimalText(report.price, "report.price");
  } catch (error) {
    return dataGap(error.code || "CHAINLINK_VALUE_INVALID");
  }
  return Object.freeze({
    status: "OK",
    source: "CHAINLINK",
    timestampMs: boundary,
    observationsTimestamp: report.observationsTimestamp,
    feedId: reported,
    value: report.price,
    provenance: Object.freeze({ field: "price", timestampField: "observationsTimestamp", feedId: reported }),
  });
}

export function selectBoundaryTwap({
  boundaryTimestampMs,
  rtdsFrame = null,
  chainlinkReport = null,
  expectedChainlinkFeedId = null,
} = {}) {
  const boundary = boundaryMs(boundaryTimestampMs);
  if (boundary === null) return dataGap("INVALID_BOUNDARY");

  const rtds = parseRtdsBoundaryTwap(rtdsFrame, boundary);
  const chainlink = parseChainlinkBoundaryReport(chainlinkReport, boundary, expectedChainlinkFeedId);
  if (chainlink.status === "QUARANTINED") return chainlink;
  if (rtds.status === "OK" && chainlink.status === "OK") {
    // Compare exact USD-scale values: RTDS text is E18 fixed-point while the
    // Chainlink report price is plain decimal.
    const comparisonText = rtds.usdPriceText ?? rtds.value;
    if (!new ExactDecimal(comparisonText).eq(chainlink.value)) {
      return quarantined("SOURCE_DISAGREEMENT", Object.freeze({ rtds: rtds.value, chainlink: chainlink.value }));
    }
    return Object.freeze({ status: "OK", source: "RTDS", value: rtds.value, usdPriceText: rtds.usdPriceText, usdPrice: rtds.usdPrice, timestampMs: boundary, corroboratedBy: "CHAINLINK", provenance: Object.freeze({ rtds: rtds.provenance, chainlink: chainlink.provenance }) });
  }
  if (rtds.status === "OK") return rtds;
  if (chainlink.status === "OK") return Object.freeze({ ...chainlink, source: "CHAINLINK_FALLBACK" });
  return dataGap("BOUNDARY_VALUE_UNAVAILABLE", Object.freeze({ rtds: rtds.reason, chainlink: chainlink.reason }));
}

function parseBookLevels(levels, side) {
  if (!Array.isArray(levels) || levels.length === 0) throw new ShortObserveContractError("EMPTY_BOOK", `${side} levels are required`);
  return levels.map((level, index) => {
    if (!level || typeof level !== "object" || Array.isArray(level)) throw new ShortObserveContractError("MALFORMED_BOOK", `${side}[${index}] is malformed`);
    const price = decimalText(level.price, `${side}[${index}].price`, { maxOne: true });
    if (price.eq(0) || price.eq(1)) throw new ShortObserveContractError("PRICE_OUT_OF_RANGE", `${side}[${index}].price must be strictly between zero and one`);
    decimalText(level.size, `${side}[${index}].size`);
    return { price, priceText: level.price, sizeText: level.size };
  });
}

export function parseClobBook(book, requestedTokenId) {
  if (typeof requestedTokenId !== "string" || !requestedTokenId) return dataGap("REQUESTED_TOKEN_INVALID");
  if (!book || typeof book !== "object" || book.asset_id !== requestedTokenId) return dataGap("ASSET_ID_MISMATCH");
  try {
    const bids = parseBookLevels(book.bids, "bids");
    const asks = parseBookLevels(book.asks, "asks");
    const bestBid = bids.reduce((best, level) => level.price.gt(best.price) ? level : best);
    const bestAsk = asks.reduce((best, level) => level.price.lt(best.price) ? level : best);
    if (bestBid.price.gte(bestAsk.price)) return dataGap("CROSSED_BOOK");
    return Object.freeze({
      status: "OK",
      summary: Object.freeze({
        tokenId: requestedTokenId,
        bestBid: bestBid.priceText,
        bestAsk: bestAsk.priceText,
        spread: bestAsk.price.minus(bestBid.price).toString(),
        bidLevels: bids.length,
        askLevels: asks.length,
      }),
      provenance: Object.freeze({ source: "POLYMARKET_CLOB", assetId: book.asset_id, timestamp: book.timestamp == null ? null : String(book.timestamp) }),
    });
  } catch (error) {
    return dataGap(error.code || "MALFORMED_BOOK");
  }
}

export function calculateObservationalFee({
  price,
  shares,
  feesEnabled,
  feeType,
  rate,
  exponent,
  takerOnly,
  rebateRate,
} = {}) {
  try {
    if (feesEnabled !== CRYPTO_FEE_POLICY_V2.feesEnabled
        || feeType !== CRYPTO_FEE_POLICY_V2.feeType
        || rate !== CRYPTO_FEE_POLICY_V2.rate
        || exponent !== CRYPTO_FEE_POLICY_V2.exponent
        || takerOnly !== CRYPTO_FEE_POLICY_V2.takerOnly
        || rebateRate !== CRYPTO_FEE_POLICY_V2.rebateRate) {
      throw new ShortObserveContractError("FEE_POLICY_MISMATCH", "fee policy must exactly match crypto_fees_v2 observational metadata");
    }
    const p = decimalText(price, "price", { maxOne: true });
    if (p.eq(0) || p.eq(1)) throw new ShortObserveContractError("PRICE_OUT_OF_RANGE", "price must be strictly between zero and one");
    const quantity = decimalText(shares, "shares");
    const feeRate = decimalText(rate, "rate", { allowZero: true });
    if (!Number.isSafeInteger(exponent) || exponent < 0) throw new ShortObserveContractError("INVALID_EXPONENT", "exponent must be a non-negative safe integer");
    const curve = p.mul(new ExactDecimal(1).minus(p)).pow(exponent);
    const fee = quantity.mul(feeRate).mul(curve);
    const notional = quantity.mul(p);
    return Object.freeze({
      status: "OK",
      policy: "OBSERVATIONAL_ONLY",
      price,
      shares,
      feesEnabled,
      feeType,
      rate,
      exponent,
      takerOnly,
      rebateRate,
      fee: fee.toString(),
      notional: notional.toString(),
      effectiveFeeRate: notional.isZero() ? null : fee.div(notional).toString(),
    });
  } catch (error) {
    return dataGap(error.code || "FEE_INPUT_INVALID");
  }
}

export const observeFeePolicy = calculateObservationalFee;
