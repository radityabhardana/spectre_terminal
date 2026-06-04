import { formatHelp } from "./format.js";

export class TelegramBot {
  constructor(token, handler) {
    this.token = token;
    this.handler = handler;
    this.offset = 0;
    this.apiBase = `https://api.telegram.org/bot${token}`;
  }

  async start() {
    await this.setCommands().catch((error) => {
      console.error("setMyCommands error:", error.message);
    });
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
      if (update.callback_query) {
        await this.handleCallbackQuery(update.callback_query);
        continue;
      }

      if (!update.message?.chat?.id) continue;

      const chatId = update.message.chat.id;
      const text = update.message.text || "";
      if (!text.trim()) continue;

      try {
        const context = {
          chatId,
          sendMessage: (messageText, options = {}) =>
            this.sendMessage(chatId, messageText, options),
          editMessageText: (messageId, messageText, options = {}) =>
            this.editMessageText(chatId, messageId, messageText, options),
          sendChatAction: (action = "typing") => this.sendChatAction(chatId, action),
        };
        const answer = await this.handler(text, update.message, context);
        await this.sendAnswer(chatId, answer || formatHelp());
      } catch (error) {
        await this.sendMessage(chatId, `Error: ${error.message}`);
      }
    }
  }

  async handleCallbackQuery(callbackQuery) {
    const chatId = callbackQuery.message?.chat?.id;
    const text = callbackQuery.data || "";
    if (!chatId || !text.trim()) return;

    await this.answerCallbackQuery(callbackQuery.id).catch(() => {});

    try {
      const context = {
        chatId,
        sendMessage: (messageText, options = {}) =>
          this.sendMessage(chatId, messageText, options),
        editMessageText: (messageId, messageText, options = {}) =>
          this.editMessageText(chatId, messageId, messageText, options),
        sendChatAction: (action = "typing") => this.sendChatAction(chatId, action),
      };
      const answer = await this.handler(text, callbackQuery.message, context);
      await this.sendAnswer(chatId, answer || formatHelp());
    } catch (error) {
      await this.sendMessage(chatId, `Error: ${error.message}`);
    }
  }

  async sendAnswer(chatId, answer) {
    if (typeof answer === "string") {
      await this.sendMessage(chatId, answer);
      return;
    }

    await this.sendMessage(chatId, answer.text || formatHelp(), answer.options || {});
  }

  async setCommands() {
    const response = await fetch(`${this.apiBase}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start", description: "Tampilkan menu utama" },
          { command: "top", description: "Lihat market aktif yang lagi top" },
          { command: "search", description: "Cari market Polymarket" },
          { command: "analyze", description: "Analisis market, ID, atau link" },
          { command: "quickscan", description: "Scan cepat event tanpa Qwen" },
          { command: "top3", description: "Tampilkan top 3 pilihan event" },
          { command: "analyzebest", description: "Pilih kandidat paling worth it dari event" },
          { command: "analyzeall", description: "Jelaskan semua pilihan di event" },
          { command: "book", description: "Cek orderbook market" },
          { command: "example", description: "Contoh alur pakai bot" },
          { command: "version", description: "Cek versi bot" },
          { command: "help", description: "Bantuan command" },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram setMyCommands HTTP ${response.status}`);
    }
  }

  async answerCallbackQuery(callbackQueryId) {
    if (!callbackQueryId) return;

    const response = await fetch(`${this.apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId }),
    });

    if (!response.ok) {
      throw new Error(`Telegram answerCallbackQuery HTTP ${response.status}`);
    }
  }

  async sendChatAction(chatId, action = "typing") {
    const response = await fetch(`${this.apiBase}/sendChatAction`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });

    if (!response.ok) {
      throw new Error(`Telegram sendChatAction HTTP ${response.status}`);
    }
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    const response = await fetch(`${this.apiBase}/editMessageText`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        disable_web_page_preview: true,
        ...options,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram editMessageText HTTP ${response.status}`);
    }
  }

  async sendMessage(chatId, text, options = {}) {
    const chunks = splitTelegramMessage(text);
    const sent = [];
    for (const chunk of chunks) {
      const payload = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      };

      if (sent.length === 0) Object.assign(payload, options);

      const response = await fetch(`${this.apiBase}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Telegram sendMessage HTTP ${response.status}`);
      }
      const json = await response.json();
      if (json.result) sent.push(json.result);
    }

    return sent[0] || null;
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
