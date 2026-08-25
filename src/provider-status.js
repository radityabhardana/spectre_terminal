import { config } from "./config.js";

const PROVIDER_STATUS_TIMEOUT_MS = 10_000;
const PROVIDER_STATUS_CACHE_TTL_MS = 10_000;
const PROVIDER_FAILURE_RETRY_TTL_MS = 5_000;
const providerStatusState = new Map();

const PROVIDERS = Object.freeze([
  { name: "binance", label: "Binance" },
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

function providerUrl(provider) {
  const base = configuredBaseUrl(provider.name === "binance" ? config.binanceBaseUrl : "");
  return base ? new URL("/api/v3/ping", base).toString() : null;
}

function configuredStatus(provider, configured) {
  return {
    name: provider.name,
    label: provider.label,
    configured,
    reachable: configured ? null : false,
    status: configured ? "checking" : "unconfigured",
    latencyMs: null,
    error: null,
  };
}

function errorMessage(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "request timed out";
  return "request failed";
}

function httpError(status) {
  const numericStatus = Number(status);
  return Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? `HTTP ${numericStatus}`
    : "HTTP error";
}

async function checkProvider(provider) {
  const url = providerUrl(provider);
  if (!url) return { status: configuredStatus(provider, false), kind: "configuration" };
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "spectre-terminal-provider-health/1.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(PROVIDER_STATUS_TIMEOUT_MS),
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    try {
      await response.body?.cancel();
    } catch {
      // Health checks never need to inspect or retain an upstream response body.
    }
    if (!response.ok) {
      return {
        kind: "http",
        status: {
          ...configuredStatus(provider, true),
          reachable: true,
          status: Number(response.status) === 429 ? "rate_limited" : "degraded",
          latencyMs,
          error: httpError(response.status),
        },
      };
    }
    return {
      kind: "success",
      status: { ...configuredStatus(provider, true), reachable: true, status: "connected", latencyMs, error: null },
    };
  } catch (error) {
    return {
      kind: "transient",
      status: {
        ...configuredStatus(provider, true),
        reachable: false,
        status: "disconnected",
        latencyMs: Math.max(0, Date.now() - startedAt),
        error: errorMessage(error),
      },
    };
  }
}

function cloneStatus(status) {
  return { ...status };
}

function recordTransientFailure(provider, state, failureStatus) {
  if (state.lastSuccess && !state.preservedLastSuccess) {
    state.cached = {
      status: cloneStatus(state.lastSuccess),
      expiresAt: Date.now() + PROVIDER_FAILURE_RETRY_TTL_MS,
    };
    state.preservedLastSuccess = true;
    return;
  }
  state.cached = {
    status: failureStatus || { ...configuredStatus(provider, true), reachable: false, status: "disconnected", error: "request failed" },
    expiresAt: Date.now() + PROVIDER_FAILURE_RETRY_TTL_MS,
  };
}

function startProviderRefresh(provider, state) {
  if (state.inFlight) return state.inFlight;
  const request = checkProvider(provider)
    .then((result) => {
      if (result.kind === "success") {
        state.lastSuccess = cloneStatus(result.status);
        state.preservedLastSuccess = false;
        state.cached = { status: result.status, expiresAt: Date.now() + PROVIDER_STATUS_CACHE_TTL_MS };
      } else if (result.kind === "http") {
        state.preservedLastSuccess = false;
        state.cached = { status: result.status, expiresAt: Date.now() + PROVIDER_STATUS_CACHE_TTL_MS };
      } else if (result.kind === "transient") {
        recordTransientFailure(provider, state, result.status);
      } else {
        state.cached = { status: result.status, expiresAt: Number.POSITIVE_INFINITY };
      }
    })
    .catch(() => recordTransientFailure(provider, state))
    .finally(() => {
      if (state.inFlight === request) state.inFlight = null;
    });
  state.inFlight = request;
  return request;
}

function getProviderStatus(provider) {
  let state = providerStatusState.get(provider.name);
  if (!state) {
    state = { cached: null, inFlight: null, lastSuccess: null, preservedLastSuccess: false };
    providerStatusState.set(provider.name, state);
  }
  if (!state.cached) {
    const configured = Boolean(providerUrl(provider));
    const placeholder = configuredStatus(provider, configured);
    state.cached = { status: placeholder, expiresAt: configured ? 0 : Number.POSITIVE_INFINITY };
    if (configured) void startProviderRefresh(provider, state);
    return cloneStatus(placeholder);
  }
  if (state.cached.expiresAt <= Date.now()) void startProviderRefresh(provider, state);
  return cloneStatus(state.cached.status);
}

export function getProviderStatuses() {
  return PROVIDERS.map(getProviderStatus);
}

export function resetProviderStatusCache() {
  providerStatusState.clear();
}
