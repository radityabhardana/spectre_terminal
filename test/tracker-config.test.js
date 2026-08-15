import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_TRACKER_CONFIG_PATH,
  TRACKER_CONFIG_PATH,
  loadTrackerConfig,
  normalizeTrackerConfig,
  persistTrackerConfig,
} from "../src/tracker-config.js";
import { getTrackerConfig } from "../src/sniffer.js";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spectre-tracker-config-"));
}

function testAddress(hex = "a") {
  return `0x${hex.repeat(40)}`;
}

test("runtime defaults contain no tracked wallet", () => {
  assert.deepEqual(getTrackerConfig(), { minUsd: 1000, wallets: [] });
  assert.equal(fs.existsSync(LEGACY_TRACKER_CONFIG_PATH), false);
  const snifferSource = fs.readFileSync(path.resolve("src/sniffer.js"), "utf8");
  assert.doesNotMatch(snifferSource, /0x[0-9a-fA-F]{40}/);
  assert.doesNotMatch(snifferSource, /Coinman2/);
});

test("runtime config path is ignored while the example remains safe", () => {
  const gitignore = fs.readFileSync(path.resolve(".gitignore"), "utf8");
  const example = JSON.parse(fs.readFileSync(path.resolve("tracker_config.example.json"), "utf8"));

  assert.match(gitignore, /^data\/tracker_config\.json$/m);
  assert.match(gitignore, /^data\/tracker_config\.json\.tmp$/m);
  assert.deepEqual(example, { minUsd: 1000, wallets: [] });
  assert.match(TRACKER_CONFIG_PATH, /data[\\/]tracker_config\.json$/);
});

test("wallet addresses and nicknames are normalized and validated", () => {
  const normalized = normalizeTrackerConfig({
    minUsd: 1_500,
    wallets: [
      { address: testAddress("A"), nickname: "x".repeat(60) },
      { address: "0X1234", nickname: "invalid prefix" },
      { address: testAddress("A"), nickname: "duplicate" },
      { address: `${testAddress("b")}x`, nickname: "invalid length" },
    ],
  });

  assert.deepEqual(normalized, {
    minUsd: 1_500,
    wallets: [{ address: testAddress("a"), nickname: "x".repeat(40) }],
  });
  assert.deepEqual(normalizeTrackerConfig({ minUsd: Number.NaN, wallets: [] }), { minUsd: 1000, wallets: [] });
});

test("persistence writes atomically and leaves no temporary file", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "data", "tracker_config.json");
  try {
    persistTrackerConfig({ minUsd: 2_000, wallets: [{ address: testAddress("c"), nickname: "Local" }] }, { configPath });
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
      minUsd: 2_000,
      wallets: [{ address: testAddress("c"), nickname: "Local" }],
    });
    assert.equal(fs.existsSync(`${configPath}.tmp`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("POSIX runtime permissions protect the directory and config", { skip: process.platform === "win32" }, () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "data", "tracker_config.json");
  try {
    persistTrackerConfig({ minUsd: 1000, wallets: [] }, { configPath });
    assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy migration does not overwrite an existing runtime config", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "data", "tracker_config.json");
  const legacyPath = path.join(directory, "tracker_config.json");
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ minUsd: 2_000, wallets: [] }));
    fs.writeFileSync(legacyPath, JSON.stringify({ minUsd: 3_000, wallets: [{ address: testAddress("d"), nickname: "legacy" }] }));
    assert.deepEqual(loadTrackerConfig({ configPath, legacyConfigPath: legacyPath }), { minUsd: 2_000, wallets: [] });

    fs.rmSync(configPath);
    const migrated = loadTrackerConfig({ configPath, legacyConfigPath: legacyPath });
    assert.deepEqual(migrated, { minUsd: 3_000, wallets: [{ address: testAddress("d"), nickname: "legacy" }] });
    assert.equal(fs.existsSync(legacyPath), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), migrated);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("config loading does not log wallet data at startup", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "data", "tracker_config.json");
  const legacyPath = path.join(directory, "tracker_config.json");
  const messages = [];
  const originalLog = console.log;
  try {
    fs.writeFileSync(legacyPath, JSON.stringify({ minUsd: 1000, wallets: [{ address: testAddress("e"), nickname: "private-test" }] }));
    console.log = (...args) => messages.push(args.join(" "));
    loadTrackerConfig({ configPath, legacyConfigPath: legacyPath });
  } finally {
    console.log = originalLog;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.deepEqual(messages, []);
});
