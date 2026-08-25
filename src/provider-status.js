import { config } from "./config.js";

const PROVIDER_STATUS_TIMEOUT_MS = Object.freeze({
  binance: 10_000,
  gdelt: 25_000,
});
const PROVIDER_STATUS_CACHE_TTL_MS = Object.freeze({
  binance: 10_000,
  gdelt: 60_000,
});
const PROVIDER_FAILURE_RETRY_TTL_MS = Object.freeze({
  binance: 5_000,
  gdelt: 60_000,
});
const GDELT_RATE_LIMIT_RETRY_TTL_MS = 300_000;
const MAX_SAFE_RETRY_AFTER_MS = 3_600_000;
const GDELT_RECENT_SUCCESS_TTL_MS = 60_000;

const providerStatusState = new Map();

const PROVIDERS = Object.freeze([
  { name: "binance", label: "Binance" },
  { name: "gdelt", label: "GDELT" },
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

function providerUrl(name, baseUrl) {
  const url = configuredBaseUrl(baseUrl);
  if (!url) return null;

  if (name === "binance") {
    // Binance's unauthenticated ping is a small, stable health endpoint.
    return new URL("/api/v3/ping", url).toString();
  }

  // Keep the GDELT query fixed so this endpoint cannot become a proxy for
  // caller-supplied URLs or arbitrary upstream queries.
  url.search = "";
  url.hash = "";
  url.searchParams.set("query", "healthcheck");
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", "1");
  url.searchParams.set("timespan", "15min");
  url.searchParams.set("sort", "DateDesc");
  return url.toString();
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

function retryAfterMs(response) {
  const raw = response.headers?.get?.("retry-after");
  if (!raw) return null;
  const value = String(raw).trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (Number.isSafeInteger(seconds)) return Math.min(MAX_SAFE_RETRY_AFTER_MS, Math.max(1_000, seconds * 1_000));
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const delay = timestamp - Date.now();
  return Math.min(MAX_SAFE_RETRY_AFTER_MS, Math.max(1_000, delay));
}

async function checkProvider(provider) {
  const baseUrl = provider.name === "binance" ? config.binanceBaseUrl : config.gdeltDocUrl;
  const url = providerUrl(provider.name, baseUrl);
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
      signal: AbortSignal.timeout(PROVIDER_STATUS_TIMEOUT_MS[provider.name]),
    });
    const latencyMs = Math.max(0, Date.now() - startedAt);
    try {
      await response.body?.cancel();
    } catch {
      // Health checks never need to inspect or retain an upstream response body.
    }

    if (!response.ok) {
      const status = Number(response.status) === 429 ? "rate_limited" : "degraded";
      return {
        kind: "http",
        cacheTtlMs: provider.name === "gdelt" && Number(response.status) === 429
          ? (retryAfterMs(response) ?? GDELT_RATE_LIMIT_RETRY_TTL_MS)
          : PROVIDER_STATUS_CACHE_TTL_MS[provider.name],
        status: {
          ...configuredStatus(provider, true),
          reachable: true,
          status,
          latencyMs,
          error: httpError(response.status),
        },
      };
    }

    return {
      kind: "success",
      cacheTtlMs: PROVIDER_STATUS_CACHE_TTL_MS[provider.name],
      status: {
        ...configuredStatus(provider, true),
        reachable: true,
        status: "connected",
        latencyMs,
        error: null,
      },
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
  if (provider.name === "gdelt") {
    state.transientFailures += 1;
    const recentSuccess = Number.isFinite(state.lastSuccessAt)
      && Date.now() - state.lastSuccessAt < GDELT_RECENT_SUCCESS_TTL_MS;
    const disconnected = state.transientFailures >= 3 && !recentSuccess;
    state.cached = {
      status: {
        ...(failureStatus || configuredStatus(provider, true)),
        reachable: disconnected ? false : null,
        status: disconnected ? "disconnected" : "degraded",
        error: failureStatus?.error || "request failed",
      },
      expiresAt: Date.now() + PROVIDER_FAILURE_RETRY_TTL_MS.gdelt,
    };
    return;
  }
  if (state.lastSuccess && !state.preservedLastSuccess) {
    state.cached = {
      status: cloneStatus(state.lastSuccess),
      expiresAt: Date.now() + PROVIDER_FAILURE_RETRY_TTL_MS[provider.name],
    };
    state.preservedLastSuccess = true;
    return;
  }

  state.cached = {
    status: failureStatus || {
      ...configuredStatus(provider, true),
      reachable: false,
      status: "disconnected",
      error: "request failed",
    },
    expiresAt: Date.now() + PROVIDER_FAILURE_RETRY_TTL_MS[provider.name],
  };
}

function startProviderRefresh(provider, state) {
  if (state.inFlight) return state.inFlight;

  const request = checkProvider(provider)
    .then((result) => {
      if (result.kind === "success") {
        state.lastSuccess = cloneStatus(result.status);
        state.lastSuccessAt = Date.now();
        state.transientFailures = 0;
        state.preservedLastSuccess = false;
        state.cached = {
          status: result.status,
          expiresAt: Date.now() + result.cacheTtlMs,
        };
      } else if (result.kind === "http") {
        state.transientFailures = 0;
        state.preservedLastSuccess = false;
        state.cached = {
          status: result.status,
          expiresAt: Date.now() + result.cacheTtlMs,
        };
      } else if (result.kind === "transient") {
        recordTransientFailure(provider, state, result.status);
      } else {
        state.cached = { status: result.status, expiresAt: Number.POSITIVE_INFINITY };
      }
    })
    .catch(() => {
      // A provider check must never reject the aggregate status response.
      recordTransientFailure(provider, state);
    })
    .finally(() => {
      if (state.inFlight === request) state.inFlight = null;
    });

  state.inFlight = request;
  return request;
}

function getProviderStatus(provider) {
  let state = providerStatusState.get(provider.name);
  if (!state) {
    state = { cached: null, inFlight: null, lastSuccess: null, lastSuccessAt: 0, transientFailures: 0, preservedLastSuccess: false };
    providerStatusState.set(provider.name, state);
  }

  if (!state.cached) {
    const configured = Boolean(providerUrl(
      provider.name,
      provider.name === "binance" ? config.binanceBaseUrl : config.gdeltDocUrl
    ));
    const placeholder = configuredStatus(provider, configured);
    state.cached = { status: placeholder, expiresAt: configured ? 0 : Number.POSITIVE_INFINITY };
    if (configured) void startProviderRefresh(provider, state);
    return cloneStatus(placeholder);
  }

  if (state.cached.expiresAt <= Date.now()) void startProviderRefresh(provider, state);
  return cloneStatus(state.cached.status);
}

export function getProviderStatuses() {
  // Per-provider stale-while-revalidate keeps a slow upstream from delaying
  // the endpoint or a fresh result from another provider.
  return PROVIDERS.map(getProviderStatus);
}

export function resetProviderStatusCache() {
  providerStatusState.clear();
}
