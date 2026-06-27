import { startBinanceLiquidationStream, stopBinanceLiquidationStream, getRecentLiquidations } from "../src/binance_ws.js";
import { evaluateShortMarketCondition } from "../src/short_condition.js";

async function runTest() {
  console.log("Menjalankan WebSocket Liquidation Stream...");
  startBinanceLiquidationStream();
  
  console.log("Menunggu 5 detik untuk membiarkan WebSocket terkoneksi...");
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  console.log("Liquidations in memory:", getRecentLiquidations("BTCUSDT", 15));

  console.log("\nMemulai Analisis Short Market Condition untuk BTCUSDT...");
  try {
    const result = await evaluateShortMarketCondition({ asset: "BTC" });
    console.log("\nHasil Analisis:");
    console.log("Liquidations:", result.liquidations);
    console.log("Verdict:", result.evaluation.recommendation);
    console.log("Direction:", result.evaluation.direction);
    console.log("Reason:", result.evaluation.reason);
    console.log("Liquidation Verdict:", result.evaluation.key_signals?.liquidation_verdict);
  } catch (err) {
    console.error("Gagal melakukan analisis:", err);
  } finally {
    stopBinanceLiquidationStream();
    process.exit(0);
  }
}

runTest();
