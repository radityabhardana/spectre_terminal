import assert from "node:assert/strict";
import test from "node:test";

const observerKeys = [
  "SHORT_OBSERVER_BTC_15M_ENABLED",
  "SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS",
  "SHORT_OBSERVER_BTC_15M_DISCOVERY_LOOKAHEAD_MS",
  "SHORT_OBSERVER_BTC_15M_DISCOVERY_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_SNAPSHOT_INTERVAL_MS",
  "SHORT_OBSERVER_BTC_15M_SNAPSHOT_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_FREEZE_BEFORE_CLOSE_MS",
  "SHORT_OBSERVER_BTC_15M_LATE_START_GRACE_MS",
  "SHORT_OBSERVER_BTC_15M_RETRIES",
  "SHORT_OBSERVER_BTC_15M_RETRY_BACKOFF_MS",
  "SHORT_OBSERVER_BTC_15M_LEASE_TIMEOUT_MS",
  "SHORT_OBSERVER_BTC_15M_SHUTDOWN_TIMEOUT_MS",
];

const validObserverValues = Object.fromEntries(
  observerKeys.slice(1).map((key) => [key, "1000"]),
);

async function withObserverEnv(values, label, callback) {
  const previous = Object.fromEntries(observerKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of observerKeys) delete process.env[key];
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

test("short observer is disabled without requiring numeric settings", async () => {
  await withObserverEnv({
    SHORT_OBSERVER_BTC_15M_ENABLED: "false",
    SHORT_OBSERVER_BTC_15M_DISCOVERY_INTERVAL_MS: "0x10",
  }, "disabled", ({ assertShortObserverConfig, config }) => {
    assert.equal(config.shortObserverBtc15mEnabled, false);
    assert.equal(assertShortObserverConfig().enabled, false);
  });
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
  await withObserverEnv({ SHORT_OBSERVER_BTC_15M_ENABLED: "true" }, "missing", ({ assertShortObserverConfig }) => {
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
