import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SHORT_OBSERVE_CRYPTO_FINGERPRINT,
  ShortObserveContractError,
  parseBtc15mGammaEvent,
} from "../src/short-observe-contract.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "short-observer");
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(fixtureDir, name), "utf8"));

test("fixture manifest declares honest provenance, exact schema retrieval, and scoped file digests", async () => {
  const manifest = await fixture("manifest.json");
  assert.equal(manifest.manifestVersion, 2);
  assert.equal(new Date(manifest.generatedAt).toISOString(), manifest.generatedAt);
  const fixtureFiles = (await fs.readdir(fixtureDir)).filter((file) => file !== "manifest.json").sort();
  assert.deepEqual(manifest.fixtures.map((item) => item.file).sort(), fixtureFiles);
  const provenanceValues = new Set(["raw_official_capture", "sanitized_official_capture", "schema_derived_synthetic"]);
  for (const item of manifest.fixtures) {
    assert.ok(provenanceValues.has(item.provenance));
    assert.equal(typeof item.source.request, "object");
    assert.match(item.source.schemaDocumentation, /^https:\/\//);
    assert.equal(new Date(item.source.schemaRetrievedAt).toISOString(), item.source.schemaRetrievedAt);
    if (item.provenance === "sanitized_official_capture") {
      assert.ok(Array.isArray(item.transformations) && item.transformations.length > 0);
    }
    if (item.provenance === "schema_derived_synthetic") {
      assert.equal(item.observed, false);
      assert.match(item.generator?.name || "", /.+/);
      assert.match(item.generator?.version || "", /^\d+\.\d+\.\d+$/);
      assert.equal("transformations" in item, false);
    }
    assert.deepEqual(Object.keys(item.digest).sort(), ["algorithm", "scope", "value"]);
    assert.deepEqual({ algorithm: item.digest.algorithm, scope: item.digest.scope }, { algorithm: "sha256", scope: "fixture_file_bytes" });
    const bytes = await fs.readFile(path.join(fixtureDir, item.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.digest.value);
    assert.equal("rawBodySha256" in item, false);
    assert.equal("parent" in item, false);
  }
  assert.deepEqual(new Set(manifest.fixtures.map((item) => item.provenance)), new Set(["schema_derived_synthetic"]));
  const gammaRequest = manifest.fixtures.find((item) => item.file === "gamma-keyset-page-1.json").source.request;
  assert.deepEqual(gammaRequest.query, { series_id: "10192", closed: "false", start_time_min: "2026-08-25T12:00:00.000Z", start_time_max: "2026-08-25T12:30:00.000Z", limit: "100" });
});

test("identity contract processes every nested market and maps permuted UP/DOWN tokens", async () => {
  const page = await fixture("gamma-keyset-page-1.json");
  const identities = parseBtc15mGammaEvent(page.data[0]);
  assert.equal(identities.length, 2);
  assert.deepEqual(identities.map((identity) => identity.marketId), ["market-100-a", "market-100-b"]);
  assert.deepEqual(identities[0].tokenIds, { UP: "token-100-a-up", DOWN: "token-100-a-down" });
  assert.deepEqual(identities[1].tokenIds, { UP: "token-100-b-up", DOWN: "token-100-b-down" });
  assert.equal(identities[0].seriesId, "10192");
  assert.equal(identities[0].asset, "BTC");
  assert.equal(identities[0].durationType, "15m");
  assert.deepEqual(identities[0].cryptoFingerprint, SHORT_OBSERVE_CRYPTO_FINGERPRINT);
  const permuted = structuredClone(page.data[0]); permuted.markets.reverse();
  assert.deepEqual(parseBtc15mGammaEvent(permuted).map((identity) => identity.marketId), ["market-100-b", "market-100-a"]);
});

test("identity contract rejects ±1ms start boundaries and 899999/900001ms intervals", async () => {
  const original = (await fixture("gamma-keyset-page-1.json")).data[0];
  for (const delta of [-1, 1]) {
    const event = structuredClone(original);
    event.markets[0].eventStartTime = new Date(Date.parse(event.startTime) + delta).toISOString();
    assert.throws(() => parseBtc15mGammaEvent(event), (error) => error instanceof ShortObserveContractError && error.code === "START_TIME_MISMATCH");
  }
  for (const duration of [899_999, 900_001]) {
    const event = structuredClone(original);
    event.markets[0].endDate = new Date(Date.parse(event.startTime) + duration).toISOString();
    assert.throws(() => parseBtc15mGammaEvent(event), (error) => error.code === "DURATION_MISMATCH");
  }
});

test("identity fails closed for wrong series/fingerprint, missing times, and duplicate tokens", async () => {
  const original = (await fixture("gamma-keyset-page-1.json")).data[0];
  const mutations = [
    (event) => { event.series[0].id = "10191"; },
    (event) => { event.series[0].id = 10192; },
    (event) => { event.cryptoFingerprint = { ...event.cryptoFingerprint, twapLookbackSeconds: 30 }; },
    (event) => { delete event.startTime; },
    (event) => { delete event.markets[0].eventStartTime; },
    (event) => { event.markets[0].clobTokenIds = ["same", "same"]; },
  ];
  for (const mutate of mutations) {
    const event = structuredClone(original); mutate(event);
    assert.throws(() => parseBtc15mGammaEvent(event), ShortObserveContractError);
  }
});
