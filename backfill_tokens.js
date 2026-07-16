import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DATA_DIR = path.join(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'token_usage.json');
const JSONL_FILE = path.join(DATA_DIR, 'analysis_log.jsonl');
const DB_FILE = path.join(DATA_DIR, 'database.db');

let tokenUsageByModel = {};
if (fs.existsSync(TOKEN_FILE)) {
  tokenUsageByModel = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
}

function processJSON(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    
    // Look for usage in the root or in specific fields
    const scanObject = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      
      // If we find an LLM response-like object
      if (obj.usage && obj.usage.total_tokens) {
        const model = obj.model || "qwen-max"; // Fallback
        tokenUsageByModel[model] = (tokenUsageByModel[model] || 0) + obj.usage.total_tokens;
      }
      
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
          scanObject(obj[key]);
        }
      }
    };
    
    scanObject(data);
  } catch(e) {}
}

// 1. Process JSONL
if (fs.existsSync(JSONL_FILE)) {
  const lines = fs.readFileSync(JSONL_FILE, 'utf8').split('\n');
  for (const line of lines) {
    if (line.trim()) processJSON(line);
  }
}

// 2. Process DB
if (fs.existsSync(DB_FILE)) {
  try {
    const rows = execSync(`sqlite3 "${DB_FILE}" "SELECT data FROM analysis_log;"`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 });
    for (const line of rows.split('\\n')) {
      if (line.trim()) processJSON(line);
    }
  } catch(e) { console.error("Error reading analysis_log:", e.message) }
  
  try {
    const rows2 = execSync(`sqlite3 "${DB_FILE}" "SELECT result FROM analyzed_events WHERE result IS NOT NULL;"`, { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 100 });
    for (const line of rows2.split('\\n')) {
      if (line.trim()) processJSON(line);
    }
  } catch(e) { console.error(e) }
}

console.log("Token Usage Re-calculated:");
console.log(JSON.stringify(tokenUsageByModel, null, 2));
fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenUsageByModel, null, 2));
console.log("Saved to token_usage.json");
