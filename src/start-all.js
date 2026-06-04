import { startTelegramBot } from "./index.js";
import { startWebServer } from "./web.js";

const webServer = startWebServer();
startTelegramBot();

console.log("Telegram bot and Web UI are running.");

function shutdown() {
  console.log("Shutting down...");
  webServer.close(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
