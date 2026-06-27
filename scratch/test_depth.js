import { startBinanceDepthStream, stopBinanceDepthStream, getOrderbookImbalance } from "../src/binance_ws.js";
import { evaluateShortMarketCondition } from "../src/short_condition.js";

async function runTest() {
  console.log("Menjalankan WebSocket Depth Stream...");
  startBinanceDepthStream();
  
  console.log("Menunggu 5 detik untuk membiarkan WebSocket terkoneksi dan menerima data...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log("Depth in memory:", getOrderbookImbalance("BTCUSDT"));

  console.log("\nMemulai Analisis Short Market Condition untuk BTCUSDT...");
  try {
    const result = await evaluateShortMarketCondition({ asset: "BTC" });
    console.log("\nHasil Analisis:");
    console.log("Depth Data:", result.depth);
    console.log("Verdict:", result.evaluation.recommendation);
    console.log("Direction:", result.evaluation.direction);
    console.log("Reason:", result.evaluation.reason);
    console.log("Depth Verdict:", result.evaluation.key_signals?.depth_verdict);
  } catch (err) {
    console.error("Gagal melakukan analisis:", err);
  } finally {
    stopBinanceDepthStream();
    process.exit(0);
  }
}

runTest();
