import fs from "node:fs/promises";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { startBtc15mObserveCollector, stopBtc15mObserveCollector } from "./short-observe-coordinator.js";
import { getFastShortEntrySnapshot, handleCommand } from "./index.js";
import { enterCommandGuard, getCooldownState, releaseCommandGuard } from "./rate-limit.js";
import { SEARCH_ENGINE_VERSION, getShortTermMarkets } from "./polymarket.js";
import { ANALYSIS_STRATEGY_VERSION, getAnalyzedEvents, getAnalyzedEventById, getAnalysisLogs } from "./storage.js";
import { resolveAnalyzedEvent } from "./resolution.js";
import { getBinanceWsStatus } from "./binance_ws.js";
import { runWithAiLanguage } from "./qwen.js";
import { getSnifferWsStatus, getSnifferEventCounters, getSnifferState, setSnifferState, getSnifferStartTime, getRecentWhales, getTrendingMarkets, getTrackerConfig, setTrackerConfig } from "./sniffer.js";
import { getBlockchainTrackerHealth } from "./blockchain-tracker.js";
import { assertSecureWebBinding, getSecurityHeaders, normalizeWalletAddress, resolvePublicPath, validateMutationRequest, validateRequestHost } from "./web-security.js";

export const DEFAULT_SERVER_CLOSE_DEADLINE_MS = 4500;
export const DEFAULT_SAFE_EXIT_DEADLINE_MS = 5000;
export const DEFAULT_COLLECTOR_DRAIN_DEADLINE_MS = 5000;

const shortSnapshotRequestTimes = new Map();
let shortSnapshotInFlight = 0;
const MAX_SHORT_SNAPSHOT_CONCURRENCY = 3;
const MAX_SHORT_SNAPSHOT_REQUESTS_PER_10S = 30;

const sseClients = new Set();
const MAX_SSE_CLIENTS = 50;
const SSE_HEARTBEAT_MS = 30000;

/**
 * Open an SSE stream with a heartbeat and a hard cap on concurrent clients.
 * Returns null when the stream cannot be opened (too many clients).
 */
function openSseStream(req, res, { onClose } = {}) {
  if (sseClients.size >= MAX_SSE_CLIENTS) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Too many streaming clients");
    return null;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      sseClients.delete(res);
      return;
    }
    res.write(`: heartbeat\n\n`);
  }, SSE_HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    onClose?.();
  });
  return res;
}

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

