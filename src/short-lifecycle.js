// Shared short-market lifecycle/timing definitions.
// Used by the backend snapshot pipeline (src/web.js) and the UI scanner (public/app.js via fetch payload).
// Times are seconds remaining before market close.

export const SHORT_MARKET_PHASES = Object.freeze([
  "OBSERVATION",
  "ANALYSIS",
  "ENTRY_WINDOW",
  "EXPIRED",
]);

export const SHORT_LIFECYCLE_DEFAULTS = Object.freeze({
  "5m": {
    observationSeconds: 300,
    firstSnapshotSeconds: 260,
    analysisStartSeconds: 240,
    analysisStopSeconds: 225,
    targetFinalSeconds: 180,
    analysisMinDataPoints: 1,
    completedCooldownSeconds: 60,
    minAnalysisRemainingSeconds: 170,
  },
  "15m": {
    observationSeconds: 900,
    firstSnapshotSeconds: 780,
    analysisStartSeconds: 720,
    analysisStopSeconds: 660,
    targetFinalSeconds: 600,
    analysisMinDataPoints: 2,
    completedCooldownSeconds: 300,
    minAnalysisRemainingSeconds: 600,
  },
  "1h": {
    observationSeconds: 3600,
    firstSnapshotSeconds: 3120,
    analysisStartSeconds: 2880,
    analysisStopSeconds: 2640,
    targetFinalSeconds: 2400,
    analysisMinDataPoints: 2,
    completedCooldownSeconds: 1200,
    minAnalysisRemainingSeconds: 1800,
  },
  "4h": {
    observationSeconds: 14400,
    firstSnapshotSeconds: 12480,
    analysisStartSeconds: 11520,
    analysisStopSeconds: 10560,
    targetFinalSeconds: 9600,
    analysisMinDataPoints: 3,
    completedCooldownSeconds: 3600,
    minAnalysisRemainingSeconds: 7200,
  },
  "1d": {
    observationSeconds: 86400,
    firstSnapshotSeconds: 74880,
    analysisStartSeconds: 69120,
    analysisStopSeconds: 63360,
    targetFinalSeconds: 57600,
    analysisMinDataPoints: 3,
    completedCooldownSeconds: 7200,
    minAnalysisRemainingSeconds: 21600,
  },
});

export function shortLifecycleProfile(durationType) {
  return SHORT_LIFECYCLE_DEFAULTS[durationType] || null;
}

function finiteNumber(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function resolveShortLifecyclePhase({ durationType, remainingSeconds, endTimeMs, nowMs = Date.now() } = {}) {
  const profile = shortLifecycleProfile(durationType);
  const remaining = finiteNumber(remainingSeconds);
  if (profile == null || remaining == null) return { phase: "UNKNOWN", profile };
  const resolvedRemaining = remaining ?? null;
  if (resolvedRemaining == null) return { phase: "UNKNOWN", profile };
  if (resolvedRemaining <= 0) return { phase: "EXPIRED", profile };
  const seconds = resolvedRemaining;
  if (seconds > profile.observationSeconds) return { phase: "OBSERVATION", profile };
  if (seconds > profile.analysisStartSeconds) return { phase: "OBSERVATION", profile };
  if (seconds >= profile.analysisStopSeconds) return { phase: "ANALYSIS", profile };
  if (seconds >= profile.targetFinalSeconds) return { phase: "ENTRY_WINDOW", profile };
  return { phase: "ENTRY_WINDOW", profile };
}

export function shouldRunAiAnalysis({ durationType, remainingSeconds, marketClosed, marketActive, acceptingOrders, hasAnalysisSnapshot, analysisInFlight, nowMs = Date.now() } = {}) {
  const profile = shortLifecycleProfile(durationType);
  if (!profile) return { ok: false, reason: "unsupported_duration" };
  if (marketClosed || !marketActive || !acceptingOrders) return { ok: false, reason: "market_closed" };
  if (analysisInFlight) return { ok: false, reason: "analysis_in_flight" };
  if (hasAnalysisSnapshot) return { ok: false, reason: "already_analyzed" };
  const remaining = finiteNumber(remainingSeconds);
  if (remaining == null) return { ok: false, reason: "missing_remaining" };
  if (remaining <= 0) return { ok: false, reason: "expired" };
  if (remaining <= profile.minAnalysisRemainingSeconds) return { ok: false, reason: "insufficient_time" };
  if (remaining > profile.analysisStartSeconds) return { ok: false, reason: "analysis_not_open" };
  if (remaining < profile.analysisStopSeconds) return { ok: false, reason: "analysis_window_closed" };
  return { ok: true, reason: "ok" };
}

export function nextShortLifecyclePollMs({ durationType, remainingSeconds } = {}) {
  const profile = shortLifecycleProfile(durationType);
  if (!profile) return null;
  const remaining = finiteNumber(remainingSeconds);
  if (remaining == null) return null;
  if (remaining <= 0) return null;
  if (remaining > profile.analysisStartSeconds) {
    return Math.max(1_000, (remaining - profile.analysisStartSeconds) * 1000);
  }
  return 5_000;
}
