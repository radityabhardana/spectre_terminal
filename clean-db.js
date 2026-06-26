import { db } from './src/storage.js';

console.log("Cleaning bad reflections...");
const stmt = db.prepare("DELETE FROM prediction_reflections WHERE reflection_note LIKE '%Error memanggil Qwen%' OR reflection_note LIKE '%Gagal%'");
const result = stmt.run();
console.log(`Deleted ${result.changes} rows.`);
