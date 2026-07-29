export const DEFAULT_ENTRY_SCANNER_CONFIG = Object.freeze({
  scanStartSeconds: 240,
  scanStopSeconds: 120,
  minFairProbability: 60,
  minNetEvCents: 8,
  maxAsk: 0.65,
  confirmations: 2,
  oracleMaxAgeMs: 15_000,
  signalTtlMs: 10_000,
});

function scannerConfig(overrides = {}) {
  return { ...DEFAULT_ENTRY_SCANNER_CONFIG, ...overrides };
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function qualifyEntrySnapshot(snapshot, overrides = {}) {
  const config = scannerConfig(overrides);
  const remainingSeconds = finite(snapshot?.remainingSeconds);
  if (remainingSeconds == null || remainingSeconds <= config.scanStopSeconds) {
    return { qualified: false, status: "expired", reason: "Scan window has ended." };
  }
  if (remainingSeconds > config.scanStartSeconds) {
    return { qualified: false, status: "waiting", reason: "Scan window has not started." };
  }
  if (snapshot?.marketActive !== true || snapshot?.acceptingOrders !== true) {
    return { qualified: false, status: "watching", reason: "Market is not executable." };
  }
  const oracleAgeMs = finite(snapshot?.oracleAgeMs);
  if (oracleAgeMs == null || oracleAgeMs < 0 || oracleAgeMs > config.oracleMaxAgeMs) {
    return { qualified: false, status: "watching", reason: "Oracle data is stale." };
  }

  const feeBufferCents = finite(snapshot?.feeBufferCents) ?? 0;
  const candidates = Object.entries(snapshot?.sides || {}).map(([direction, side]) => {
    const fairProbability = finite(side?.fairProbability);
    const ask = finite(side?.ask);
    const netEvCents = finite(side?.netEvCents);
    if (fairProbability == null || ask == null || netEvCents == null) return null;
    if (fairProbability < config.minFairProbability || ask <= 0 || ask > config.maxAsk || netEvCents < config.minNetEvCents) return null;
    const maxEntryPrice = Math.min(
      config.maxAsk,
      (fairProbability - config.minNetEvCents - feeBufferCents) / 100
    );
    if (maxEntryPrice < ask) return null;
    return { direction, fairProbability, ask, netEvCents, maxEntryPrice: Number(maxEntryPrice.toFixed(4)) };
  }).filter(Boolean).sort((a, b) => b.netEvCents - a.netEvCents || b.fairProbability - a.fairProbability);

  if (!candidates.length) {
    return { qualified: false, status: "watching", reason: "No side meets price and EV thresholds." };
  }
  return { qualified: true, status: "candidate", ...candidates[0] };
}

export function advanceEntryScannerState(previous = {}, snapshot, overrides = {}) {
  const config = scannerConfig(overrides);
  if (snapshot?.error) {
    const observedAt = Date.parse(snapshot.capturedAt || "");
    if (previous.status === "entry" && Number.isFinite(observedAt) && observedAt > previous.signal.expiresAt) {
      return {
        ...previous,
        status: "no_chase",
        degraded: true,
        lastError: String(snapshot.error),
        reason: "Entry signal expired while quote revalidation was unavailable.",
      };
    }
    return { ...previous, degraded: true, lastError: String(snapshot.error) };
  }

  if (previous.status === "entry") {
    const qualification = qualifyEntrySnapshot(snapshot, {
      ...config,
      scanStartSeconds: Number.MAX_SAFE_INTEGER,
      scanStopSeconds: -1,
    });
    const capturedAt = Date.parse(snapshot?.capturedAt || "");
    const expired = Number.isFinite(capturedAt) && capturedAt > previous.signal.expiresAt;
    const side = snapshot?.sides?.[previous.signal.direction];
    const ask = finite(side?.ask);
    const lostEdge = !qualification.qualified
      || qualification.direction !== previous.signal.direction
      || ask == null
      || ask > previous.signal.maxEntryPrice;
    if (expired || lostEdge) {
      return {
        ...previous,
        status: "no_chase",
        latestSnapshot: snapshot,
        reason: expired ? "Entry signal expired." : "Price moved beyond the edge-preserving entry cap.",
      };
    }
    return { ...previous, latestSnapshot: snapshot, degraded: false };
  }
  if (previous.status === "no_chase" || previous.status === "skipped") return previous;

  const qualification = qualifyEntrySnapshot(snapshot, config);
  if (qualification.status === "expired") {
    return { ...previous, status: "skipped", latestSnapshot: snapshot, reason: "No valid edge before scan window ended." };
  }
  if (!qualification.qualified) {
    return {
      status: qualification.status,
      candidateDirection: null,
      confirmationCount: 0,
      latestSnapshot: snapshot,
      reason: qualification.reason,
      degraded: false,
    };
  }

  const sameDirection = previous.candidateDirection === qualification.direction;
  const confirmationCount = sameDirection ? Number(previous.confirmationCount || 0) + 1 : 1;
  const next = {
    status: confirmationCount >= config.confirmations ? "entry" : "candidate",
    candidateDirection: qualification.direction,
    confirmationCount,
    latestSnapshot: snapshot,
    candidate: qualification,
    reason: null,
    degraded: false,
  };
  if (next.status === "entry") {
    const capturedAt = Date.parse(snapshot.capturedAt);
    next.signal = {
      ...qualification,
      capturedAt: snapshot.capturedAt,
      remainingSeconds: snapshot.remainingSeconds,
      expiresAt: (Number.isFinite(capturedAt) ? capturedAt : Date.now()) + config.signalTtlMs,
    };
  }
  return next;
}