function validateShortSnapshotRequest(req) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (shortSnapshotRequestTimes.get(key) || []).filter(timestamp => timestamp > now - 10_000);
  if (recent.length >= MAX_SHORT_SNAPSHOT_REQUESTS_PER_10S) {
    throw Object.assign(new Error("Snapshot request rate exceeded"), { status: 429 });
  }
  recent.push(now);
  shortSnapshotRequestTimes.set(key, recent);
  if (shortSnapshotInFlight >= MAX_SHORT_SNAPSHOT_CONCURRENCY) {
    throw Object.assign(new Error("Snapshot scanner is at capacity"), { status: 429 });
  }
  shortSnapshotInFlight += 1;
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
  if (typeof answer === "string") return { text: answer, options: {}, result: null };
  return {
    text: answer?.text || "",
    options: answer?.options || {},
    result: answer?.result || null,
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
    if (size > 1024 * 1024) {
      throw Object.assign(new Error("Request terlalu besar."), { status: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
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
    if (normalized.result?.type !== "analysis_queue") {
      pushMessage(messages, normalized.text, normalized.options);
    }

    sendJson(res, 200, {
      ok: true,
      command: commandText,
      version: SEARCH_ENGINE_VERSION,
      ...qwenHealth(),
      ...rateLimitHealth(),
      messages,
      result: normalized.result,
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
  const filePath = resolvePublicPath(publicDir, requestUrl.pathname);

  if (!filePath) {
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

// Brute-force protection for Basic auth (shared across all requests in this process).
const AUTH_FAIL_WINDOW_MS = 10 * 60 * 1000;
const AUTH_MAX_FAILS = 20;
const authFailures = new Map();

function authRateLimited(key) {
  const now = Date.now();
  const state = authFailures.get(key);
  if (!state || now - state.windowStart > AUTH_FAIL_WINDOW_MS) {
    authFailures.delete(key);
    return false;
  }
  return state.count >= AUTH_MAX_FAILS;
}

function recordAuthFailure(key) {
  const now = Date.now();
  const state = authFailures.get(key);
  if (!state || now - state.windowStart > AUTH_FAIL_WINDOW_MS) {
    authFailures.set(key, { windowStart: now, count: 1 });
  } else {
    state.count += 1;
  }
  if (authFailures.size > 1000) {
    for (const [address, value] of authFailures) {
      if (now - value.windowStart > AUTH_FAIL_WINDOW_MS) authFailures.delete(address);
    }
  }
}

function timingSafeEqualStrings(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    // Burn comparable time before returning false (length leak is acceptable).
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function checkAuth(req, res) {
  if (!config.webPassword) return true;
  const remoteAddress = req.socket.remoteAddress || "unknown";

  const auth = req.headers.authorization;
  if (!auth) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Spectre Terminal"',
      "content-type": "text/plain; charset=utf-8"
    });
    res.end("Unauthorized");
    return false;
  }

  if (authRateLimited(remoteAddress)) {
    res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
    res.end("Too many failed attempts");
    return false;
  }

  const b64auth = (auth.split(' ')[1] || '');
  const decoded = Buffer.from(b64auth, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) {
    recordAuthFailure(remoteAddress);
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Spectre Terminal"',
      "content-type": "text/plain; charset=utf-8"
    });
    res.end("Unauthorized");
    return false;
  }
  const password = decoded.slice(separator + 1);

  const ok = timingSafeEqualStrings(password, config.webPassword);
  if (ok) {
    authFailures.delete(remoteAddress);
    return true;
  }

  recordAuthFailure(remoteAddress);
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Spectre Terminal"',
    "content-type": "text/plain; charset=utf-8"
  });
  res.end("Unauthorized");
  return false;
}

export function startWebServer(options = {}) {
  const webPort = Number(options.port || port);
  const webHost = options.host || host;
  assertSecureWebBinding(webHost, config.webPassword);

  const server = http.createServer(async (req, res) => {
    try {
      for (const [name, value] of Object.entries(getSecurityHeaders())) {
        res.setHeader(name, value);
      }
      validateRequestHost(req, webHost);
      if (!checkAuth(req, res)) return;
      validateMutationRequest(req);

      if (req.method === "GET" && req.url === "/api/health") {
        const { checkAiProviderConnection, getTotalAITokensUsed } = await import('./qwen.js');
        const providerConnection = await checkAiProviderConnection();
        sendJson(res, 200, {
          ok: true,
          qwen: qwenHealth(),
          providerConnection,
          engine: SEARCH_ENGINE_VERSION,
          cooldown: getCooldownState(),
          totalAITokensUsed: getTotalAITokensUsed()
        });
        return;
      }

      if (req.method === "GET" && req.url === "/api/ws-status") {
        const snifferHealth = getSnifferWsStatus();
        sendJson(res, 200, {
          sniffer: snifferHealth.state,
          binance: getBinanceWsStatus(),
          snifferHealth,
          snifferCounters: getSnifferEventCounters(),
          polygon: getBlockchainTrackerHealth(),
        });
        return;
      }
      
      if (req.method === "GET" && req.url === "/api/live-prices") {
        const stream = openSseStream(req, res);
        if (!stream) return;
        
        let lastSent = {};
        // Initial full snapshot so late-joining clients get the whole board.
        stream.write(`data: ${JSON.stringify(global.livePrices || {})}\n\n`);
        lastSent = { ...(global.livePrices || {}) };
        
        const intervalId = setInterval(() => {
          if (stream.writableEnded || stream.destroyed) {
            clearInterval(intervalId);
            return;
          }
          const current = global.livePrices || {};
          const delta = {};
          for (const [assetId, price] of Object.entries(current)) {
            if (lastSent[assetId] !== price) delta[assetId] = price;
          }
          for (const assetId of Object.keys(lastSent)) {
            if (!(assetId in current)) delta[assetId] = null;
          }
          if (Object.keys(delta).length) {
            stream.write(`data: ${JSON.stringify(delta)}\n\n`);
            lastSent = { ...current };
          }
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
          sendJson(res, 200, { ok: true, stats });
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


      if (req.method === "POST" && req.url === "/api/command") {
        await handleApiCommand(req, res);
        return;
      }

      if (req.method === "POST" && req.url === "/api/short-entry-snapshot") {
        let slotAcquired = false;
        try {
          validateShortSnapshotRequest(req);
          slotAcquired = true;
          const body = await readBody(req);
          const marketId = String(body.marketId || "").trim();
          if (!/^\d{1,30}$/.test(marketId)) {
            sendJson(res, 400, { ok: false, error: "marketId tidak valid." });
            return;
          }
          const snapshot = await getFastShortEntrySnapshot(marketId, AbortSignal.timeout(6_000));
          sendJson(res, 200, { ok: true, snapshot });
        } catch (error) {
          sendJson(res, error.status || 422, { ok: false, error: error.message || String(error) });
        } finally {
          if (slotAcquired) shortSnapshotInFlight = Math.max(0, shortSnapshotInFlight - 1);
        }
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
          sendJson(res, 200, { ok: true, events, strategyVersion: ANALYSIS_STRATEGY_VERSION });
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
          const result = await resolveAnalyzedEvent(storedEvent);
          sendJson(res, result.status === 404 ? 404 : 200, result);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: "Failed to check market status: " + error.message });
        }
        return;
      }

      if (req.url === "/api/sniffer-status" && req.method === "GET") {
        return sendJson(res, 200, {
          isSnifferActive: getSnifferState(),
          startTime: getSnifferStartTime(),
          health: getSnifferWsStatus(),
        });
      }

      if (req.url === "/api/sniffer-whales" && req.method === "GET") {
        const whales = getRecentWhales(0); // Defer to sniffer config limit
        const trending = getTrendingMarkets(5); // Top 5 trending markets
        
        // Dynamic import to avoid circular dependency issues if any
        const { getAccumulatedWhaleVolume, getTimeframeFilter } = await import('./sniffer.js');

        return sendJson(res, 200, {
          isSnifferActive: getSnifferState(),
          startTime: getSnifferStartTime(),
          whales: whales,
          trending: trending,
          accumulatedWhaleVolume: getAccumulatedWhaleVolume(),
          timeframeFilter: getTimeframeFilter(),
          health: getSnifferWsStatus(),
          counters: getSnifferEventCounters(),
          polygonHealth: getBlockchainTrackerHealth(),
        });
      }

      if (req.url === "/api/sniffer-toggle" && req.method === "POST") {
        const body = await readBody(req);
        const newState = await setSnifferState(body.active);
        return sendJson(res, 200, {
          isSnifferActive: newState,
          startTime: getSnifferStartTime(),
          health: getSnifferWsStatus(),
        });
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
        const address = normalizeWalletAddress(req.url.replace("/api/wallet-profile/", "").split('?')[0]);
        if (!address) return sendJson(res, 400, { error: "Invalid wallet address" });
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
            fetchWithRetry(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(address)}&limit=1000`).catch(() => []),
            fetchWithRetry(`https://data-api.polymarket.com/trades?user=${encodeURIComponent(address)}&limit=50`).catch(() => []),
            fetchWithRetry(`https://lb-api.polymarket.com/profit?address=${encodeURIComponent(address)}&window=all`).catch(() => [])
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
        } catch (error) {
          console.error("Wallet profile request failed:", error);
          return sendJson(res, 502, { error: "Wallet profile provider unavailable" });
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
      const status = Number(error.status) || 500;
      if (status >= 500) console.error("Web request failed:", error);
      sendJson(res, status, { ok: false, error: status >= 500 ? "Internal server error" : error.message });
    }
  });

  server.listen(webPort, webHost, () => {
    console.log(`Web UI running at http://${webHost}:${webPort}`);
  });

  return server;
}

function onceAfterListening(server, callback) {
  if (server.listening) {
    queueMicrotask(callback);
    return;
  }
  server.once("listening", callback);
}

function closeWebServer(server, deadlineMs = 5000) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let deadline = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (deadline != null) clearTimeout(deadline);
      resolve();
    };
    const forceClose = () => {
      try { server.closeAllConnections?.(); } catch (error) { console.error("[WEB SERVER CLOSE]:", error?.message || error); }
      try { server.closeIdleConnections?.(); } catch (error) { console.error("[WEB SERVER CLOSE]:", error?.message || error); }
      finish();
    };
    deadline = setTimeout(forceClose, Math.max(0, deadlineMs));
    try { server.close(finish); } catch { finish(); }
  });
}

