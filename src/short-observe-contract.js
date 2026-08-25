export const SHORT_OBSERVE_SERIES_ID = "10192";
export const SHORT_OBSERVE_ASSET = "BTC";
export const SHORT_OBSERVE_DURATION = "15m";
export const SHORT_OBSERVE_DURATION_MS = 900_000;
export const SHORT_OBSERVE_CRYPTO_FINGERPRINT = Object.freeze({
  id: "btc-15m-twap-60",
  asset: "btc",
  duration: "15m",
  twapEnabled: true,
  twapLookbackSeconds: 60,
});

export class ShortObserveContractError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ShortObserveContractError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) {
  throw new ShortObserveContractError(code, message, details);
}

function exactObject(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !expected || typeof expected !== "object" || Array.isArray(expected)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key]);
}

function parseExactArray(value, field) {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { fail("INVALID_ARRAY", `${field} must be a JSON array`); }
  }
  if (!Array.isArray(parsed)) fail("INVALID_ARRAY", `${field} must be an array`);
  return parsed;
}

function exactIso(value, field) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail("MISSING_TIME", `${field} must be an explicit timestamp`);
  }
  return value;
}

function exactSeries(event) {
  if (!Array.isArray(event?.series)) fail("SERIES_MISMATCH", "event.series must be present");
  if (event.series.length !== 1 || event.series[0]?.id !== SHORT_OBSERVE_SERIES_ID) {
    fail("SERIES_MISMATCH", `event must belong exactly to series ${SHORT_OBSERVE_SERIES_ID}`);
  }
}

export function mapExactUpDownTokens(outcomesValue, tokenIdsValue) {
  const outcomes = parseExactArray(outcomesValue, "outcomes");
  const tokenIds = parseExactArray(tokenIdsValue, "clobTokenIds");
  if (outcomes.length !== tokenIds.length || outcomes.length !== 2) {
    fail("TOKEN_MAPPING_INVALID", "outcomes and clobTokenIds must contain exactly two aligned values");
  }
  const mapped = {};
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = String(outcomes[index]);
    const side = outcome.toUpperCase();
    const tokenId = tokenIds[index];
    if (!["UP", "DOWN"].includes(side) || typeof tokenId !== "string" || !tokenId) {
      fail("TOKEN_MAPPING_INVALID", "only explicit UP and DOWN outcomes with string token ids are accepted");
    }
    if (mapped[side]) fail("TOKEN_MAPPING_INVALID", `${side} is duplicated`);
    mapped[side] = tokenId;
  }
  if (!mapped.UP || !mapped.DOWN || mapped.UP === mapped.DOWN) {
    fail("TOKEN_MAPPING_INVALID", "UP and DOWN token ids must be present and distinct");
  }
  return Object.freeze({ UP: mapped.UP, DOWN: mapped.DOWN });
}

export function parseBtc15mGammaEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) fail("INVALID_EVENT", "Gamma event must be an object");
  exactSeries(event);
  if (!exactObject(event.cryptoFingerprint, SHORT_OBSERVE_CRYPTO_FINGERPRINT)) {
    fail("CRYPTO_FINGERPRINT_MISMATCH", "Gamma crypto fingerprint does not exactly match BTC 15m TWAP-60");
  }
  const eventStartTime = exactIso(event.startTime, "event.startTime");
  if (typeof event.id !== "string" || !event.id) fail("INVALID_EVENT", "event.id is required");
  if (!Array.isArray(event.markets) || event.markets.length === 0) fail("NO_MARKETS", "event.markets must not be empty");

  return event.markets.map((market, nestedIndex) => {
    if (!market || typeof market !== "object" || Array.isArray(market)) fail("INVALID_MARKET", "nested market must be an object", { nestedIndex });
    const marketId = typeof market.id === "string" && market.id ? market.id : fail("INVALID_MARKET", "market.id is required", { nestedIndex });
    const conditionId = typeof market.conditionId === "string" && market.conditionId
      ? market.conditionId
      : fail("INVALID_MARKET", "market.conditionId is required", { nestedIndex, marketId });
    const nestedStartTime = exactIso(market.eventStartTime, "market.eventStartTime");
    if (nestedStartTime !== eventStartTime) {
      fail("START_TIME_MISMATCH", "event.startTime must exactly equal market.eventStartTime", { marketId });
    }
    const endTime = exactIso(market.endDate, "market.endDate");
    const startMs = Date.parse(nestedStartTime);
    const endMs = Date.parse(endTime);
    if (endMs - startMs !== SHORT_OBSERVE_DURATION_MS) {
      fail("DURATION_MISMATCH", "market interval must be exactly 900000ms", { marketId, durationMs: endMs - startMs });
    }
    const tokenIds = mapExactUpDownTokens(market.outcomes, market.clobTokenIds);
    return Object.freeze({
      eventId: event.id,
      marketId,
      conditionId,
      seriesId: SHORT_OBSERVE_SERIES_ID,
      asset: SHORT_OBSERVE_ASSET,
      durationType: SHORT_OBSERVE_DURATION,
      startTime: nestedStartTime,
      endTime,
      startMs,
      endMs,
      cryptoFingerprint: SHORT_OBSERVE_CRYPTO_FINGERPRINT,
      tokenIds,
    });
  });
}

export function shortMarketIdentityKey(identity) {
  if (identity?.seriesId !== SHORT_OBSERVE_SERIES_ID || typeof identity.marketId !== "string" || !identity.marketId) {
    fail("INVALID_IDENTITY", `seriesId ${SHORT_OBSERVE_SERIES_ID} and marketId are required`);
  }
  return `${identity.seriesId}:${identity.marketId}`;
}

export function sameShortMarketIdentity(left, right) {
  if (!left || !right) return false;
  return left.eventId === right.eventId
    && left.marketId === right.marketId
    && left.conditionId === right.conditionId
    && left.seriesId === right.seriesId
    && left.asset === right.asset
    && left.durationType === right.durationType
    && left.startTime === right.startTime
    && left.endTime === right.endTime
    && left.startMs === right.startMs
    && left.endMs === right.endMs
    && exactObject(left.cryptoFingerprint, right.cryptoFingerprint)
    && left.tokenIds?.UP === right.tokenIds?.UP
    && left.tokenIds?.DOWN === right.tokenIds?.DOWN;
}

export function parseBtc15mGammaEvents(events) {
  if (!Array.isArray(events)) fail("INVALID_PAGE", "Gamma page events must be an array");
  return events.flatMap(parseBtc15mGammaEvent);
}
