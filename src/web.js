import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { handleCommand } from "./index.js";
import { getCooldownState } from "./rate-limit.js";
import { SEARCH_ENGINE_VERSION, getMarketById } from "./polymarket.js";
import { getAnalysisLogs, getAnalyzedEvents, updateAnalyzedEventStatus } from "./storage.js";

const modulePath = fileURLToPath(import.meta.url);
const __dirname = path.dirname(modulePath);
const publicDir = path.resolve(__dirname, "..", "public");
const port = Number(process.env.WEB_PORT || process.env.PORT || 8787);
const host = process.env.WEB_HOST || "127.0.0.1";

const modeCommands = {
  auto: "",
  top: "/top",
  search: "/search",
  analyze: "/analyze",
  quickscan: "/quickscan",
  top3: "/top3",
  analyzebest: "/analyzebest",
  analyzeall: "/analyzeall",
  book: "/book",
};

function qwenHealth() {
  const configured = Boolean(config.qwenApiKey);
  return {
    qwenConfigured: configured,
    qwenStatus: configured ? "key_loaded" : "missing",
    qwenLabel: configured ? "Qwen key loaded" : "Qwen key missing",
  };
}

function rateLimitHealth(scope = "web") {
  return {
    rateLimit: {
      commandCooldownMs: config.commandCooldownMs,
      duplicateCommandCooldownMs: config.duplicateCommandCooldownMs,
      qwenCommandCooldownMs: config.qwenCommandCooldownMs,
      ...getCooldownState(scope),
    },
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function sendJson(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function normalizeOptions(options = {}) {
  const inline = options?.reply_markup?.inline_keyboard;
  if (!Array.isArray(inline)) return { buttons: [] };

  return {
    buttons: inline.map((row) =>
      row
        .filter((button) => button?.text && button?.callback_data)
        .map((button) => ({
          label: button.text,
          command: button.callback_data,
        }))
    ),
  };
}

function pushMessage(messages, text, options = {}, role = "assistant") {
  const message = {
    id: messages.length + 1,
    role,
    text: String(text || ""),
    ...normalizeOptions(options),
  };
  messages.push(message);
  return message;
}

function normalizeAnswer(answer) {
  if (typeof answer === "string") return { text: answer, options: {} };
  return {
    text: answer?.text || "",
    options: answer?.options || {},
  };
}

function createWebContext(messages, signal = null) {
  return {
    chatId: "web",
    signal,
    sendMessage: async (messageText, options = {}) => {
      const message = pushMessage(messages, messageText, options);
      return { message_id: message.id };
    },
    editMessageText: async (messageId, messageText, options = {}) => {
      const index = Number(messageId) - 1;
      if (messages[index]) {
        messages[index] = {
          ...messages[index],
          text: String(messageText || ""),
          ...normalizeOptions(options),
        };
        return messages[index];
      }
      const message = pushMessage(messages, messageText, options);
      return { message_id: message.id };
    },
    sendChatAction: async () => {},
  };
}

function commandFromPayload(payload) {
  const input = String(payload?.text || "").trim();
  const mode = String(payload?.mode || "auto").toLowerCase();
  if (!input && mode === "top") return "/top";
  if (!input) return "";
  if (input.startsWith("/")) return input;
  const command = modeCommands[mode] || "";
  return command ? `${command} ${input}` : input;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request terlalu besar.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleApiCommand(req, res) {
  const controller = new AbortController();
  req.on("aborted", () => controller.abort());
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const payload = await readBody(req);
  const commandText = commandFromPayload(payload);
  if (!commandText) {
    sendJson(res, 400, { ok: false, error: "Isi input dulu." });
    return;
  }

  const messages = [];
  const context = createWebContext(messages, controller.signal);

  try {
    const answer = await handleCommand(commandText, { text: commandText, chat: { id: "web" } }, context);
    const normalized = normalizeAnswer(answer);
    pushMessage(messages, normalized.text, normalized.options);

    sendJson(res, 200, {
      ok: true,
      command: commandText,
      version: SEARCH_ENGINE_VERSION,
      ...qwenHealth(),
      ...rateLimitHealth(),
      messages,
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    sendJson(res, 500, {
      ok: false,
      command: commandText,
      version: SEARCH_ENGINE_VERSION,
      error: error.message || String(error),
      ...rateLimitHealth(),
      messages,
    });
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = path.resolve(publicDir, decodeURIComponent(relativePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function checkAuth(req, res) {
  if (!config.webPassword) return true;
  
  const auth = req.headers.authorization;
  if (!auth) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="MVPM Terminal"',
      "content-type": "text/plain; charset=utf-8"
    });
    res.end("Unauthorized");
    return false;
  }
  
  const b64auth = (auth.split(' ')[1] || '');
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
  
  if (password === config.webPassword || login === config.webPassword) {
    return true;
  }
  
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="MVPM Terminal"',
    "content-type": "text/plain; charset=utf-8"
  });
  res.end("Unauthorized");
  return false;
}

export function startWebServer(options = {}) {
  const webPort = Number(options.port || port);
  const webHost = options.host || host;

  const server = http.createServer(async (req, res) => {
    try {
      if (!checkAuth(req, res)) return;

      if (req.method === "GET" && req.url === "/api/health") {
        sendJson(res, 200, {
          ok: true,
          version: SEARCH_ENGINE_VERSION,
          ...qwenHealth(),
          ...rateLimitHealth(),
        });
        return;
      }

      if (req.method === "POST" && req.url === "/api/command") {
        await handleApiCommand(req, res);
        return;
      }

      if (req.method === "GET" && req.url === "/api/history") {
        const logs = getAnalysisLogs(50);
        sendJson(res, 200, { ok: true, history: logs });
        return;
      }

      if (req.method === "GET" && req.url === "/api/history/events") {
        const events = getAnalyzedEvents(100);
        sendJson(res, 200, { ok: true, events });
        return;
      }

      if (req.method === "POST" && req.url === "/api/history/events/check") {
        const payload = await readBody(req);
        const eventId = payload.id;
        const marketId = payload.market_id;
        const prediction = payload.prediction;

        if (!eventId || !marketId) {
          sendJson(res, 400, { ok: false, error: "Missing id or market_id" });
          return;
        }

        try {
          const market = await getMarketById(marketId);
          
          let winnerIndex = -1;
          for (let i = 0; i < market.outcomePrices.length; i++) {
            if (Number(market.outcomePrices[i]) >= 0.95) {
              winnerIndex = i;
              break;
            }
          }

          if (market.closed || !market.active || winnerIndex !== -1) {
            let status = 'selesai';
            let result = 'menunggu hasil';
            
            if (winnerIndex === -1 && market.closed) {
               let maxPrice = -1;
               for (let i = 0; i < market.outcomePrices.length; i++) {
                 if (Number(market.outcomePrices[i]) > maxPrice) {
                   maxPrice = Number(market.outcomePrices[i]);
                   winnerIndex = i;
                 }
               }
            }
            
            if (winnerIndex !== -1) {
              const winningOutcome = market.outcomes[winnerIndex];
              if (prediction && winningOutcome && prediction.toLowerCase() === winningOutcome.toLowerCase()) {
                result = 'menang';
              } else {
                result = 'kalah';
              }
            }
            
            updateAnalyzedEventStatus(eventId, status, result);
            sendJson(res, 200, { ok: true, status, result });
          } else {
            sendJson(res, 200, { ok: true, status: 'belum selesai', result: null, message: "Market is still active" });
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: "Failed to check market status: " + error.message });
        }
        return;
      }

      if (req.method === "GET") {
        await serveStatic(req, res);
        return;
      }

      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
  });

  server.listen(webPort, webHost, () => {
    console.log(`Web UI running at http://${webHost}:${webPort}`);
  });

  return server;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === modulePath;

if (isMainModule) {
  startWebServer();
}
