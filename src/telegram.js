import { formatHelp } from "./format.js";

export class TelegramBot {
  constructor(token, handler) {
    this.token = token;
    this.handler = handler;
    this.offset = 0;
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  async start() {
    console.log("Telegram bot polling started.");
    while (true) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error("Polling error:", error.message);
        await sleep(3000);
      }
    }
  }

  async pollOnce() {
    const url = new URL(`${this.apiBase}/getUpdates`);
    url.searchParams.set("timeout", "25");
    url.searchParams.set("offset", String(this.offset));

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram getUpdates HTTP ${response.status}`);

    const json = await response.json();
    for (const update of json.result || []) {
      this.offset = update.update_id + 1;
      if (!update.message?.chat?.id) continue;

      const chatId = update.message.chat.id;
      const text = update.message.text || "";
      if (!text.startsWith("/")) continue;

      try {
        const answer = await this.handler(text, update.message);
        await this.sendMessage(chatId, answer || formatHelp());
      } catch (error) {
        await this.sendMessage(chatId, `Error: ${error.message}`);
      }
    }
  }

  async sendMessage(chatId, text) {
    const chunks = splitTelegramMessage(text);
    for (const chunk of chunks) {
      const response = await fetch(`${this.apiBase}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          disable_web_page_preview: true,
        }),
      });
      if (!response.ok) {
        throw new Error(`Telegram sendMessage HTTP ${response.status}`);
      }
    }
  }
}

function splitTelegramMessage(text) {
  const limit = 3900;
  if (text.length <= limit) return [text];

  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < 1000) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
