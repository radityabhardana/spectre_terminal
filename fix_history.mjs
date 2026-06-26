/**
 * Fix History Script
 * 
 * This script:
 * 1. Finds all history entries where qwen_confidence IS NULL (these were saved by
 *    the buggy sniper code that didn't properly apply the short crypto fair_prob logic).
 * 2. Tries to extract the Qwen estimated_fair_probability from the analysis_conclusion text.
 * 3. Re-derives the correct prediction (UP/DOWN/=) using the same logic as deepAnalyzeMarket.
 * 4. Updates the prediction field in the DB if it differs from the stored value.
 * 5. Also attempts to extract and backfill qwen_confidence from the conclusion text.
 */

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, "data", "database.db");

const db = new Database(dbPath);

// Get all entries with null qwen_confidence (the buggy sniper-saved ones)
const buggyEntries = db.prepare(`
  SELECT id, question, prediction, qwen_confidence, data_confidence, analysis_conclusion
  FROM analyzed_events
  WHERE qwen_confidence IS NULL
  ORDER BY id ASC
`).all();

console.log(`\nFound ${buggyEntries.length} entries with null qwen_confidence (potential bug victims).\n`);

let fixed = 0;
let skipped = 0;
let noData = 0;

for (const row of buggyEntries) {
  const isShortCrypto = /(bitcoin|btc|ethereum|eth|doge|dogecoin).*up.or.down/i.test(row.question || "");
  
  if (!isShortCrypto) {
    // Not a short crypto market, skip
    skipped++;
    continue;
  }

  const conclusion = row.analysis_conclusion || "";

  // Try to extract estimated_fair_probability from the analysis text
  // It appears in the format: "estimated_fair_probability: 62" or "Estimated Fair Probability: 62%"
  const fairProbMatch = conclusion.match(/estimated[_\s]fair[_\s]probability[":\s]+([0-9.]+)/i);
  const fairProb = fairProbMatch ? parseFloat(fairProbMatch[1]) : null;

  // Fallback: for entries where Qwen failed (n/a), extract "Confidence UP" from the orderbook scouting section
  // Format: "Confidence UP: 63.50%"
  const confUpMatch = conclusion.match(/Confidence UP:\s*([0-9.]+)/i);
  const confUp = confUpMatch ? parseFloat(confUpMatch[1]) : null;

  // The effective direction probability: prefer Qwen fair_prob, fallback to orderbook confUp
  const effectiveFairProb = fairProb !== null ? fairProb : confUp;

  // Try to extract Qwen Confidence from the analysis text
  const qwenConfMatch = conclusion.match(/Qwen confidence:\s*([0-9]+)/i);
  const extractedQwenConf = qwenConfMatch ? qwenConfMatch[1] : null;

  if (effectiveFairProb === null) {
    console.log(`[ID ${row.id}] ${row.question.slice(0, 55)} | No direction data found in text, cannot auto-fix.`);
    noData++;
    continue;
  }

  const source = fairProb !== null ? "fair_prob" : "confUP_orderbook";

  // Derive correct prediction (same logic as deepAnalyzeMarket and format.js)
  let correctPrediction;
  if (effectiveFairProb >= 55) {
    correctPrediction = "UP";
  } else if (effectiveFairProb <= 45) {
    correctPrediction = "DOWN";
  } else {
    correctPrediction = "=";
  }

  const predictionChanged = correctPrediction !== row.prediction;
  const confChanged = extractedQwenConf && !row.qwen_confidence;

  if (predictionChanged || confChanged) {
    db.prepare(`
      UPDATE analyzed_events
      SET
        prediction = ?,
        qwen_confidence = COALESCE(?, qwen_confidence)
      WHERE id = ?
    `).run(correctPrediction, extractedQwenConf, row.id);

    console.log(`[ID ${row.id}] FIXED | Question: ${row.question.slice(0, 55)}`);
    if (predictionChanged) {
      console.log(`         Prediction: ${row.prediction} -> ${correctPrediction} (${source}=${effectiveFairProb})`);
    }
    if (confChanged) {
      console.log(`         Qwen Conf backfilled: ${extractedQwenConf}`);
    }
    fixed++;
  } else {
    console.log(`[ID ${row.id}] OK (no change needed) | ${row.question.slice(0, 55)} | Pred: ${row.prediction} | ${source}=${effectiveFairProb}`);
    skipped++;
  }
}

console.log(`\n========================================`);
console.log(`Fixed  : ${fixed} entries`);
console.log(`Skipped: ${skipped} entries (correct or non-crypto)`);
console.log(`No data: ${noData} entries (no fair_prob extractable)`);
console.log(`========================================\n`);

db.close();
