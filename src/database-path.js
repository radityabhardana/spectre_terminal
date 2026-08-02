import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const productionDatabasePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "database.db",
);

const configuredDatabasePath = String(process.env.RAZOR_DATABASE_PATH || "").trim();
const isNodeTestProcess = Boolean(process.env.NODE_TEST_CONTEXT);
const generatedTestDirectory = !configuredDatabasePath && isNodeTestProcess
  ? fs.mkdtempSync(path.join(tmpdir(), `razor-bot-test-${process.pid}-`))
  : null;

export const databasePath = configuredDatabasePath
  ? path.resolve(configuredDatabasePath)
  : generatedTestDirectory
    ? path.join(generatedTestDirectory, "database.db")
    : productionDatabasePath;

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

if (generatedTestDirectory) {
  process.once("exit", () => {
    try {
      fs.rmSync(generatedTestDirectory, { recursive: true, force: true });
    } catch {
      // Process-owned test files are best-effort cleanup during shutdown.
    }
  });
}
