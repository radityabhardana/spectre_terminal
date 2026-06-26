import Database from 'better-sqlite3';
const db = new Database('data/database.db');

console.log("=== BUG CHECK 1: Netral predictions wrongly marked as 'kalah' ===");
const bad = db.prepare(`
  SELECT id, prediction, result, status, question 
  FROM analyzed_events 
  WHERE UPPER(prediction) IN ('=','SKIP','NETRAL','WATCHLIST') 
  AND result = 'kalah'
`).all();
console.log(`Found: ${bad.length} records`);
for (const r of bad) console.log(`  [${r.id}] pred=${r.prediction} result=${r.result} q=${r.question?.slice(0,60)}`);

console.log("\n=== BUG CHECK 2: All distinct prediction values ===");
const preds = db.prepare(`SELECT DISTINCT prediction FROM analyzed_events`).all();
console.log(preds.map(p => p.prediction));

console.log("\n=== BUG CHECK 3: Result distribution ===");
const dist = db.prepare(`SELECT result, COUNT(*) as cnt FROM analyzed_events GROUP BY result`).all();
for (const r of dist) console.log(`  ${r.result}: ${r.cnt}`);

console.log("\n=== BUG CHECK 4: Status distribution ===");
const statDist = db.prepare(`SELECT status, COUNT(*) as cnt FROM analyzed_events GROUP BY status`).all();
for (const r of statDist) console.log(`  ${r.status}: ${r.cnt}`);

console.log("\n=== BUG CHECK 5: Events with 'belum selesai' but market likely closed ===");
const pending = db.prepare(`SELECT id, market_id, prediction, question, created_at FROM analyzed_events WHERE status = 'belum selesai' ORDER BY id DESC LIMIT 10`).all();
console.log(`Pending events: ${pending.length}`);
for (const r of pending) console.log(`  [${r.id}] market=${r.market_id} pred=${r.prediction} q=${r.question?.slice(0,60)} created=${r.created_at}`);

console.log("\n=== BUG CHECK 6: Duplicate market_id entries ===");
const dupes = db.prepare(`SELECT market_id, COUNT(*) as cnt FROM analyzed_events GROUP BY market_id HAVING cnt > 1 ORDER BY cnt DESC LIMIT 10`).all();
console.log(`Markets with duplicates: ${dupes.length}`);
for (const r of dupes) console.log(`  market_id=${r.market_id} count=${r.cnt}`);

console.log("\n=== STATS COMPARISON ===");
const totalRow = db.prepare('SELECT COUNT(*) as total FROM analyzed_events').get();
const winRow = db.prepare("SELECT COUNT(*) as wins FROM analyzed_events WHERE result = 'menang'").get();
const lossRow = db.prepare("SELECT COUNT(*) as losses FROM analyzed_events WHERE result = 'kalah'").get();
const netralRow = db.prepare("SELECT COUNT(*) as netral FROM analyzed_events WHERE result = 'netral'").get();
const pendingRow = db.prepare("SELECT COUNT(*) as pending FROM analyzed_events WHERE result IS NULL OR result = 'menunggu hasil'").get();
console.log(`Total: ${totalRow.total}`);
console.log(`Wins: ${winRow.wins}`);
console.log(`Losses: ${lossRow.losses}`);
console.log(`Netral: ${netralRow.netral}`);
console.log(`Pending/null: ${pendingRow.pending}`);

db.close();
