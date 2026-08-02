export const DEFAULT_ENTRY_SCANNER_CONFIG = Object.freeze({
  scanStartSeconds: 300,
  scanStopSeconds: 150,
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
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function gate(id, actual, required, message) {
  return { id, actual, required, message };
}

function compareSides(a, b) {
  const aComplete = [a.fairProbability, a.ask, a.feeBufferCents, a.netEvCents].every((value) => value != null);
  const bComplete = [b.fairProbability, b.ask, b.feeBufferCents, b.netEvCents].every((value) => value != null);
  return Number(bComplete) - Number(aComplete)
    || (b.netEvCents ?? -Infinity) - (a.netEvCents ?? -Infinity)
    || (b.fairProbability ?? -Infinity) - (a.fairProbability ?? -Infinity)
    || (a.ask ?? Infinity) - (b.ask ?? Infinity)
    || String(a.direction).localeCompare(String(b.direction));
}

export function assessEntrySnapshot(snapshot, overrides = {}) {
  const config = scannerConfig(overrides);
  const remainingSeconds = finite(snapshot?.remainingSeconds);
  const remainingAvailable = remainingSeconds != null;
  const oracleAgeMs = finite(snapshot?.oracleAgeMs);
  const feeBufferCents = finite(snapshot?.feeBufferCents);
  const marketOpen = snapshot?.marketClosed !== true;
  const executable = snapshot?.marketActive === true && marketOpen && snapshot?.acceptingOrders === true;
  const backendAuthorityAvailable = typeof snapshot?.actionable === "boolean" && Array.isArray(snapshot?.blockers);
  const backendActionableBlocked = snapshot?.actionable === false;
  const backendBlockers = Array.isArray(snapshot?.blockers) ? snapshot.blockers.filter(Boolean) : [];
  const backendBlocked = backendActionableBlocked || backendBlockers.length > 0;
  const oracleAvailable = oracleAgeMs != null;
  const oracleFresh = oracleAvailable && oracleAgeMs >= 0 && oracleAgeMs <= config.oracleMaxAgeMs;
  const rawSides = snapshot?.sides || {};
  const hasCompleteSide = ["UP", "DOWN"].some((direction) => {
    const side = rawSides[direction];
    return [side?.fairProbability, side?.ask, snapshot?.feeBufferCents, side?.netEvCents]
      .every((value) => finite(value) != null);
  });
  const dataStatus = !remainingAvailable || !oracleAvailable || !hasCompleteSide || !backendAuthorityAvailable
    ? "UNAVAILABLE"
    : !oracleFresh
      ? "STALE"
      : !executable || backendBlocked
        ? "BLOCKED"
        : "READY";
  const commonFailures = [];
  if (!backendAuthorityAvailable) {
    commonFailures.push(gate(
      "BACKEND_AUTHORITY",
      { actionable: snapshot?.actionable, blockersIsArray: Array.isArray(snapshot?.blockers) },
      { actionable: "boolean", blockersIsArray: true },
      "Backend authority metadata is required."
    ));
  }
  if (!executable) {
    commonFailures.push(gate(
      "MARKET_EXECUTABILITY",
      { marketActive: snapshot?.marketActive === true, marketClosed: snapshot?.marketClosed === true, acceptingOrders: snapshot?.acceptingOrders === true },
      { marketActive: true, marketClosed: false, acceptingOrders: true },
      "Market must be active, open, and accepting orders."
    ));
  }
  if (backendActionableBlocked) {
    commonFailures.push(gate(
      "BACKEND_ACTIONABLE",
      false,
      true,
      "Backend marked this snapshot as non-actionable."
    ));
  }
  if (backendBlockers.length) {
    commonFailures.push(gate(
      "SERVER_GUARDRAIL",
      backendBlockers,
      [],
      `Backend guardrails blocked entry: ${backendBlockers.join(" | ")}`
    ));
  }
  if (!oracleAvailable) {
    commonFailures.push(gate(
      "MISSING_ORACLE",
      null,
      `number between 0 and ${config.oracleMaxAgeMs}`,
      "Oracle age is required."
    ));
  } else if (!oracleFresh) {
    commonFailures.push(gate(
      "STALE_ORACLE",
      oracleAgeMs,
      config.oracleMaxAgeMs,
      `Oracle age must be between 0 and ${config.oracleMaxAgeMs}ms.`
    ));
  }

  const sides = Object.fromEntries(["UP", "DOWN"].map((direction) => {
    const rawSide = rawSides[direction];
    const fairProbability = finite(rawSide?.fairProbability);
    const ask = finite(rawSide?.ask);
    const netEvCents = finite(rawSide?.netEvCents);
    const grossEvCents = fairProbability == null || ask == null
      ? null
      : Number((fairProbability - ask * 100).toFixed(4));
    const maxEntryPrice = fairProbability == null || feeBufferCents == null
      ? null
      : Number(Math.min(
        config.maxAsk,
        (fairProbability - config.minNetEvCents - feeBufferCents) / 100
      ).toFixed(4));
    const failedGates = commonFailures.map((failure) => ({ ...failure }));
    const missingMetrics = [
      ["fairProbability", fairProbability],
      ["ask", ask],
      ["feeBufferCents", feeBufferCents],
      ["netEvCents", netEvCents],
    ].filter(([, value]) => value == null).map(([name]) => name);
    if (missingMetrics.length) {
      failedGates.push(gate(
        "MISSING_METRICS",
        missingMetrics,
        ["fairProbability", "ask", "feeBufferCents", "netEvCents"],
        `Missing required metrics: ${missingMetrics.join(", ")}.`
      ));
    }
    if (fairProbability != null && fairProbability < config.minFairProbability) {
      failedGates.push(gate(
        "MIN_FAIR_PROBABILITY",
        fairProbability,
        config.minFairProbability,
        `Fair probability must be at least ${config.minFairProbability}%.`
      ));
    }
    if (ask != null && ask <= 0) {
      failedGates.push(gate("INVALID_ASK", ask, "> 0", "Ask must be greater than zero."));
    }
    if (ask != null && ask > config.maxAsk) {
      failedGates.push(gate(
        "MAX_ASK",
        ask,
        config.maxAsk,
        `Ask must not exceed $${config.maxAsk}.`
      ));
    }
    if (netEvCents != null && netEvCents < config.minNetEvCents) {
      failedGates.push(gate(
        "MIN_NET_EV",
        netEvCents,
        config.minNetEvCents,
        `Net EV must be at least ${config.minNetEvCents} cents.`
      ));
    }
    if (ask != null && maxEntryPrice != null && ask > maxEntryPrice) {
      failedGates.push(gate(
        "EDGE_PRESERVING_CAP",
        ask,
        maxEntryPrice,
        `Ask must not exceed the edge-preserving cap of $${maxEntryPrice}.`
      ));
    }
    return [direction, {
      direction,
      fairProbability,
      ask,
      feeBufferCents,
      grossEvCents,
      netEvCents,
      maxEntryPrice,
      qualified: failedGates.length === 0,
      failedGates,
    }];
  }));
  const rankedSides = Object.values(sides).sort(compareSides);
  const observedSide = rankedSides[0];
  const candidates = rankedSides.filter((side) => side.qualified);
  const diagnosticLean = ["UP", "DOWN", "NEUTRAL"].includes(snapshot?.forecastDirection)
    ? snapshot.forecastDirection
    : "NEUTRAL";
  const inWindow = remainingSeconds != null
    && remainingSeconds > config.scanStopSeconds
    && remainingSeconds <= config.scanStartSeconds;
  const selected = inWindow ? candidates[0] || null : null;
  const status = !remainingAvailable
    ? "watching"
    : remainingSeconds <= config.scanStopSeconds
      ? "expired"
      : remainingSeconds > config.scanStartSeconds
        ? "waiting"
        : selected
          ? "candidate"
          : "watching";
  const reason = !remainingAvailable
    ? "Remaining time is unavailable."
    : status === "expired"
      ? "Scan window has ended."
      : status === "waiting"
        ? "Scan window has not started."
        : !backendAuthorityAvailable
          ? "Backend authority metadata is unavailable."
        : !executable
            ? "Market is not executable."
            : backendBlocked
              ? "Backend guardrails blocked entry."
              : !oracleAvailable
                ? "Oracle data is unavailable."
                : !oracleFresh
                  ? "Oracle data is stale."
                  : selected
                    ? null
                    : "No side meets price and EV thresholds.";

  return {
    qualified: Boolean(selected),
    status,
    reason,
    dataStatus,
    diagnosticLean,
    observedSide,
    sides,
    failedGates: observedSide.failedGates,
    ...(selected || {}),
  };
}

export function qualifyEntrySnapshot(snapshot, overrides = {}) {
  return assessEntrySnapshot(snapshot, overrides);
}

function observedRecord(assessment, snapshot) {
  if (!assessment?.observedSide
    || ![assessment.observedSide.fairProbability, assessment.observedSide.ask, assessment.observedSide.netEvCents]
      .some((value) => value != null)) return null;
  return {
    ...assessment.observedSide,
    dataStatus: assessment.dataStatus,
    capturedAt: snapshot?.capturedAt || null,
  };
}

function issuedMaxPriceFailure(ask, maxEntryPrice) {
  return gate(
    "ISSUED_MAX_ENTRY_PRICE",
    ask,
    maxEntryPrice,
    `Ask $${ask.toFixed(2)} exceeds issued max entry price $${maxEntryPrice.toFixed(2)}.`
  );
}

function compareObservations(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aUsable = a.dataStatus === "READY"
    && [a.fairProbability, a.ask, a.feeBufferCents, a.netEvCents].every((value) => value != null);
  const bUsable = b.dataStatus === "READY"
    && [b.fairProbability, b.ask, b.feeBufferCents, b.netEvCents].every((value) => value != null);
  const comparison = Number(bUsable) - Number(aUsable)
    || (b.netEvCents ?? -Infinity) - (a.netEvCents ?? -Infinity)
    || (b.fairProbability ?? -Infinity) - (a.fairProbability ?? -Infinity)
    || (a.ask ?? Infinity) - (b.ask ?? Infinity)
    || (Date.parse(b.capturedAt || "") || -Infinity) - (Date.parse(a.capturedAt || "") || -Infinity)
    || String(a.direction).localeCompare(String(b.direction));
  return comparison < 0 ? a : b;
}

function terminalFailures(assessment, maxConfirmationCount, requiredConfirmations) {
  const failures = assessment?.observedSide?.failedGates.map((failure) => ({ ...failure })) || [];
  if (maxConfirmationCount < requiredConfirmations) {
    failures.push(gate(
      "CONFIRMATIONS",
      maxConfirmationCount,
      requiredConfirmations,
      `Required ${requiredConfirmations} same-direction confirmations; observed at most ${maxConfirmationCount}.`
    ));
  }
  return failures;
}

export function advanceEntryScannerState(previous = {}, snapshot, overrides = {}) {
  const config = scannerConfig(overrides);
  if (snapshot?.error) {
    const observedAt = Date.parse(snapshot.capturedAt || "");
    if (previous.status === "entry" && Number.isFinite(observedAt) && observedAt > previous.signal.expiresAt) {
      return {
        ...previous,
        status: "no_chase",
        outcome: "NO_CHASE",
        degraded: true,
        lastError: String(snapshot.error),
        terminalCapturedAt: snapshot.capturedAt,
        failedGates: [gate(
          "SIGNAL_TTL",
          observedAt,
          previous.signal.expiresAt,
          "Entry signal expired before execution."
        )],
        reason: "Entry signal expired while quote revalidation was unavailable.",
      };
    }
    return { ...previous, degraded: true, lastError: String(snapshot.error) };
  }

  const terminalCapturedAt = snapshot?.terminalCapturedAt || null;
  const observationSnapshot = terminalCapturedAt
    ? Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "terminalCapturedAt"))
    : snapshot;
  const assessment = assessEntrySnapshot(observationSnapshot, config);
  const observed = observedRecord(assessment, observationSnapshot);
  const evidence = {
    latestSnapshot: observationSnapshot,
    latestAssessment: assessment,
    bestObserved: compareObservations(previous.bestObserved, observed),
    maxConfirmationCount: Number(previous.maxConfirmationCount || 0),
    requiredConfirmations: config.confirmations,
  };

  if (previous.status === "entry") {
    const remainingUnavailable = finite(observationSnapshot?.remainingSeconds) == null;
    const capturedAt = Date.parse(terminalCapturedAt || observationSnapshot?.capturedAt || "");
    const expired = Number.isFinite(capturedAt) && capturedAt > previous.signal.expiresAt;
    const direction = previous.signal.direction;
    const hasIssuedSide = Object.prototype.hasOwnProperty.call(observationSnapshot?.sides || {}, direction)
      && observationSnapshot.sides[direction] != null;
    const assessedSide = assessment.sides[direction];
    const ask = finite(observationSnapshot?.sides?.[direction]?.ask);
    const sideFailures = hasIssuedSide ? [...(assessedSide?.failedGates || [])] : [];
    const sideQualificationFailed = sideFailures.length > 0;
    const issuedCapExceeded = ask != null && ask > previous.signal.maxEntryPrice;
    const failedGates = hasIssuedSide
      ? sideFailures
      : [gate(
        "SIGNAL_SIDE_UNAVAILABLE",
        null,
        `${direction} side metrics`,
        `Issued ${direction} side is unavailable for revalidation.`
      )];

    if (issuedCapExceeded) {
      failedGates.push(issuedMaxPriceFailure(ask, previous.signal.maxEntryPrice));
    }
    if (expired) {
      failedGates.push(gate(
        "SIGNAL_TTL",
        capturedAt,
        previous.signal.expiresAt,
        "Entry signal expired before execution."
      ));
    }

    if (expired || !hasIssuedSide || sideQualificationFailed || issuedCapExceeded) {
      let reason;
      if (expired) {
        reason = "Entry signal expired.";
      } else if (!hasIssuedSide) {
        reason = `Issued ${direction} side is unavailable.`;
      } else if (sideQualificationFailed) {
        reason = `Issued ${direction} side no longer qualifies.`;
      } else {
        reason = `Issued ${direction} ask exceeds its max entry price.`;
      }
      return {
        ...previous,
        ...evidence,
        status: "no_chase",
        outcome: "NO_CHASE",
        terminalCapturedAt: terminalCapturedAt || observationSnapshot?.capturedAt || null,
        failedGates,
        reason,
      };
    }
    return { ...previous, ...evidence, failedGates: [], reason: null, degraded: remainingUnavailable, lastError: null };
  }
  if (previous.status === "no_chase" || previous.status === "skipped") return previous;

  const qualification = assessment;
  if (qualification.status === "expired") {
    return {
      ...previous,
      ...evidence,
      status: "skipped",
      outcome: "NO_ENTRY",
      terminalCapturedAt: terminalCapturedAt || observationSnapshot?.capturedAt || null,
      failedGates: terminalFailures(assessment, evidence.maxConfirmationCount, config.confirmations),
      reason: "No valid edge before scan window ended.",
      degraded: false,
    };
  }
  if (!qualification.qualified) {
    return {
      ...previous,
      ...evidence,
      status: qualification.status,
      candidateDirection: null,
      confirmationCount: 0,
      reason: qualification.reason,
      degraded: false,
    };
  }

  const sameDirection = previous.candidateDirection === qualification.direction;
  const confirmationCount = sameDirection ? Number(previous.confirmationCount || 0) + 1 : 1;
  const next = {
    ...previous,
    ...evidence,
    status: confirmationCount >= config.confirmations ? "entry" : "candidate",
    candidateDirection: qualification.direction,
    confirmationCount,
    maxConfirmationCount: Math.max(evidence.maxConfirmationCount, confirmationCount),
    candidate: qualification.sides[qualification.direction],
    reason: null,
    degraded: false,
  };
  if (next.status === "entry") {
    const capturedAt = Date.parse(observationSnapshot.capturedAt);
    next.outcome = "ENTRY";
    next.signal = {
      ...next.candidate,
      capturedAt: observationSnapshot.capturedAt,
      remainingSeconds: observationSnapshot.remainingSeconds,
      expiresAt: (Number.isFinite(capturedAt) ? capturedAt : Date.now()) + config.signalTtlMs,
    };
  }
  return next;
}

