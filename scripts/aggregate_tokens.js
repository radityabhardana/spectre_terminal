/**
 * Aggregate token usage per model from the analysis_log table in the database.
 * Run: node scripts/aggregate_tokens.js
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../data/database.db');
const db = new Database(dbPath);

const rows = db.prepare('SELECT data FROM analysis_log').all();
let tokensByModel = {};

for (const row of rows) {
  try {
    const data = JSON.parse(row.data);
    if (data.qwen && typeof data.qwen === 'object') {
      if (data.qwen.usage && data.qwen.usage.total_tokens) {
        const model = data.qwen.model || 'unknown';
        tokensByModel[model] = (tokensByModel[model] || 0) + data.qwen.usage.total_tokens;
      }
    }
  } catch (e) {}
}

console.log(JSON.stringify(tokensByModel, null, 2));