export function startWebRuntime(dependencies = {}) {
  const createServer = dependencies.startWebServer || startWebServer;
  const startCollector = dependencies.startCollector || startBtc15mObserveCollector;
  const stopCollector = dependencies.stopCollector || stopBtc15mObserveCollector;
  const collectorEnabled = dependencies.collectorEnabled ?? config.shortObserverBtc15mEnabled;
  const processObject = dependencies.process || process;
  const exit = dependencies.exit || ((code) => processObject.exit(code));
  const serverCloseDeadlineMs = dependencies.serverCloseDeadlineMs ?? DEFAULT_SERVER_CLOSE_DEADLINE_MS;
  const safeExitDeadlineMs = dependencies.safeExitDeadlineMs ?? DEFAULT_SAFE_EXIT_DEADLINE_MS;
  const collectorDrainDeadlineMs = dependencies.collectorDrainDeadlineMs ?? DEFAULT_COLLECTOR_DRAIN_DEADLINE_MS;
  const server = createServer(dependencies.serverOptions || {});
  let shuttingDown = false;
  let shutdownPromise = null;
  let collectorStartCalled = false;
  let collectorStartInvoked = false;
  let collectorStartPromise = null;

  onceAfterListening(server, () => {
    if (shuttingDown || collectorStartCalled || !collectorEnabled) return;
    collectorStartCalled = true;
    collectorStartPromise = Promise.resolve()
      .then(async () => {
        if (shuttingDown) return false;
        collectorStartInvoked = true;
        await startCollector();
        return true;
      })
      .catch((error) => console.error("[Short observer] Startup error:", error?.message || error));
  });

  async function shutdown(exitCode = 0) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      const code = typeof exitCode === "number" ? exitCode : 0;
      if (collectorStartCalled) {
        const lifecycle = [collectorStartPromise || Promise.resolve(false)];
        if (collectorStartInvoked) {
          lifecycle.push(Promise.resolve().then(() => stopCollector()).catch((error) => {
            console.error("[Short observer] Shutdown error:", error?.message || error);
          }));
        }
        let drainTimer = null;
        await Promise.race([
          Promise.all(lifecycle),
          new Promise((resolve) => { drainTimer = setTimeout(resolve, Math.max(0, collectorDrainDeadlineMs)); }),
        ]);
        if (drainTimer != null) clearTimeout(drainTimer);
      }
      const safeExit = setTimeout(() => exit(code), Math.max(0, safeExitDeadlineMs));
      safeExit.unref?.();
      try {
        await closeWebServer(server, serverCloseDeadlineMs);
      } finally {
        clearTimeout(safeExit);
      }
      exit(code);
    })();
    return shutdownPromise;
  }

  if (dependencies.installSignals !== false) {
    processObject.on("SIGINT", shutdown);
    processObject.on("SIGTERM", shutdown);
  }
  server.on("error", (error) => {
    console.error("[WEB SERVER FATAL]:", error?.message || error);
    void shutdown(1);
  });
  return { server, shutdown };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === modulePath;

if (isMainModule) {
  startWebRuntime();
}
