const Database = require('better-sqlite3');
const db = new Database('./data/database.db');
const info = db.prepare("DELETE FROM prediction_reflections WHERE reflection_note LIKE '%Error memanggil Qwen%' OR reflection_note LIKE '%Gagal%'").run();
console.log(info);
