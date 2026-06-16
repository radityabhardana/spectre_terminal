const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.join(__dirname, '../data/database.db');
const db = new Database(dbPath);

const events = db.prepare('SELECT question, result FROM analyzed_events WHERE result IS NOT NULL').all();

const stats = {
  btc: { total: 0, win: 0, loss: 0 },
  eth: { total: 0, win: 0, loss: 0 },
  doge: { total: 0, win: 0, loss: 0 }
};

events.forEach(e => {
  const q = e.question.toLowerCase();
  let coin = null;
  if (q.includes('bitcoin')) coin = 'btc';
  else if (q.includes('ethereum')) coin = 'eth';
  else if (q.includes('dogecoin')) coin = 'doge';
  
  if (coin && (e.result === 'menang' || e.result === 'kalah')) {
    stats[coin].total++;
    if (e.result === 'menang') stats[coin].win++;
    if (e.result === 'kalah') stats[coin].loss++;
  }
});

console.log("Win Rates:");
for (const [coin, s] of Object.entries(stats)) {
  const wr = s.total > 0 ? ((s.win / s.total) * 100).toFixed(2) + '%' : 'N/A';
  console.log(`${coin.toUpperCase()}: ${wr} (Wins: ${s.win}, Losses: ${s.loss}, Total: ${s.total})`);
}
