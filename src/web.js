import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { handleCommand } from "./index.js";
import { getCooldownState } from "./rate-limit.js";
import { SEARCH_ENGINE_VERSION, getMarketById, getShortTermMarkets } from "./polymarket.js";
import { getAnalyzedEvents, getAnalyzedEventById, updateAnalyzedEventStatus, getReflectionByMarketId, getAllReflections, getAnalysisLogs } from "./storage.js";
import { evaluateSingleEvent, evaluateAllResolutions } from "./evaluate.js";
import { getSnifferState, setSnifferState, getSnifferStartTime, getRecentWhales, getTrendingMarkets, getTrackerConfig, setTrackerConfig, setAggressiveMode, getAggressiveMode } from "./sniffer.js";
import { scrapeTwitter } from "./twitter_scraper.js";

const sseClients = new Set();

export function broadcastAlert(data) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

const modulePath = fileURLToPath(import.meta.url);
const __dirname = path.dirname(modulePath);
const publicDir = path.resolve(__dirname, "..", "public");
const dataDir = path.resolve(__dirname, "..", "data");
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

function createWebContext(messages, signal = null, language = "Indonesia") {
  return {
    chatId: "web",
    signal,
    language,
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
    deleteMessage: async (messageId) => {
      const index = Number(messageId) - 1;
      if (messages[index]) {
        messages[index] = { ...messages[index], deleted: true, text: "" };
        return { message_id: messageId };
      }
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
  
  if (payload.language) {
    config.botLanguage = payload.language;
  }

  const messages = [];
  const context = createWebContext(messages, controller.signal, payload.language || "Indonesia");

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
          qwen: qwenHealth(),
          engine: SEARCH_ENGINE_VERSION,
          cooldown: getCooldownState(),
        });
        return;
      }
      
      if (req.method === "GET" && req.url === "/api/live-alerts") {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        // Send initial connection heartbeat
        res.write(`data: {"type":"CONNECTED"}\n\n`);
        
        sseClients.add(res);
        
        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }
      
      if (req.method === "GET" && req.url === "/api/live-prices") {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        res.write(`data: ${JSON.stringify(global.livePrices || {})}\n\n`);
        
        const intervalId = setInterval(() => {
          res.write(`data: ${JSON.stringify(global.livePrices || {})}\n\n`);
        }, 1000);
        
        req.on('close', () => {
          clearInterval(intervalId);
        });
        return;
      }
      
      if (req.method === "GET" && req.url.startsWith("/api/short-term")) {
        try {
          const urlObj = new URL(req.url, `http://${req.headers.host}`);
          const asset = urlObj.searchParams.get("asset") || "btc";
          const markets = await getShortTermMarkets(asset);
          sendJson(res, 200, { ok: true, markets });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message) });
        }
        return;
      }

      if (req.method === "GET" && req.url === "/api/stats") {
        try {
          const { getStats } = await import("./storage.js");
          const { totalAnalyzed, wins, losses } = getStats();
          const totalResolved = wins + losses;
          const winRate = totalResolved > 0 ? Math.round((wins / totalResolved) * 100) : 0;
          
          sendJson(res, 200, { ok: true, stats: { totalAnalyzed, wins, losses, winRate } });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message) });
        }
        return;
      }

      if (req.method === "GET" && req.url === "/api/reflections") {
        try {
          const reflections = getAllReflections();
          sendJson(res, 200, { ok: true, reflections });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message) });
        }
        return;
      }

      if (req.method === "GET" && req.url === "/api/memory-checklist") {
        try {
          const { getRecentReflections } = await import("./storage.js");
          const recent = getRecentReflections(15);
          
          function extractCoreLesson(text) {
            if (!text) return "Tidak ada catatan.";
            const kw = "3. **Core Lesson Learned";
            const idx = text.indexOf(kw);
            if (idx !== -1) {
              let after = text.substring(idx + kw.length);
              const nl = after.indexOf('\\n');
              if (nl !== -1) after = after.substring(nl + 1).trim();
              return after.substring(0, 500);
            }
            return text.length > 300 ? "..." + text.substring(text.length - 300) : text;
          }
          
          let text = "GLOBAL TRAPS CHECKLIST (EXTRACTED RAG MEMORY):\\n";
          if (recent.length > 0) {
            text += recent.map((r, i) => `${i+1}. [Market: ${r.question} | Tebakan Salah: ${r.prediction}] -> ${extractCoreLesson(r.reflection_note)}`).join("\\n\\n");
          } else {
            text += "Belum ada memori.";
          }
          sendJson(res, 200, { ok: true, text });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message) });
        }
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

      if (req.method === "GET" && req.url.startsWith("/api/twitter-search")) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const q = urlObj.searchParams.get("q");
        if (!q) {
          return sendJson(res, 400, { ok: false, error: "Missing q parameter" });
        }
        const tweets = await scrapeTwitter(q);
        return sendJson(res, 200, { ok: true, tweets });
      }

      if (req.method === "GET" && req.url.startsWith("/api/history/events")) {
        const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        if (parsedUrl.pathname === "/api/history/events") {
          const startDate = parsedUrl.searchParams.get("startDate");
          const endDate = parsedUrl.searchParams.get("endDate");
          const events = getAnalyzedEvents(2000, startDate, endDate); // Increased limit so UI shows correct overall stats
          sendJson(res, 200, { ok: true, events });
          return;
        }
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
          const market = await getMarketById(marketId, true);
          
          let winnerIndex = -1;
          for (let i = 0; i < market.outcomePrices.length; i++) {
            if (Number(market.outcomePrices[i]) >= 0.90) {
              winnerIndex = i;
              break;
            }
          }
          
          let isTimeClosed = false;
          if (market.endDate) {
             const timeToClose = new Date(market.endDate).getTime() - Date.now();
             if (timeToClose <= 0) isTimeClosed = true;
          }

          if (market.closed || !market.active || winnerIndex !== -1 || isTimeClosed) {
            let status = 'selesai';
            let result = 'menunggu hasil';
            let actualOutcome = null;
            
            if (winnerIndex !== -1) {
              status = 'selesai';
              const winningOutcome = market.outcomes[winnerIndex];
              actualOutcome = winningOutcome; // Set actual outcome
              const p = (prediction || "").trim().toUpperCase();
              const w = (winningOutcome || "").trim().toUpperCase();
              
              // Direct match (case-insensitive)
              const directMatch = p && w && p === w;
              // Alias match: UP=YES, DOWN=NO (some Polymarket markets use Yes/No)
              const aliasMatch = (p === "UP" && w === "YES") || (p === "YES" && w === "UP")
                || (p === "DOWN" && w === "NO") || (p === "NO" && w === "DOWN");

              if (directMatch || aliasMatch) {
                result = 'menang';
              } else if (p === "=" || p === "SKIP" || p === "NETRAL" || p === "WATCHLIST") {
                result = 'netral';
              } else {
                result = 'kalah';
              }
            } else {
              // Not resolved yet, even if market.closed is true.
              status = 'belum selesai';
              result = 'menunggu hasil';
            }
            
            updateAnalyzedEventStatus(eventId, status, result, actualOutcome);
            sendJson(res, 200, { ok: true, status, result, actualOutcome });
          } else {
            sendJson(res, 200, { ok: true, status: 'belum selesai', result: null, message: "Market is still active" });
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: "Failed to check market status: " + error.message });
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/evaluate/single") {
        const payload = await readBody(req);
        if (!payload.eventId) {
          sendJson(res, 400, { ok: false, error: "Missing eventId" });
          return;
        }
        try {
          const result = await evaluateSingleEvent(payload.eventId);
          if (result.error) {
            sendJson(res, 400, { ok: false, error: result.error });
          } else {
            sendJson(res, 200, { ok: true, reflection: result.reflection });
          }
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message });
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/evaluate/all") {
        try {
          const result = await evaluateAllResolutions();
          sendJson(res, 200, { ok: true, result });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message });
        }
        return;
      }

      if (req.method === "GET" && req.url.startsWith("/api/evaluate/reflection/")) {
        const urlObj = new URL(req.url, `http://${req.headers.host}`);
        const parts = urlObj.pathname.split("/");
        const marketId = parts[parts.length - 1];
        if (!marketId) {
          sendJson(res, 400, { ok: false, error: "Missing marketId" });
          return;
        }
        try {
          const reflection = getReflectionByMarketId(marketId);
          sendJson(res, 200, { ok: true, reflection: reflection ? reflection.reflection_note : null });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: error.message });
        }
        return;
      }

      if (req.url === "/api/sniffer-status" && req.method === "GET") {
        return sendJson(res, 200, { isSnifferActive: getSnifferState(), startTime: getSnifferStartTime() });
      }

      if (req.url === "/api/sniffer-whales" && req.method === "GET") {
        const whales = getRecentWhales(0); // Defer to sniffer config limit
        const trending = getTrendingMarkets(5); // Top 5 trending markets
        return sendJson(res, 200, {
          isSnifferActive: getSnifferState(),
          startTime: getSnifferStartTime(),
          whales: whales,
          trending: trending
        });
      }

      if (req.url === "/api/sniffer-toggle" && req.method === "POST") {
        const body = await readBody(req);
        const newState = setSnifferState(body.active);
        return sendJson(res, 200, { isSnifferActive: newState, startTime: getSnifferStartTime() });
      }

      if (req.url === "/api/settings/aggressive-mode" && req.method === "POST") {
        const body = await readBody(req);
        setAggressiveMode(!!body.enabled);
        return sendJson(res, 200, { aggressiveMode: getAggressiveMode() });
      }

      if (req.url === "/api/settings/aggressive-mode" && req.method === "GET") {
        return sendJson(res, 200, { aggressiveMode: getAggressiveMode() });
      }

      if (req.url === "/api/tracker-config") {
        if (req.method === "GET") {
          return sendJson(res, 200, getTrackerConfig());
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          setTrackerConfig(body.minUsd, body.wallets);
          return sendJson(res, 200, getTrackerConfig());
        }
      }

      if (req.method === "GET" && req.url.startsWith("/api/wallet-profile/")) {
        const address = req.url.replace("/api/wallet-profile/", "").split('?')[0];
        if (!address) return sendJson(res, 400, { error: "No address provided" });
        try {
          const fetchWithRetry = async (url, retries = 3) => {
            for (let i = 0; i < retries; i++) {
              try {
                const r = await fetch(url);
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return await r.json();
              } catch (err) {
                if (i === retries - 1) throw err;
                await new Promise(res => setTimeout(res, 1000 * (i + 1)));
              }
            }
          };

          const [posData, tradesData, lbData] = await Promise.all([
            fetchWithRetry(`https://data-api.polymarket.com/positions?user=${address}&limit=1000`).catch(() => []),
            fetchWithRetry(`https://data-api.polymarket.com/trades?user=${address}&limit=50`).catch(() => []),
            fetchWithRetry(`https://lb-api.polymarket.com/profit?address=${address}&window=all`).catch(() => [])
          ]);
          
          let positions = [];
          let allTimePnl = 0;
          if (Array.isArray(posData)) {
            positions = posData.filter(p => p.currentValue > 0 || parseFloat(p.size) > 0);
            positions.sort((a,b) => b.currentValue - a.currentValue);
          }
          
          if (Array.isArray(lbData) && lbData.length > 0) {
            allTimePnl = parseFloat(lbData[0].amount) || 0;
          }
          
          let history = [];
          if (Array.isArray(tradesData)) {
            history = tradesData;
          }
          
          const totalValue = positions.reduce((sum, p) => sum + (parseFloat(p.currentValue) || 0), 0);
          
          return sendJson(res, 200, {
            positions: positions.slice(0, 30),
            history,
            totalValue,
            allTimePnl
          });
        } catch (e) {
          return sendJson(res, 500, { error: e.message });
        }
      }

      if (req.method === "GET" && req.url === "/api/short-learning") {
        try {
          const histPath = path.join(dataDir, "short_condition_history.json");
          let history = [];
          try {
            const rawData = await fs.readFile(histPath, "utf-8");
            history = JSON.parse(rawData);
          } catch (e) {
            // ignore if not exists
          }
          return sendJson(res, 200, { ok: true, history: history.reverse() });
        } catch(err) {
          return sendJson(res, 500, { error: err.message });
        }
      }

      // Serve static files
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
