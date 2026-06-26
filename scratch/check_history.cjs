const Database = require('better-sqlite3');
const db = new Database('razor.db');
const rows = db.prepare(`SELECT id, question, prediction, actual_outcome, result, created_at, analysis_conclusion FROM history_events ORDER BY id DESC LIMIT 10`).all();
console.table(rows.map(r => ({
  id: r.id, 
  question: r.question.substring(0, 30) + '...',
  pred: r.prediction,
  act: r.actual_outcome,
  res: r.result,
  time: new Date(r.created_at).toISOString().substring(11, 19),
  analysis: r.analysis_conclusion.match(/Est. Fair Prob: \d+(\.\d+)?%/) ? r.analysis_conclusion.match(/Est. Fair Prob: \d+(\.\d+)?%/)[0] : "N/A"
})));
