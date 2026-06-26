import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "data", "database.db");
const db = new Database(dbPath);

// Check cases where prediction and actual_outcome look the same but result = kalah
const rows = db.prepare(`
  SELECT id, question, prediction, actual_outcome, result
  FROM analyzed_events
  WHERE result = 'kalah' AND actual_outcome IS NOT NULL
  ORDER BY id DESC
  LIMIT 30
`).all();

console.log("\n=== LOSING ENTRIES WITH ACTUAL OUTCOME ===\n");
for (const r of rows) {
  const pred = (r.prediction || "").toUpperCase();
  const actual = (r.actual_outcome || "").toUpperCase();
  const seemsSame = pred === actual || actual.includes(pred) || pred.includes(actual);
  if (seemsSame) {
    console.log(`[⚠️  MISMATCH BUG] ID: ${r.id}`);
    console.log(`   Question: ${r.question.slice(0, 65)}`);
    console.log(`   Pred="${r.prediction}" (upper="${pred}") | Actual="${r.actual_outcome}" (upper="${actual}") | Result: ${r.result}`);
  } else {
    console.log(`[OK] ID: ${r.id} | Pred="${r.prediction}" | Actual="${r.actual_outcome}" | ${r.result}`);
  }
}

db.close();
