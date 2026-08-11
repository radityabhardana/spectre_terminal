/**
 * Extract and report total Qwen token usage from the SQLite database.
 * Checks analysis_log records.
 * Run: node scripts/extract_tokens.js
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../data/database.db');
const db = new Database(dbPath);

const rows = db.prepare('SELECT data FROM analysis_log').all();
console.log(`Found ${rows.length} rows in analysis_log`);

let totalQwenTokens = 0;
let qwenModel = 'unknown';

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

console.log('Total tokens found in analysis_log:', totalQwenTokens, 'Model:', qwenModel);
