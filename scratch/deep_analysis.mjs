import Database from 'better-sqlite3';
const db = new Database('data/database.db');

console.log("=== DEEP WIN RATE ANALYSIS ===\n");

// 1. All losses with their actual outcomes
console.log("--- All KALAH records (losses) ---");
const losses = db.prepare(`
  SELECT id, prediction, actual_outcome, question, created_at
  FROM analyzed_events
  WHERE result = 'kalah'
  ORDER BY id DESC
`).all();

const predDistLoss = {};
losses.forEach(l => {
  const pred = (l.prediction || 'null').toUpperCase();
  predDistLoss[pred] = (predDistLoss[pred] || 0) + 1;
});
console.log(`Total losses: ${losses.length}`);
console.log("Prediction distribution in losses:", predDistLoss);

// 2. Check where prediction = actual_outcome (STILL WRONG in DB!)
const stillWrong = losses.filter(l => 
  l.actual_outcome && l.prediction &&
  l.actual_outcome.toUpperCase() === l.prediction.toUpperCase()
);
console.log(`\nLosses where pred = actual (SHOULD BE WINS): ${stillWrong.length}`);
for (const r of stillWrong) {
  console.log(`  [${r.id}] pred=${r.prediction} actual=${r.actual_outcome} q=${r.question?.slice(0,50)}`);
}

// 3. What's the actual_outcome distribution in wins vs losses?
console.log("\n--- actual_outcome values ---");
const outcomes = db.prepare(`SELECT actual_outcome, result, COUNT(*) as cnt FROM analyzed_events WHERE actual_outcome IS NOT NULL GROUP BY actual_outcome, result ORDER BY result, cnt DESC`).all();
for (const r of outcomes) console.log(`  actual=${r.actual_outcome} result=${r.result} count=${r.cnt}`);

// 4. Records where actual_outcome IS NULL but status = selesai
const nullOutcomeSelesai = db.prepare(`SELECT id, prediction, result, status, question FROM analyzed_events WHERE actual_outcome IS NULL AND status = 'selesai' ORDER BY id DESC`).all();
console.log(`\n--- Records selesai but actual_outcome IS NULL: ${nullOutcomeSelesai.length} ---`);
for (const r of nullOutcomeSelesai.slice(0, 15)) {
  console.log(`  [${r.id}] pred=${r.prediction} result=${r.result} q=${r.question?.slice(0,55)}`);
}

// 5. The key question: are losses genuinely wrong or are they DB bugs?
console.log("\n--- Sample of KALAH records to verify ---");
const sampleLosses = db.prepare(`
  SELECT id, prediction, actual_outcome, result, question 
  FROM analyzed_events 
  WHERE result = 'kalah'
  ORDER BY id DESC LIMIT 15
`).all();
for (const r of sampleLosses) {
  const match = r.actual_outcome && r.prediction && r.actual_outcome.toUpperCase() === r.prediction.toUpperCase();
  console.log(`  [${r.id}] pred=${r.prediction} actual=${r.actual_outcome ?? 'NULL'} match=${match} q=${r.question?.slice(0,45)}`);
}

// 6. Check for the evaluate flow: losses with null actual_outcome
// These may have been set to kalah by default without checking actual outcome
const defaultKalah = db.prepare(`
  SELECT COUNT(*) as cnt FROM analyzed_events 
  WHERE result = 'kalah' AND actual_outcome IS NULL
`).get();
console.log(`\n--- Losses where actual_outcome=NULL (possibly defaulted to kalah): ${defaultKalah.cnt} ---`);

// 7. Win rate breakdown by type of prediction
console.log("\n--- Win rate breakdown by prediction type ---");
const winByPred = db.prepare(`
  SELECT prediction, 
    SUM(CASE WHEN result='menang' THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN result='kalah' THEN 1 ELSE 0 END) as losses,
    SUM(CASE WHEN result='netral' THEN 1 ELSE 0 END) as neutral
  FROM analyzed_events
  WHERE status = 'selesai'
  GROUP BY prediction
  ORDER BY losses DESC
`).all();
for (const r of winByPred) {
  const total = r.wins + r.losses;
  const wr = total > 0 ? (r.wins/total*100).toFixed(1) : 'n/a';
  console.log(`  pred=${r.prediction} W=${r.wins} L=${r.losses} N=${r.neutral} WR=${wr}%`);
}

db.close();
