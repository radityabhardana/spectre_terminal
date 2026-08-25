import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseBtc15mGammaEvent } from "../src/short-observe-contract.js";
import {
  createShortResolutionState,
  evaluateShortResolution,
  parseClobMarketResolved,
  parseGammaResolvedMarket,
  reduceShortResolution,
} from "../src/short-resolution-evaluator.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "short-observer");
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(fixtureDir, name), "utf8"));

async function context() {
  const page = await fixture("gamma-keyset-page-1.json");
  return {
    identity: parseBtc15mGammaEvent(page.data[0])[0],
    clob: await fixture("clob-market-resolved.json"),
    gamma: await fixture("gamma-resolved.json"),
  };
}

test("valid matching CLOB market_resolved wins first and event_message null is harmless", async () => {
  const { identity, clob } = await context();
  const parsed = parseClobMarketResolved(clob, identity);
  assert.equal(parsed.status, "RESOLVED"); assert.equal(parsed.outcome, "UP");
  assert.equal(parseClobMarketResolved({ ...clob, winning_outcome: "  up " }, identity).status, "RESOLVED");
  const state = evaluateShortResolution(identity, [clob]);
  assert.equal(state.status, "RESOLVED"); assert.equal(state.source, "CLOB_MARKET_RESOLVED"); assert.equal(state.outcome, "UP");
  assert.equal("tradingResult" in state, false);
});

test("strict resolved Gamma string [1,0]/[0,1] is fallback; approximate, numeric, and ties stay unresolved", async () => {
  const { identity, gamma } = await context();
  assert.equal(parseGammaResolvedMarket(gamma, identity).outcome, "UP");
  const down = { ...gamma, outcomePrices: ["0", "1"] };
  assert.equal(parseGammaResolvedMarket(down, identity).outcome, "DOWN");
  for (const prices of [["0.999", "0.001"], ["0.5", "0.5"], ["1.0", "0.0"], [1, 0], "[1,0]"]) {
    assert.equal(parseGammaResolvedMarket({ ...gamma, outcomePrices: prices }, identity).status, "UNRESOLVED");
  }
  const state = evaluateShortResolution(identity, [gamma]);
  assert.equal(state.status, "RESOLVED"); assert.equal(state.source, "GAMMA"); assert.equal(state.outcome, "UP");
});

test("Gamma closed-but-unresolved, missing singular status, and legacy status arrays do not resolve", async () => {
  const { identity, gamma } = await context();
  for (const candidate of [
    { ...gamma, umaResolutionStatus: "proposed" },
    { ...gamma, umaResolutionStatus: undefined },
    { ...gamma, umaResolutionStatus: undefined, umaResolutionStatuses: ["resolved"] },
    { ...gamma, closed: false, umaResolutionStatus: "resolved" },
    { ...gamma, closed: 1, umaResolutionStatus: "resolved" },
    { ...gamma, umaResolutionStatus: "Resolved" },
  ]) assert.equal(parseGammaResolvedMarket(candidate, identity).status, "UNRESOLVED");
});

test("CLOB winning token and normalized outcome contradictions quarantine", async () => {
  const { identity, clob } = await context();
  const contradictions = [
    { ...clob, winning_outcome: "Down" },
    { ...clob, winning_asset_id: identity.tokenIds.DOWN, winning_outcome: "Up" },
  ];
  for (const contradictory of contradictions) {
    const parsed = parseClobMarketResolved(contradictory, identity);
    assert.equal(parsed.status, "QUARANTINED"); assert.equal(parsed.reason, "CLOB_WINNER_CONTRADICTION");
    const state = evaluateShortResolution(identity, [contradictory]);
    assert.equal(state.status, "QUARANTINED"); assert.equal(state.outcome, null); assert.equal(state.reason, "CLOB_WINNER_CONTRADICTION");
  }
});

test("resolution duplicates are idempotent and agreeing CLOB supersedes Gamma fallback", async () => {
  const { identity, clob, gamma } = await context();
  const initial = createShortResolutionState(identity);
  const first = reduceShortResolution(initial, gamma);
  assert.strictEqual(reduceShortResolution(first, gamma), first);
  const final = reduceShortResolution(first, clob);
  assert.equal(final.status, "RESOLVED"); assert.equal(final.source, "CLOB_MARKET_RESOLVED"); assert.equal(final.outcome, "UP");
  assert.strictEqual(reduceShortResolution(final, clob), final);
});

test("source disagreement quarantines in either arrival order", async () => {
  const { identity, clob, gamma } = await context();
  const gammaDown = { ...gamma, outcomePrices: ["0", "1"] };
  for (const observations of [[clob, gammaDown], [gammaDown, clob]]) {
    const state = evaluateShortResolution(identity, observations);
    assert.equal(state.status, "QUARANTINED"); assert.equal(state.reason, "SOURCE_DISAGREEMENT"); assert.equal(state.outcome, null); assert.equal(state.source, null);
  }
});

test("nonmatching CLOB and incomplete Gamma observations do not fabricate resolution", async () => {
  const { identity, clob, gamma } = await context();
  const observations = [
    { ...clob, market: "other-condition" },
    { ...clob, winning_asset_id: "unknown-token" },
    { ...gamma, conditionId: "other-condition" },
    { ...gamma, closed: false },
    { ...gamma, outcomePrices: null },
  ];
  const state = evaluateShortResolution(identity, observations);
  assert.equal(state.status, "UNRESOLVED"); assert.equal(state.outcome, null);
});
