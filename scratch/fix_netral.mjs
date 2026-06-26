import Database from 'better-sqlite3';
const db = new Database('data/database.db');

// Fix netral predictions wrongly marked as kalah
const fixed = db.prepare(`
  UPDATE analyzed_events 
  SET result = 'netral' 
  WHERE UPPER(prediction) IN ('=','SKIP','NETRAL','WATCHLIST') 
  AND result = 'kalah'
`).run();
console.log(`Fixed ${fixed.changes} netral records that were wrongly marked as kalah`);

// Also fix 'Up' vs 'UP' inconsistency for future matching
const fixCase = db.prepare(`
  UPDATE analyzed_events 
  SET prediction = UPPER(prediction) 
  WHERE prediction = 'Up'
`).run();
console.log(`Fixed ${fixCase.changes} 'Up' -> 'UP' casing records`);

// Verify
const dist = db.prepare(`SELECT result, COUNT(*) as cnt FROM analyzed_events GROUP BY result`).all();
console.log('Result distribution after fix:');
for (const r of dist) console.log(`  ${r.result}: ${r.cnt}`);

db.close();
