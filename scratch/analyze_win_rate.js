import Database from 'better-sqlite3';
const db = new Database('data/database.db');
const rows = db.prepare("SELECT id, prediction, result, analysis_conclusion FROM analyzed_events WHERE result IN ('menang', 'kalah')").all();

let truePlayWins = 0;
let truePlayLosses = 0;
let forcedWins = 0;
let forcedLosses = 0;

rows.forEach(r => {
  if (!r.analysis_conclusion) return;
  const match = r.analysis_conclusion.match(/Est\. Fair Prob: (\d+)/);
  let fairProb = 50;
  if (match) {
    fairProb = parseInt(match[1], 10);
  } else {
    return; // Skip if no fair prob info
  }
  
  if (fairProb !== 50) {
    if (r.result === 'menang') truePlayWins++;
    else truePlayLosses++;
  } else {
    if (r.result === 'menang') forcedWins++;
    else forcedLosses++;
  }
});

const trueWinRate = (truePlayWins / (truePlayWins + truePlayLosses) * 100).toFixed(1);
const forcedWinRate = (forcedWins / (forcedWins + forcedLosses) * 100).toFixed(1);

console.log(`True PLAY (AI Analyzed): ${truePlayWins} W / ${truePlayLosses} L (${trueWinRate}%)`);
console.log(`Forced (50/50 Aggressive): ${forcedWins} W / ${forcedLosses} L (${forcedWinRate}%)`);