export function terminalizeEntryScannerState(previous = {}, remainingSeconds, terminalCapturedAt = new Date().toISOString(), overrides = {}) {
  const latestSnapshot = previous?.latestSnapshot;
  const observedAt = Date.parse(latestSnapshot?.capturedAt || "");
  const terminalAt = Date.parse(terminalCapturedAt || "");
  const elapsedMs = Number.isFinite(observedAt) && Number.isFinite(terminalAt) && terminalAt >= observedAt
    ? terminalAt - observedAt
    : null;
  const oracleAgeMs = finite(latestSnapshot?.oracleAgeMs);
  const adjustedOracleAgeMs = oracleAgeMs != null && elapsedMs != null
    ? oracleAgeMs + elapsedMs
    : null;
  return advanceEntryScannerState(previous, {
    ...(latestSnapshot || {}),
    capturedAt: latestSnapshot?.capturedAt || null,
    remainingSeconds,
    oracleAgeMs: adjustedOracleAgeMs,
    terminalCapturedAt,
  }, overrides);
}

export function normalizeEntryScannerResult(state = {}) {
  const status = state?.status;
  const outcome = state?.outcome
    || (status === "entry" ? "ENTRY" : status === "no_chase" ? "NO_CHASE" : status === "skipped" ? "NO_ENTRY" : null);
  const diagnosticLean = state?.latestAssessment?.diagnosticLean
    || (["UP", "DOWN", "NEUTRAL"].includes(state?.latestSnapshot?.forecastDirection)
      ? state.latestSnapshot.forecastDirection
      : "NEUTRAL");
  return {
    completed: ["no_chase", "skipped"].includes(status),
    outcome,
    diagnosticLean,
    bestObserved: state?.bestObserved || null,
    failedGates: state?.failedGates || state?.latestAssessment?.failedGates || [],
    issuedSignal: state?.signal || null,
    dataStatus: state?.degraded && state?.lastError
      ? "UNAVAILABLE"
      : state?.latestAssessment?.dataStatus || state?.bestObserved?.dataStatus || "UNAVAILABLE",
    maxConfirmationCount: Number(state?.maxConfirmationCount || 0),
    requiredConfirmations: Number(state?.requiredConfirmations || DEFAULT_ENTRY_SCANNER_CONFIG.confirmations),
    reason: state?.reason || null,
  };
}

