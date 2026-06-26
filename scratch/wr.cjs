const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '../data/database.db');
const db = new Database(dbPath);

// === PER DAY BREAKDOWN ===
console.log('=== WIN RATE PER HARI (Short Market) ===');
const byDay = db.prepare([
  "SELECT substr(created_at, 1, 10) as day,",
  "COUNT(*) as total,",
  "SUM(result = 'menang') as menang,",
  "SUM(result = 'kalah') as kalah,",
  "SUM(result = 'netral') as netral",
  "FROM analyzed_events",
  "WHERE status = 'selesai'",
  "AND (lower(question) LIKE '%bitcoin%' OR lower(question) LIKE '%ethereum%' OR lower(question) LIKE '%dogecoin%')",
  "GROUP BY day ORDER BY day DESC LIMIT 14"
].join(' ')).all();

for (const r of byDay) {
  const traded = r.menang + r.kalah;
  const wr = traded > 0 ? ((r.menang / traded) * 100).toFixed(1) : 'N/A';
  console.log(r.day + ' | Menang:' + r.menang + ' Kalah:' + r.kalah + ' Netral:' + r.netral + ' | WR: ' + wr + '%');
}

// === OVERALL BY COIN ===
console.log('\n=== OVERALL WIN RATE BY COIN ===');
const events = db.prepare("SELECT question, result FROM analyzed_events WHERE result IS NOT NULL").all();

const stats = { btc: { win: 0, loss: 0 }, eth: { win: 0, loss: 0 }, doge: { win: 0, loss: 0 } };
events.forEach(e => {
  const q = e.question.toLowerCase();
  let coin = null;
  if (q.includes('bitcoin')) coin = 'btc';
  else if (q.includes('ethereum')) coin = 'eth';
  else if (q.includes('dogecoin')) coin = 'doge';
  if (coin && (e.result === 'menang' || e.result === 'kalah')) {
    if (e.result === 'menang') stats[coin].win++;
    else stats[coin].loss++;
  }
});
for (const [coin, s] of Object.entries(stats)) {
  const total = s.win + s.loss;
  const wr = total > 0 ? ((s.win / total) * 100).toFixed(2) + '%' : 'N/A';
  console.log(coin.toUpperCase() + ': ' + wr + ' (Wins: ' + s.win + ', Losses: ' + s.loss + ', Total: ' + total + ')');
}

// === RECENT 20 EVENTS ===
console.log('\n=== 20 EVENT TERBARU ===');
const recent = db.prepare([
  "SELECT substr(created_at,1,10) as day, prediction, result, question",
  "FROM analyzed_events WHERE status = 'selesai'",
  "ORDER BY id DESC LIMIT 20"
].join(' ')).all();
for (const r of recent) {
  const icon = r.result === 'menang' ? 'OK' : r.result === 'kalah' ? 'XX' : '--';
  console.log(icon + ' [' + r.day + '] Pred:' + r.prediction + ' -> ' + r.result + ' | ' + r.question.substring(0, 55));
}
