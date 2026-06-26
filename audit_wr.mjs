import Database from "better-sqlite3";
const db = new Database("data/database.db");

const reflections = db.prepare("SELECT COUNT(*) as c FROM prediction_reflections").get();
console.log("Total RAG Reflections:", reflections.c);

const wins = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result = 'menang'").get();
const loss = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result = 'kalah'").get();
const netral = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result = 'netral'").get();
const total = wins.c + loss.c;
const wr = total > 0 ? ((wins.c / total) * 100).toFixed(1) : "N/A";
console.log(`WR Stats: menang=${wins.c} | kalah=${loss.c} | netral=${netral.c} | WR=${wr}%`);

// WR by prediksi type
const upWin  = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='menang' AND prediction='UP'").get();
const upLoss = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='kalah'  AND prediction='UP'").get();
const downWin  = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='menang' AND prediction='DOWN'").get();
const downLoss = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='kalah'  AND prediction='DOWN'").get();
const upTotal = upWin.c + upLoss.c;
const downTotal = downWin.c + downLoss.c;
console.log(`UP   predictions: menang=${upWin.c} kalah=${upLoss.c} WR=${upTotal>0?((upWin.c/upTotal)*100).toFixed(1):"N/A"}%`);
console.log(`DOWN predictions: menang=${downWin.c} kalah=${downLoss.c} WR=${downTotal>0?((downWin.c/downTotal)*100).toFixed(1):"N/A"}%`);

// WR terakhir 30 entry
const recent30 = db.prepare("SELECT result FROM analyzed_events WHERE result IN ('menang','kalah') ORDER BY id DESC LIMIT 30").all();
const r30w = recent30.filter(x => x.result === "menang").length;
const r30l = recent30.filter(x => x.result === "kalah").length;
console.log(`Last 30: menang=${r30w} kalah=${r30l} WR=${((r30w/(r30w+r30l))*100).toFixed(1)}%`);

// WR dengan qwen_confidence null vs ada
const withConfW = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='menang' AND qwen_confidence IS NOT NULL").get();
const withConfL = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='kalah' AND qwen_confidence IS NOT NULL").get();
const noConfW  = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='menang' AND qwen_confidence IS NULL").get();
const noConfL  = db.prepare("SELECT COUNT(*) as c FROM analyzed_events WHERE result='kalah' AND qwen_confidence IS NULL").get();
const wct = withConfW.c + withConfL.c;
const nct = noConfW.c + noConfL.c;
console.log(`With Qwen Conf: menang=${withConfW.c} kalah=${withConfL.c} WR=${wct>0?((withConfW.c/wct)*100).toFixed(1):"N/A"}%`);
console.log(`No Qwen Conf  : menang=${noConfW.c} kalah=${noConfL.c} WR=${nct>0?((noConfW.c/nct)*100).toFixed(1):"N/A"}%`);

// High confidence entries vs low
const highConf = db.prepare("SELECT result FROM analyzed_events WHERE CAST(qwen_confidence AS INTEGER) >= 85 AND result IN ('menang','kalah')").all();
const highW = highConf.filter(x => x.result === "menang").length;
const highL = highConf.filter(x => x.result === "kalah").length;
const lowConf = db.prepare("SELECT result FROM analyzed_events WHERE CAST(qwen_confidence AS INTEGER) BETWEEN 60 AND 84 AND result IN ('menang','kalah')").all();
const lowW = lowConf.filter(x => x.result === "menang").length;
const lowL = lowConf.filter(x => x.result === "kalah").length;
console.log(`Conf >= 85: menang=${highW} kalah=${highL} WR=${(highW+highL)>0?((highW/(highW+highL))*100).toFixed(1):"N/A"}%`);
console.log(`Conf 60-84: menang=${lowW} kalah=${lowL} WR=${(lowW+lowL)>0?((lowW/(lowW+lowL))*100).toFixed(1):"N/A"}%`);

db.close();
