import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath = path.resolve('./data/database.db');
const db = new Database(dbPath);

const rows = db.prepare('SELECT data FROM analysis_log').all();
console.log(`Found ${rows.length} rows in analysis_log`);

let totalQwenTokens = 0;
let qwenModel = "unknown";

for (const row of rows) {
  try {
    const data = JSON.parse(row.data);
    if (data.qwen && typeof data.qwen === 'object') {
       if (data.qwen.usage && data.qwen.usage.total_tokens) {
           totalQwenTokens += data.qwen.usage.total_tokens;
           if (data.qwen.model) qwenModel = data.qwen.model;
       }
    }
  } catch (e) {}
}

console.log("Total tokens found in analysis_log:", totalQwenTokens, "Model:", qwenModel);

// Also check prediction_reflections schema
const tableInfo = db.prepare("PRAGMA table_info(prediction_reflections)").all();
console.log("Columns in prediction_reflections:", tableInfo.map(c => c.name));

const refRows = db.prepare('SELECT reflection_data FROM prediction_reflections').all();
console.log(`Found ${refRows.length} rows in prediction_reflections`);
let refTokens = 0;
for (const row of refRows) {
  try {
    const data = JSON.parse(row.reflection_data);
    if (data.usage && data.usage.total_tokens) {
        refTokens += data.usage.total_tokens;
    } else if (data.aiAnalysis && data.aiAnalysis.usage) {
        refTokens += data.aiAnalysis.usage.total_tokens;
    }
  } catch (e) {}
}
console.log("Total tokens found in prediction_reflections:", refTokens);
