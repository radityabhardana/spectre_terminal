import assert from "node:assert/strict";
import test from "node:test";

const enabledKey = "SHORT_OBSERVER_BTC_15M_ENABLED";
const expectedFeedIdKey = "SHORT_OBSERVER_BTC_15M_EXPECTED_CHAINLINK_FEED_ID";
const numericObserverKeys = [
  "SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS",
  "SHORT_OBSERVER_BTC_15M_DISCOVERY_LOOKAHEAD_MS",
  "SHORT_OBSERVER_BTC_15M_DISCOVERY_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_SNAPSHOT_INTERVAL_MS",
  "SHORT_OBSERVER_BTC_15M_SNAPSHOT_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_RESOLUTION_INTERVAL_MS",
  "SHORT_OBSERVER_BTC_15M_RESOLUTION_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_RESOLUTION_GRACE_MS",
  "SHORT_OBSERVER_BTC_15M_FREEZE_BEFORE_CLOSE_MS",
  "SHORT_OBSERVER_BTC_15M_LATE_START_GRACE_MS",
  "SHORT_OBSERVER_BTC_15M_RETRIES",
  "SHORT_OBSERVER_BTC_15M_RETRY_BACKOFF_MS",
  "SHORT_OBSERVER_BTC_15M_LEASE_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_SHUTDOWN_TIMEOUT_MS",
];
const observerKeys = [enabledKey, expectedFeedIdKey, ...numericObserverKeys];
const validV2FeedId = `0x0002${"a".repeat(60)}`;

const validNumericValues = Object.fromEntries(numericObserverKeys.map((key) => [key, "1000"]));
const validObserverValues = { [expectedFeedIdKey]: validV2FeedId, ...validNumericValues };

