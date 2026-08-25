import { ShortObserveContractError, mapExactUpDownTokens } from "./short-observe-contract.js";

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unresolved(reason) {
  return Object.freeze({ status: "UNRESOLVED", reason });
}

function expectedMarketKey(identity) {
  return identity?.conditionId || identity?.marketId || null;
}

export function parseClobMarketResolved(message, identity) {
  if (!message || typeof message !== "object" || message.event_type !== "market_resolved") return unresolved("NOT_MARKET_RESOLVED");
  const marketKey = expectedMarketKey(identity);
  if (!marketKey || message.market !== marketKey) return unresolved("MARKET_ID_MISMATCH");
  const assets = parseArray(message.assets_ids);
  if (!assets || assets.length !== 2 || !assets.includes(identity?.tokenIds?.UP) || !assets.includes(identity?.tokenIds?.DOWN)) {
    return unresolved("ASSET_SET_MISMATCH");
  }
  const winner = message.winning_asset_id;
  const outcome = winner === identity.tokenIds.UP ? "UP" : winner === identity.tokenIds.DOWN ? "DOWN" : null;
  if (!outcome) return unresolved("WINNING_ASSET_MISMATCH");
  const normalizedWinningOutcome = typeof message.winning_outcome === "string"
    ? message.winning_outcome.trim().toUpperCase()
    : null;
  if (normalizedWinningOutcome !== "UP" && normalizedWinningOutcome !== "DOWN") return unresolved("WINNING_OUTCOME_INVALID");
  if (normalizedWinningOutcome !== outcome) {
    return Object.freeze({
      status: "QUARANTINED",
      reason: "CLOB_WINNER_CONTRADICTION",
      signature: `CLOB_CONTRADICTION:${marketKey}:${winner}:${normalizedWinningOutcome}`,
    });
  }
  return Object.freeze({
    status: "RESOLVED",
    source: "CLOB_MARKET_RESOLVED",
    outcome,
    signature: `CLOB:${marketKey}:${winner}`,
    provenance: Object.freeze({ eventType: message.event_type, market: message.market, winningAssetId: winner }),
  });
}

function exactBinary(value) {
  return value === "0" || value === "1" ? value : null;
}

export function parseGammaResolvedMarket(market, identity) {
  if (!market || typeof market !== "object" || market.id !== identity?.marketId
      || market.conditionId !== identity?.conditionId
      || market.closed !== true || market.umaResolutionStatus !== "resolved") {
    return unresolved("GAMMA_MARKET_MISMATCH");
  }
  const outcomes = parseArray(market.outcomes);
  const tokenIds = parseArray(market.clobTokenIds);
  const prices = parseArray(market.outcomePrices);
  if (!outcomes || !tokenIds || !prices || outcomes.length !== 2 || tokenIds.length !== 2 || prices.length !== 2) {
    return unresolved("GAMMA_RESOLUTION_INCOMPLETE");
  }
  let mappedTokens;
  try {
    mappedTokens = mapExactUpDownTokens(outcomes, tokenIds);
  } catch (error) {
    if (error instanceof ShortObserveContractError) return unresolved("GAMMA_TOKEN_MAPPING_INVALID");
    throw error;
  }
  if (mappedTokens.UP !== identity.tokenIds.UP || mappedTokens.DOWN !== identity.tokenIds.DOWN) {
    return unresolved("GAMMA_TOKEN_MAPPING_MISMATCH");
  }
  const values = prices.map(exactBinary);
  if (values.some((value) => value === null) || values[0] === values[1]) return unresolved("GAMMA_PRICE_NOT_EXACT_BINARY");
  const winnerIndex = values[0] === "1" && values[1] === "0" ? 0 : values[0] === "0" && values[1] === "1" ? 1 : -1;
  if (winnerIndex < 0) return unresolved("GAMMA_PRICE_NOT_EXACT_BINARY");
  const label = String(outcomes[winnerIndex]).toUpperCase();
  if (label !== "UP" && label !== "DOWN") return unresolved("GAMMA_OUTCOME_INVALID");
  return Object.freeze({
    status: "RESOLVED",
    source: "GAMMA",
    outcome: label,
    signature: `GAMMA:${market.id}:${label}`,
    provenance: Object.freeze({ marketId: market.id, outcomePrices: Object.freeze([...values]) }),
  });
}

export function createShortResolutionState(identity) {
  if (!identity?.marketId || !identity?.tokenIds?.UP || !identity?.tokenIds?.DOWN) throw new TypeError("canonical market identity is required");
  return Object.freeze({
    identity,
    status: "UNRESOLVED",
    outcome: null,
    source: null,
    clobOutcome: null,
    gammaOutcome: null,
    seen: Object.freeze([]),
    reason: null,
  });
}

function parsedObservation(observation, identity) {
  if (observation?.source === "CLOB") return parseClobMarketResolved(observation.message, identity);
  if (observation?.source === "GAMMA") return parseGammaResolvedMarket(observation.market, identity);
  if (observation?.event_type === "market_resolved") return parseClobMarketResolved(observation, identity);
  if (observation?.outcomePrices !== undefined) return parseGammaResolvedMarket(observation, identity);
  return unresolved("UNSUPPORTED_OBSERVATION");
}

export function reduceShortResolution(state, observation) {
  if (!state?.identity || !Array.isArray(state.seen)) throw new TypeError("resolution state is required");
  if (state.status === "QUARANTINED") return state;
  const parsed = parsedObservation(observation, state.identity);
  if (parsed.status === "QUARANTINED") {
    const seen = parsed.signature && !state.seen.includes(parsed.signature)
      ? Object.freeze([...state.seen, parsed.signature])
      : state.seen;
    return Object.freeze({ ...state, status: "QUARANTINED", outcome: null, source: null, seen, reason: parsed.reason });
  }
  if (parsed.status !== "RESOLVED") return state;
  if (state.seen.includes(parsed.signature)) return state;

  const seen = Object.freeze([...state.seen, parsed.signature]);
  const clobOutcome = parsed.source === "CLOB_MARKET_RESOLVED" ? parsed.outcome : state.clobOutcome;
  const gammaOutcome = parsed.source === "GAMMA" ? parsed.outcome : state.gammaOutcome;
  if ((state.clobOutcome && parsed.source === "CLOB_MARKET_RESOLVED" && state.clobOutcome !== parsed.outcome)
      || (state.gammaOutcome && parsed.source === "GAMMA" && state.gammaOutcome !== parsed.outcome)
      || (clobOutcome && gammaOutcome && clobOutcome !== gammaOutcome)) {
    return Object.freeze({ ...state, status: "QUARANTINED", outcome: null, source: null, clobOutcome, gammaOutcome, seen, reason: "SOURCE_DISAGREEMENT" });
  }

  const outcome = clobOutcome || gammaOutcome;
  const source = clobOutcome ? "CLOB_MARKET_RESOLVED" : "GAMMA";
  return Object.freeze({ ...state, status: "RESOLVED", outcome, source, clobOutcome, gammaOutcome, seen, reason: null });
}

export function evaluateShortResolution(identity, observations = []) {
  if (!Array.isArray(observations)) throw new TypeError("observations must be an array");
  return observations.reduce(reduceShortResolution, createShortResolutionState(identity));
}
