import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { handleCommand } from "./index.js";
import { enterCommandGuard, getCooldownState, releaseCommandGuard } from "./rate-limit.js";
import { SEARCH_ENGINE_VERSION, getMarketById, getShortTermMarkets, pickYesNoTokens } from "./polymarket.js";
import { ANALYSIS_STRATEGY_VERSION, completeTradeExecution, getAnalyzedEvents, getAnalyzedEventById, updateAnalyzedEventStatus, getReflectionByMarketId, getAllReflections, getAnalysisLogs, reserveTradeExecutions } from "./storage.js";
import { evaluateSingleEvent, evaluateAllResolutions } from "./evaluate.js";
import { getBinanceWsStatus } from "./binance_ws.js";
import { getShortMemoryEnabled, runWithAiLanguage, setShortMemoryEnabled } from "./qwen.js";
import { getSnifferWsStatus, getSnifferState, setSnifferState, getSnifferStartTime, getRecentWhales, getTrendingMarkets, getTrackerConfig, setTrackerConfig, setAggressiveMode, getAggressiveMode } from "./sniffer.js";
import { initWallet, getWalletBalances } from "./wallet.js";
import { initTradeModule } from "./trade.js";
import { getMarketPulseState, initializeMarketPulseMonitor, startMarketPulseMonitor, stopMarketPulseMonitor, subscribeMarketPulse } from "./market-pulse.js";

// Initialize wallet and trade module
const walletReady = config.enableLiveTrading ? initWallet() : false;
const tradeReadyPromise = config.enableLiveTrading && walletReady
  ? initTradeModule()
  : Promise.resolve(false);
const tradeIdempotencyKeys = new Map();

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

function patchShortMemoryOutcome(marketQuestion, outcome) {
  try {
    const histPath = path.join(dataDir, "short_condition_history.json");
    if (!fsSync.existsSync(histPath)) return;
    const hist = JSON.parse(fsSync.readFileSync(histPath, "utf-8"));
    const normalizedQuestion = String(marketQuestion || "").trim().toLowerCase();
    const index = hist.findLastIndex((item) =>
      String(item.marketQuestion || "").trim().toLowerCase() === normalizedQuestion && !item.outcome
    );
    if (index === -1) return;
    hist[index].outcome = outcome;
    fsSync.writeFileSync(histPath, JSON.stringify(hist, null, 2));
  } catch { /* silent — jangan ganggu flow resolve */ }
}

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
    qwenLabel: configured ? "AI provider configured" : "AI provider key missing",
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

async function runGuardedAiCommand(command, arg, task) {
  const guard = enterCommandGuard({
    command,
    arg,
    message: { chat: { id: "web" } },
    ctx: { chatId: "web" },
  });
  if (!guard.allowed) {
    const error = new Error(guard.message);
    error.status = 429;
    throw error;
  }
  try {
    return await task();
  } finally {
    releaseCommandGuard(guard);
  }
}