async function withObserverEnv(values, label, callback) {
  const previous = Object.fromEntries(observerKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of observerKeys) process.env[key] = "";
    Object.assign(process.env, values);
    const module = await import(`../src/config.js?short-observer=${label}`);
    return await callback(module);
  } finally {
    for (const key of observerKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("disabled short observer ignores missing or malformed feed ID and numeric settings", async () => {
  for (const [label, feedValues] of [
    ["disabled-missing-feed", {}],
    ["disabled-malformed-feed", { [expectedFeedIdKey]: "not-a-feed-id" }],
  ]) {
    await withObserverEnv({
      [enabledKey]: "false",
      SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS: "0x10",
      ...feedValues,
    }, label, ({ assertShortObserverConfig, config }) => {
      assert.equal(config.shortObserverBtc15mEnabled, false);
      assert.equal(config.shortObserverBtc15m.expectedChainlinkFeedId, undefined);
      assert.deepEqual(assertShortObserverConfig(), {
        enabled: false,
        ...config.shortObserverBtc15m,
      });
    });
  }
});

test("observer enable flag is exact and case-sensitive", async () => {
  for (const [label, value] of [["padded", " true "], ["upper", "TRUE"], ["mixed", "False"]]) {
    await withObserverEnv({ SHORT_OBSERVER_BTC_15M_ENABLED: value }, label, ({ assertShortObserverConfig, config }) => {
      assert.equal(config.shortObserverBtc15mEnabled, false);
      assert.throws(assertShortObserverConfig, /SHORT_OBSERVER_BTC_15M_ENABLED must be exactly true or false/);
    });
  }
});

test("enabled short observer rejects missing and zero required values", async () => {
  await withObserverEnv({
    [enabledKey]: "true",
    [expectedFeedIdKey]: validV2FeedId,
  }, "missing-numeric", ({ assertShortObserverConfig }) => {
    assert.throws(assertShortObserverConfig, /missing:.*SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS/);
  });

  await withObserverEnv({
    SHORT_OBSERVER_BTC_15M_ENABLED: "true",
    ...validObserverValues,
    SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS: "0",
  }, "zero", ({ assertShortObserverConfig }) => {
    assert.throws(assertShortObserverConfig, /SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS/);
  });
});

test("enabled short observer requires an expected Chainlink feed ID", async () => {
  await withObserverEnv({
    [enabledKey]: "true",
    ...validNumericValues,
  }, "enabled-missing-feed", ({ assertShortObserverConfig }) => {
    assert.throws(assertShortObserverConfig, /missing:.*SHORT_OBSERVER_BTC_15M_EXPECTED_CHAINLINK_FEED_ID/);
  });
});

test("enabled short observer rejects malformed Chainlink V2 feed IDs", async () => {
  for (const [label, value] of [
    ["short", `0x0002${"a".repeat(59)}`],
    ["long", `0x0002${"a".repeat(61)}`],
    ["non-hex", `0x0002${"a".repeat(59)}g`],
    ["wrong-prefix", `0x0001${"a".repeat(60)}`],
  ]) {
    await withObserverEnv({
      [enabledKey]: "true",
      ...validNumericValues,
      [expectedFeedIdKey]: value,
    }, `feed-${label}`, ({ assertShortObserverConfig }) => {
      assert.throws(assertShortObserverConfig, /invalid V2 Chainlink feed ID: SHORT_OBSERVER_BTC_15M_EXPECTED_CHAINLINK_FEED_ID/);
    });
  }
});

test("enabled short observer canonicalizes uppercase Chainlink feed IDs", async () => {
  const uppercaseFeedId = `0x0002${"AB".repeat(30)}`;
  await withObserverEnv({
    [enabledKey]: "true",
    ...validNumericValues,
    [expectedFeedIdKey]: uppercaseFeedId,
  }, "uppercase-feed", ({ assertShortObserverConfig, config }) => {
    const expected = uppercaseFeedId.toLowerCase();
    assert.equal(config.shortObserverBtc15m.expectedChainlinkFeedId, expected);
    assert.equal(assertShortObserverConfig().expectedChainlinkFeedId, expected);
  });
});

test("enabled short observer accepts a valid Chainlink V2 feed ID", async () => {
  await withObserverEnv({
    [enabledKey]: "true",
    ...validObserverValues,
  }, "valid-feed", ({ assertShortObserverConfig }) => {
    const observerConfig = assertShortObserverConfig();
    assert.equal(observerConfig.enabled, true);
    assert.equal(observerConfig.expectedChainlinkFeedId, validV2FeedId);
  });
});

test("enabled short observer accepts decimal safe integers only", async () => {
  for (const [label, value] of [
    ["hex", "0x10"],
    ["exponent", "1e3"],
    ["whitespace", " 1000"],
    ["unsafe", "9007199254740992"],
  ]) {
    await withObserverEnv({
      SHORT_OBSERVER_BTC_15M_ENABLED: "true",
      ...validObserverValues,
      SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS: value,
    }, label, ({ assertShortObserverConfig }) => {
      assert.throws(assertShortObserverConfig, /SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS/);
    });
  }

  await withObserverEnv({
    SHORT_OBSERVER_BTC_15M_ENABLED: "true",
    ...validObserverValues,
    SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS: "9007199254740991",
  }, "safe", ({ assertShortObserverConfig }) => {
    assert.equal(assertShortObserverConfig().discoveryIntervalMs, Number.MAX_SAFE_INTEGER);
  });
});

test("enabled short observer enforces resolution timing relationships", async () => {
  await withObserverEnv({
    [enabledKey]: "true",
    ...validObserverValues,
    SHORT_OBSERVER_BTC_15M_RESOLUTION_TIMEOUT_MS: "1001",
  }, "resolution-timeout-after-interval", ({ assertShortObserverConfig }) => {
    assert.throws(
      assertShortObserverConfig,
      /SHORT_OBSERVER_BTC_15M_RESOLUTION_TIMEOUT_MS must be <= SHORT_OBSERVER_BTC_15M_RESOLUTION_INTERVAL_MS/
    );
  });

  await withObserverEnv({
    [enabledKey]: "true",
    ...validObserverValues,
    SHORT_OBSERVER_BTC_15M_RESOLUTION_GRACE_MS: "999",
  }, "resolution-grace-before-interval", ({ assertShortObserverConfig }) => {
    assert.throws(
      assertShortObserverConfig,
      /SHORT_OBSERVER_BTC_15M_RESOLUTION_GRACE_MS must be >= SHORT_OBSERVER_BTC_15M_RESOLUTION_INTERVAL_MS/
    );
  });
});
