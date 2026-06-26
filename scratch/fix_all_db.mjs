import Database from 'better-sqlite3';
const db = new Database('data/database.db');

console.log("=== BEFORE FIX ===");
const distBefore = db.prepare(`SELECT result, COUNT(*) as cnt FROM analyzed_events GROUP BY result`).all();
for (const r of distBefore) console.log(`  ${r.result ?? 'NULL'}: ${r.cnt}`);

// 1. Fix netral predictions wrongly marked as kalah
const fixNetral = db.prepare(`
  UPDATE analyzed_events 
  SET result = 'netral' 
  WHERE UPPER(prediction) IN ('=','SKIP','NETRAL','WATCHLIST') 
  AND result = 'kalah'
`).run();
console.log(`\n[Fix 1] Netral wrongly kalah: fixed ${fixNetral.changes} records`);

// 2. Fix prediction casing inconsistency (Up -> UP, Down -> DOWN, etc)
const fixUp = db.prepare(`UPDATE analyzed_events SET prediction = 'UP' WHERE prediction = 'Up'`).run();
const fixDown = db.prepare(`UPDATE analyzed_events SET prediction = 'DOWN' WHERE prediction = 'Down'`).run();
const fixYes = db.prepare(`UPDATE analyzed_events SET prediction = 'YES' WHERE prediction = 'Yes'`).run();
const fixNo = db.prepare(`UPDATE analyzed_events SET prediction = 'NO' WHERE prediction = 'No'`).run();
console.log(`[Fix 2] Casing fixes: Up=${fixUp.changes}, Down=${fixDown.changes}, Yes=${fixYes.changes}, No=${fixNo.changes}`);

// 3. CRITICAL: Fix records where prediction matches actual_outcome but result was wrongly set to 'kalah'
// This happens when prediction was "UP" but actual_outcome was stored as "Up" (case mismatch)
const fixWrongKalah = db.prepare(`
  UPDATE analyzed_events 
  SET result = 'menang' 
  WHERE result = 'kalah' 
  AND actual_outcome IS NOT NULL 
  AND UPPER(prediction) = UPPER(actual_outcome)
`).run();
console.log(`[Fix 3] Wrong kalah (prediction matched actual): fixed ${fixWrongKalah.changes} records`);

// 4. Show detail of all remaining kalah to verify they are real losses
console.log(`\n=== REMAINING KALAH (should all be genuine losses) ===`);
const remaining = db.prepare(`
  SELECT id, prediction, actual_outcome, result, question 
  FROM analyzed_events 
  WHERE result = 'kalah' 
  ORDER BY id DESC 
  LIMIT 20
`).all();
for (const r of remaining) {
  const match = r.actual_outcome && r.prediction && r.actual_outcome.toUpperCase() === r.prediction.toUpperCase();
  const flag = match ? ' ⚠️ STILL WRONG!' : ' ✓';
  console.log(`  [${r.id}] pred=${r.prediction} actual=${r.actual_outcome} ${flag} q=${r.question?.slice(0,55)}`);
}

console.log(`\n=== AFTER FIX ===`);
const distAfter = db.prepare(`SELECT result, COUNT(*) as cnt FROM analyzed_events GROUP BY result`).all();
for (const r of distAfter) console.log(`  ${r.result ?? 'NULL'}: ${r.cnt}`);

const total = db.prepare('SELECT COUNT(*) as t FROM analyzed_events').get().t;
const wins = db.prepare("SELECT COUNT(*) as w FROM analyzed_events WHERE result = 'menang'").get().w;
const losses = db.prepare("SELECT COUNT(*) as l FROM analyzed_events WHERE result = 'kalah'").get().l;
const resolved = wins + losses;
console.log(`\nWin Rate: ${resolved > 0 ? (wins/resolved*100).toFixed(1) : 0}% (${wins}W / ${losses}L dari ${resolved} resolved, total ${total})`);

db.close();
console.log("\n✅ Database fix complete!");
