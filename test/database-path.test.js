import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionDatabasePath = path.join(projectRoot, "data", "database.db");
const probePath = path.join(projectRoot, "test", "fixtures", "database-path-probe.js");

function probe(args, env) {
  const result = spawnSync(process.execPath, [...args, probePath], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const marker = result.stdout.split("\n").find((line) => line.includes("DATABASE_PATH_PROBE "));
  assert.ok(marker, result.stdout);
  return JSON.parse(marker.slice(marker.indexOf("DATABASE_PATH_PROBE ") + "DATABASE_PATH_PROBE ".length));
}

test("node test context keeps the sole storage connection away from production and cleans sidecars", () => {
  const env = { ...process.env };
  delete env.RAZOR_DATABASE_PATH;
  delete env.NODE_TEST_CONTEXT;

  const paths = probe(["--test"], env);

  assert.equal(typeof paths.storagePath, "string");
  assert.equal(paths.analyticsHasDatabasePath, false);
  assert.notEqual(paths.storagePath, productionDatabasePath);
  assert.equal(existsSync(paths.storagePath), false);
  assert.equal(existsSync(`${paths.storagePath}-wal`), false);
  assert.equal(existsSync(`${paths.storagePath}-shm`), false);
});

test("explicit database override remains caller-owned", () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "razor-explicit-database-"));
  const explicitPath = path.join(tempDir, "caller-owned.db");
  try {
    const env = { ...process.env, RAZOR_DATABASE_PATH: explicitPath };
    delete env.NODE_TEST_CONTEXT;
    const paths = probe([], env);

    assert.equal(typeof paths.storagePath, "string");
    assert.deepEqual(paths, { storagePath: explicitPath, analyticsHasDatabasePath: false });
    assert.equal(existsSync(explicitPath), true);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