function validateTradeRequest(req) {
  if (!config.enableLiveTrading) throw Object.assign(new Error("Live trading is disabled"), { status: 403 });
  if (!config.webPassword) throw Object.assign(new Error("WEB_PASSWORD is required for live trading"), { status: 503 });
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
  }
  const origin = req.headers.origin;
  if (origin) {
    const expectedOrigin = `http://${req.headers.host}`;
    if (origin !== expectedOrigin) throw Object.assign(new Error("Cross-origin trade request rejected"), { status: 403 });
  }
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
  
  const messages = [];
  const context = createWebContext(messages, controller.signal, payload.language || "Indonesia");

  try {
    const answer = await runWithAiLanguage(payload.language || "Indonesia", () =>
      handleCommand(commandText, { text: commandText, chat: { id: "web" } }, context)
    );
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
  initializeMarketPulseMonitor();

  const server = http.createServer(async (req, res) => {
    try {
      if (!checkAuth(req, res)) return;

      if (req.method === "GET" && req.url === "/api/health") {
        const { checkAiProviderConnection, getTotalAITokensUsed } = await import('./qwen.js');
        const providerConnection = await checkAiProviderConnection();
        sendJson(res, 200, {
          ok: true,
          qwen: qwenHealth(),
          providerConnection,
          trading: {
            enabled: config.enableLiveTrading,
            authenticated: Boolean(config.webPassword),
          },
          engine: SEARCH_ENGINE_VERSION,
          cooldown: getCooldownState(),
          totalAITokensUsed: getTotalAITokensUsed()
        });
        return;
      }

      if (req.method === "GET" && req.url === "/api/ws-status") {
        sendJson(res, 200, {
          sniffer: getSnifferWsStatus(),
          binance: getBinanceWsStatus()
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
      
      if (req.method === "GET" && req.url === "/api/wallet-stream") {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        let isClosed = false;
        req.on('close', () => { isClosed = true; });

        const sendBalances = async () => {
          if (isClosed) return;
          const balances = await getWalletBalances();
          if (!isClosed) res.write(`data: ${JSON.stringify(balances)}\n\n`);
        };
        
        // Send initial balance
        sendBalances();
        
        // Poll every 10 seconds (standard block time is ~2-12s, 10s is reasonable for polling RPC)
        const intervalId = setInterval(sendBalances, 10000);
        
        req.on('close', () => {
          clearInterval(intervalId);
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
          const stats = getStats();
          const { totalAnalyzed, wins, losses } = stats;
          const totalResolved = wins + losses;
          const winRate = totalResolved > 0 ? Math.round((wins / totalResolved) * 100) : 0;
          
          sendJson(res, 200, { ok: true, stats: { ...stats, winRate } });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error.message) });
        }
        return;
      }

      if (req.method === "GET" && req.url === "/api/dashboard-metrics") {
        try {
          const { getDashboardMetrics } = await import("./storage.js");
          const metrics = getDashboardMetrics();
          sendJson(res, 200, { ok: true, metrics });
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

      // Toggle Short Market Memory (wires UI checkbox ke backend)
      if (req.url === "/api/settings/short-memory") {
        if (req.method === "GET") {
          sendJson(res, 200, { ok: true, enabled: getShortMemoryEnabled() });
        } else if (req.method === "POST") {
          const body = await readBody(req);
          setShortMemoryEnabled(body.enabled !== false);
          sendJson(res, 200, { ok: true, enabled: getShortMemoryEnabled() });
        } else {
          sendJson(res, 405, { ok: false, error: "Method not allowed" });
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
        if (!eventId || !marketId) {
          sendJson(res, 400, { ok: false, error: "Missing id or market_id" });
          return;
        }

        try {
          const storedEvent = getAnalyzedEventById(eventId);
          if (!storedEvent || String(storedEvent.market_id) !== String(marketId)) {
            sendJson(res, 400, { ok: false, error: "Event history does not match market_id" });
            return;
          }
          const prediction = storedEvent.prediction;
          const market = await getMarketById(marketId, true);
          
          const prices = market.outcomePrices.map(Number);
          const winners = prices
            .map((price, index) => ({ price, index }))
            .filter(({ price }) => price >= 0.99);
          const winnerIndex = winners.length === 1 && prices.every((price, index) => index === winners[0].index || price <= 0.01)
            ? winners[0].index
            : -1;
          
          if (market.closed && winnerIndex !== -1) {
            let status = 'selesai';
            let result = 'menunggu hasil';
            let actualOutcome = null;
            
            status = 'selesai';
            const winningOutcome = market.outcomes[winnerIndex];
            actualOutcome = winningOutcome;
            const p = (prediction || "").trim().toUpperCase();
            const w = (winningOutcome || "").trim().toUpperCase();
            const directMatch = p && w && p === w;
            const legacyAliasMatch = storedEvent.strategy_version !== ANALYSIS_STRATEGY_VERSION && (
              (p === "UP" && w === "YES") || (p === "YES" && w === "UP")
              || (p === "DOWN" && w === "NO") || (p === "NO" && w === "DOWN")
            );

            if (directMatch || legacyAliasMatch) {
              result = 'menang';
            } else if (p === "=" || p === "SKIP" || p === "NETRAL" || p === "WATCHLIST") {
              result = 'netral';
            } else {
              result = 'kalah';
            }
            
            updateAnalyzedEventStatus(eventId, status, result, actualOutcome);
            if (result === 'menang' || result === 'kalah' || result === 'netral') {
              patchShortMemoryOutcome(market.question, result);
            }
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
          const result = await runGuardedAiCommand("/evaluate", String(payload.eventId), () => evaluateSingleEvent(payload.eventId));
          if (result.error) {
            sendJson(res, result.status || 400, { ok: false, error: result.error });
          } else {
            sendJson(res, 200, { ok: true, reflection: result.reflection });
          }
        } catch (error) {
          sendJson(res, error.status || 500, { ok: false, error: error.message });
        }
        return;
      }

      if (req.method === "POST" && req.url === "/api/evaluate/all") {
        try {
          const result = await runGuardedAiCommand("/evaluate", "all", () => evaluateAllResolutions());
          sendJson(res, result.status === "Gagal" ? 502 : 200, { ok: result.status !== "Gagal", result });
        } catch (error) {
          sendJson(res, error.status || 500, { ok: false, error: error.message });
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

      if (req.method === "POST" && req.url === "/api/execute-trade") {
        try {
          validateTradeRequest(req);
          if (!await tradeReadyPromise) throw Object.assign(new Error("Trade module is not ready"), { status: 503 });
          const data = await readBody(req);
          if (!Array.isArray(data.trades) || data.trades.length === 0) throw new Error("Invalid trades array");
          if (data.trades.length > config.maxTradesPerRequest) throw new Error(`Maximum ${config.maxTradesPerRequest} trades per request`);

          const idempotencyKey = String(data.idempotencyKey || "").trim();
          if (!idempotencyKey || idempotencyKey.length > 100) throw new Error("A valid idempotencyKey is required");
          const idempotencyCutoff = Date.now() - 10 * 60 * 1000;
          for (const [key, timestamp] of tradeIdempotencyKeys) {
            if (timestamp < idempotencyCutoff) tradeIdempotencyKeys.delete(key);
          }
          if (tradeIdempotencyKeys.has(idempotencyKey)) throw Object.assign(new Error("Duplicate trade request rejected"), { status: 409 });
          tradeIdempotencyKeys.set(idempotencyKey, Date.now());

          const marketIds = data.trades.map((trade) => String(trade.marketId || "").trim());
          if (marketIds.some((id) => !id) || new Set(marketIds).size !== marketIds.length) throw new Error("Duplicate or missing marketId");
          const sizes = data.trades.map((trade) => Number(trade.sizeUsdc));
          if (sizes.some((size) => !Number.isFinite(size) || size <= 0 || size > config.maxTradeUsdc)) {
            throw new Error(`Each trade must be between 0 and ${config.maxTradeUsdc} USDC`);
          }
          const totalSize = sizes.reduce((sum, size) => sum + size, 0);
          if (totalSize > config.maxTradeBatchUsdc) throw new Error(`Batch exceeds ${config.maxTradeBatchUsdc} USDC`);

          const history = getAnalyzedEvents(2000);
          const prepared = await Promise.all(data.trades.map(async (trade, index) => {
            const marketId = marketIds[index];
            const market = await getMarketById(marketId, true);
            if (!market || market.closed || !market.active || !market.acceptingOrders) throw new Error(`${marketId}: market is not open for trading`);
            const closesAt = new Date(market.endDate).getTime();
            if (!Number.isFinite(closesAt) || closesAt - Date.now() < config.tradeMinSecondsToClose * 1000) {
              throw new Error(`${marketId}: market is too close to expiry`);
            }

            const stored = history.find((item) => String(item.market_id) === marketId);
            const signalAgeMs = Date.now() - new Date(stored?.signal_data_at).getTime();
            if (!stored || stored.strategy_version !== ANALYSIS_STRATEGY_VERSION || !stored.signal_data_at || !Number.isFinite(signalAgeMs) || signalAgeMs < 0 || signalAgeMs > config.tradeSignalTtlSeconds * 1000) {
              throw new Error(`${marketId}: stored signal is missing, stale, or from another strategy version`);
            }
            const storedPrediction = String(stored.prediction || "").trim().toUpperCase();
            const requestedPrediction = String(trade.prediction || "").trim().toUpperCase();
            if (stored.actionable !== 1 || !["YES", "UP", "NO", "DOWN"].includes(storedPrediction) || requestedPrediction !== storedPrediction) {
              throw new Error(`${marketId}: prediction is not actionable or does not match`);
            }
            const { yesTokenId, noTokenId } = pickYesNoTokens(market);
            const tokenId = ["YES", "UP"].includes(storedPrediction) ? yesTokenId : noTokenId;
            if (!tokenId) throw new Error(`${marketId}: token ID could not be determined`);
            const maxEntryPrice = Math.min(config.tradeMaxPrice, Number(stored.max_entry_price));
            if (!Number.isFinite(maxEntryPrice) || maxEntryPrice <= 0) throw new Error(`${marketId}: signal has no valid edge-preserving entry price`);
            return { analysisId: stored.id, marketId, tokenId, sizeUsdc: sizes[index], maxEntryPrice };
          }));

          if (!reserveTradeExecutions(idempotencyKey, prepared)) {
            throw Object.assign(new Error("Trade request or analyzed signal was already consumed"), { status: 409 });
          }
          const { executeMarketOrder } = await import('./trade.js');
          const results = [];
          for (const trade of prepared) {
            try {
              const result = await executeMarketOrder(trade.tokenId, "BUY", trade.sizeUsdc, trade.maxEntryPrice);
              completeTradeExecution(trade.analysisId, "succeeded", result);
              results.push({ marketId: trade.marketId, success: true, result });
            } catch (error) {
              completeTradeExecution(trade.analysisId, "failed", { error: error.message });
              results.push({ marketId: trade.marketId, success: false, error: error.message });
            }
          }
          sendJson(res, 200, { ok: results.every((result) => result.success), results });
        } catch (error) {
          sendJson(res, error.status || 400, { ok: false, error: error.message });
        }
        return;
      }

      if (req.url === "/api/market-pulse/stream" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        const sendState = (pulseState) => res.write(`data: ${JSON.stringify(pulseState)}\n\n`);
        sendState(getMarketPulseState());
        const unsubscribe = subscribeMarketPulse(sendState);
        req.on("close", unsubscribe);
        return;
      }

      if (req.url === "/api/market-pulse" && req.method === "GET") {
        return sendJson(res, 200, { ok: true, data: getMarketPulseState() });
      }

      if (req.url === "/api/market-pulse" && req.method === "POST") {
        try {
          const body = await readBody(req);
          const pulseState = await startMarketPulseMonitor(body);
          return sendJson(res, 200, { ok: true, data: pulseState });
        } catch (error) {
          console.error("Market pulse error:", error);
          return sendJson(res, 500, { ok: false, error: error.message });
        }
      }

      if (req.url === "/api/market-pulse" && req.method === "DELETE") {
        return sendJson(res, 200, { ok: true, data: stopMarketPulseMonitor() });
      }

      if (req.url === "/api/sniffer-status" && req.method === "GET") {
        return sendJson(res, 200, { isSnifferActive: getSnifferState(), startTime: getSnifferStartTime() });
      }

      if (req.url === "/api/sniffer-whales" && req.method === "GET") {
        const whales = getRecentWhales(0); // Defer to sniffer config limit
        const trending = getTrendingMarkets(5); // Top 5 trending markets
        
        // Dynamic import to avoid circular dependency issues if any
        const { getAccumulatedWhaleVolume, getTimeframeFilter } = await import('./sniffer.js');
        const { getTotalAITokensUsed } = await import('./qwen.js');

        return sendJson(res, 200, {
          isSnifferActive: getSnifferState(),
          startTime: getSnifferStartTime(),
          whales: whales,
          trending: trending,
          accumulatedWhaleVolume: getAccumulatedWhaleVolume(),
          timeframeFilter: getTimeframeFilter()
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
        const { getTimeframeFilter, setTimeframeFilter } = await import('./sniffer.js');
        if (req.method === "GET") {
          return sendJson(res, 200, { ...getTrackerConfig(), timeframeFilter: getTimeframeFilter() });
        }
        if (req.method === "POST") {
          const body = await readBody(req);
          if (body.minUsd !== undefined || body.wallets !== undefined) {
            setTrackerConfig(body.minUsd, body.wallets);
          }
          if (body.timeframeFilter !== undefined) {
            setTimeframeFilter(body.timeframeFilter);
          }
          return sendJson(res, 200, { ...getTrackerConfig(), timeframeFilter: getTimeframeFilter() });
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
