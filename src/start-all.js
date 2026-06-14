import { startTelegramBot, stopTelegramBot } from "./index.js";
import { startWebServer } from "./web.js";

const webServer = startWebServer();
startTelegramBot();

console.log("Telegram bot and Web UI are running.");

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down gracefully...");
  stopTelegramBot();
  webServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000); // force exit if hanging
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (error) => {
  // Log tapi jangan crash — error dari background task (Shadow Bot, Qwen timeout, dll)
  // tidak boleh membunuh seluruh server
  console.error("[UNCAUGHT EXCEPTION - server tetap jalan]:", error?.message || error);
});
process.on("unhandledRejection", (reason) => {
  // Sama — jangan crash jika ada promise rejection dari Qwen/fetch timeout
  console.error("[UNHANDLED REJECTION - server tetap jalan]:", reason?.message || reason);
});
