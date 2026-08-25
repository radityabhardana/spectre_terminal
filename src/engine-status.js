import { config } from "./config.js";
import { checkAiProviderConnection } from "./qwen.js";
import { getProviderStatuses } from "./provider-status.js";

const ENGINE_TIMEOUT_MS = 5_000;
const ENGINE_CACHE_TTL_MS = Object.freeze({ gamma: 10_000, clob: 10_000, qwen: 30_000 });
const ENGINE_FAILURE_RETRY_TTL_MS = 5_000;
const ENGINE_STATE = new Map();

const ENGINES = Object.freeze([
  { id: "gamma", name: "gamma", label: "Gamma" },
  { id: "clob", name: "clob", label: "CLOB" },
  { id: "qwen", name: "qwen", label: "Qwen" },
  { id: "local", name: "local", label: "Local" },
  { id: "binance", name: "binance", label: "Binance" },
]);

function configuredBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function baseStatus(engine, configured) {
  return {
    id: engine.id,
    name: engine.name,
    label: engine.label,
    configured,
    reachable: configured ? null : false,
    status: configured ? "checking" : "unconfigured",
    latencyMs: null,
    error: null,
  };
}

function httpError(status) {
  const numericStatus = Number(status);
  return Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? `HTTP ${numericStatus}`
    : "HTTP error";
}

function safeNetworkError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request timed out";
  return "request failed";
}

function remoteUrl(engine) {
  const base = configuredBaseUrl(engine.id === "gamma" ? config.gammaUrl : config.clobUrl);
  if (!base) return null;

  base.search = "";
  base.hash = "";
  if (engine.id === "gamma") {
    const url = new URL("/events", base);
    url.searchParams.set("limit", "1");
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    return url.toString();
  }
  return new URL("/time", base).toString();
}

async function checkRemote(engine) {
  const url = remoteUrl(engine);
  if (!url) return { kind: "configuration", status: baseStatus(engine, false) };
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "spectre-terminal-engine-health/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS),
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    try {
      await response.body?.cancel();
    } catch {
      // Never inspect or retain upstream response bodies for health status.
    }
    if (!response.ok) {
      return {
        kind: "http",
        status: {
          ...baseStatus(engine, true),
          reachable: true,
          status: Number(response.status) === 429 ? "rate_limited" : "degraded",
          latencyMs,
          error: httpError(response.status),
        },
      };
    }
    return {
      kind: "success",
      status: { ...baseStatus(engine, true), reachable: true, status: "connected", latencyMs, error: null },
    };
  } catch (error) {
    return {
      kind: "transient",
      status: {
        ...baseStatus(engine, true),
        reachable: false,
        status: "disconnected",
        latencyMs: Math.max(0, Date.now() - startedAt),
        error: safeNetworkError(error),
      },
    };
  }
}

function qwenStatus(engine, connection, latencyMs) {
  if (!connection?.configured) return { kind: "configuration", status: baseStatus(engine, false) };
  const statusCode = Number(connection.status);
  if (connection.reachable === true) {
    return {
      kind: "success",
      status: { ...baseStatus(engine, true), reachable: true, status: "connected", latencyMs, error: null },
    };
  }
  if (Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) {
    return {
      kind: "http",
      status: {
        ...baseStatus(engine, true),
        reachable: true,
        status: statusCode === 429 ? "rate_limited" : "degraded",
        latencyMs,
        error: httpError(statusCode),
      },
    };
  }
  return {
    kind: "transient",
    status: {
      ...baseStatus(engine, true),
      reachable: false,
      status: "disconnected",
      latencyMs,
      error: connection.error === "timeout" ? "request timed out" : "request failed",
    },
  };
}

async function checkQwen(engine) {
  const startedAt = Date.now();
  try {
    const connection = await checkAiProviderConnection();
    return qwenStatus(engine, connection, Math.max(0, Date.now() - startedAt));
  } catch (error) {
    return {
      kind: "transient",
      status: { ...baseStatus(engine, true), reachable: false, status: "disconnected", latencyMs: Math.max(0, Date.now() - startedAt), error: safeNetworkError(error) },
    };
  }
}

function cloneStatus(status) {
  return { ...status };
}

function engineConfigured(engine) {
  if (engine.id === "gamma" || engine.id === "clob") return Boolean(remoteUrl(engine));
  if (engine.id === "qwen") return Boolean(config.omniApiKey && config.omniRouteBaseUrl);
  return true;
}

function checkEngine(engine) {
  if (engine.id === "gamma" || engine.id === "clob") return checkRemote(engine);
  return checkQwen(engine);
}

function recordTransientFailure(engine, state, failureStatus) {
  if (state.lastSuccess && !state.preservedLastSuccess) {
    state.cached = { status: cloneStatus(state.lastSuccess), expiresAt: Date.now() + ENGINE_FAILURE_RETRY_TTL_MS };
    state.preservedLastSuccess = true;
    return;
  }
  state.cached = {
    status: failureStatus || { ...baseStatus(engine, true), reachable: false, status: "disconnected", error: "request failed" },
    expiresAt: Date.now() + ENGINE_FAILURE_RETRY_TTL_MS,
  };
}

function startEngineRefresh(engine, state) {
  if (state.inFlight) return state.inFlight;
  const request = checkEngine(engine)
    .then((result) => {
      if (result.kind === "success") {
        state.lastSuccess = cloneStatus(result.status);
        state.preservedLastSuccess = false;
        state.cached = { status: result.status, expiresAt: Date.now() + ENGINE_CACHE_TTL_MS[engine.id] };
      } else if (result.kind === "http") {
        state.preservedLastSuccess = false;
        state.cached = { status: result.status, expiresAt: Date.now() + ENGINE_CACHE_TTL_MS[engine.id] };
      } else if (result.kind === "transient") {
        recordTransientFailure(engine, state, result.status);
      } else {
        state.cached = { status: result.status, expiresAt: Number.POSITIVE_INFINITY };
      }
    })
    .catch(() => recordTransientFailure(engine, state))
    .finally(() => {
      if (state.inFlight === request) state.inFlight = null;
    });
  state.inFlight = request;
  return request;
}

function getLocalStatus() {
  const engine = ENGINES[3];
  return { ...baseStatus(engine, true), reachable: true, status: "connected", latencyMs: 0, error: null };
}

function getEngineStatus(engine) {
  if (engine.id === "local") return getLocalStatus();
  let state = ENGINE_STATE.get(engine.id);
  if (!state) {
    state = { cached: null, inFlight: null, lastSuccess: null, preservedLastSuccess: false };
    ENGINE_STATE.set(engine.id, state);
  }
  if (!state.cached) {
    const configured = engineConfigured(engine);
    const placeholder = baseStatus(engine, configured);
    state.cached = { status: placeholder, expiresAt: configured ? 0 : Number.POSITIVE_INFINITY };
    if (configured) void startEngineRefresh(engine, state);
    return cloneStatus(placeholder);
  }
  if (state.cached.expiresAt <= Date.now()) void startEngineRefresh(engine, state);
  return cloneStatus(state.cached.status);
}

export function getEngineStatuses() {
  const providerMap = new Map();
  try {
    for (const status of getProviderStatuses()) providerMap.set(status.name, status);
  } catch {
    // Provider status failures are isolated from the other engine entries.
  }
  return ENGINES.map((engine) => {
    const provider = providerMap.get(engine.id);
    if (!provider) return getEngineStatus(engine);
    return { id: engine.id, name: engine.name, label: engine.label, configured: provider.configured, reachable: provider.reachable, status: provider.status, latencyMs: provider.latencyMs, error: provider.error };
  });
}