export function selectNewestEntryScannerItem(queueStates = []) {
  let newest = null;
  let newestAt = -Infinity;
  for (const item of queueStates) {
    const result = normalizeEntryScannerResult(item?.entryScanner);
    if (!["ENTRY", "NO_ENTRY", "NO_CHASE"].includes(result.outcome)) continue;
    const state = item.entryScanner;
    const capturedAt = Date.parse(state?.terminalCapturedAt || "") || Math.max(
      Date.parse(state?.latestSnapshot?.capturedAt || "") || -Infinity,
      Date.parse(state?.signal?.capturedAt || "") || -Infinity,
      Date.parse(state?.bestObserved?.capturedAt || "") || -Infinity
    );
    if (newest == null || capturedAt >= newestAt) {
      newest = item;
      newestAt = capturedAt;
    }
  }
  return newest;
}

export function resetEntryScannerItem(item, requiredConfirmations = DEFAULT_ENTRY_SCANNER_CONFIG.confirmations) {
  item.entryScanner = {
    status: "waiting",
    confirmationCount: 0,
    requiredConfirmations,
  };
  item.entrySignalTriggered = false;
  item.snipeFired = false;
  item.isEvSkipped = false;
  item.dynamicScanInFlight = false;
  delete item.snipeFiredAtRemainingSeconds;
  delete item.dynamicLastScanAt;
  delete item.isLateFired;
  return item;
}

export function summarizeEntryScannerSession(queueStates = []) {
  const summary = {
    completed: 0,
    entries: 0,
    noEntry: 0,
    noChase: 0,
    up: 0,
    down: 0,
    neutral: 0,
  };
  for (const item of queueStates) {
    const result = normalizeEntryScannerResult(item?.entryScanner || item);
    if (!result.completed) continue;
    summary.completed += 1;
    if (result.issuedSignal) summary.entries += 1;
    if (result.outcome === "NO_ENTRY") summary.noEntry += 1;
    if (result.outcome === "NO_CHASE") summary.noChase += 1;
    if (result.diagnosticLean === "UP") summary.up += 1;
    else if (result.diagnosticLean === "DOWN") summary.down += 1;
    else summary.neutral += 1;
  }
  return summary;
}
