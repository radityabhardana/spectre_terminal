/**
 * Re-evaluate results for entries where prediction was recently corrected by fix_history.mjs
 * but the result was already saved incorrectly.
 * 
 * Logic: If prediction and actual_outcome match (case-insensitive, with UP/YES and DOWN/NO aliases),
 * but result is 'kalah' -> fix to 'menang'.
 * If prediction is =/SKIP/NETRAL but result is not 'netral' -> fix to 'netral'.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "data", "database.db");
const db = new Database(dbPath);

const rows = db.prepare(`
  SELECT id, question, prediction, actual_outcome, result
  FROM analyzed_events
  WHERE actual_outcome IS NOT NULL AND status = 'selesai'
  ORDER BY id ASC
`).all();

let fixed = 0;
let checked = 0;

for (const r of rows) {
  checked++;
  const p = (r.prediction || "").trim().toUpperCase();
  const w = (r.actual_outcome || "").trim().toUpperCase();
  const currentResult = r.result;

  // Determine what result SHOULD be
  const directMatch = p && w && p === w;
  const aliasMatch =
    (p === "UP" && w === "YES") || (p === "YES" && w === "UP") ||
    (p === "DOWN" && w === "NO") || (p === "NO" && w === "DOWN");
  const isNeutral = p === "=" || p === "SKIP" || p === "NETRAL" || p === "WATCHLIST";

  let correctResult;
  if (directMatch || aliasMatch) {
    correctResult = "menang";
  } else if (isNeutral) {
    correctResult = "netral";
  } else {
    correctResult = "kalah";
  }

  if (correctResult !== currentResult) {
    db.prepare(`UPDATE analyzed_events SET result = ? WHERE id = ?`).run(correctResult, r.id);
    console.log(`[FIXED] ID ${r.id}: ${currentResult} -> ${correctResult}`);
    console.log(`        Question: ${r.question.slice(0, 65)}`);
    console.log(`        Pred="${r.prediction}" | Actual="${r.actual_outcome}"`);
    fixed++;
  }
}

console.log(`\n========================================`);
console.log(`Checked: ${checked} resolved entries`);
console.log(`Fixed  : ${fixed} entries with wrong result`);
console.log(`========================================\n`);

db.close();
