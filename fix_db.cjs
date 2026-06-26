const Database = require('better-sqlite3');
const db = new Database('c:/ALL/Razor Bot/data/database.db');
const info = db.prepare("UPDATE analyzed_events SET result = 'netral' WHERE prediction IN ('=', 'SKIP', 'NETRAL', 'WATCHLIST') AND result = 'kalah'").run();
console.log('Fixed:', info.changes);
