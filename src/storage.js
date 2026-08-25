import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.js";
import { databasePath } from "./database-path.js";
import { migrateDatabase } from "./migrations.js";

const db = new Database(databasePath);
export { databasePath };
export const ANALYSIS_STRATEGY_VERSION = "chainlink-terminal-value-v3";
export const SHORT_EVALUATION_CONTRACT_VERSION = "phase-a-v1";
export const SHORT_EVALUATION_MODEL_VERSION = "oracle-diff-normal-v1";

db.pragma('journal_mode = WAL');
await migrateDatabase(db, { databasePath });

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
export function canonicalAuditPayload(payload) { return JSON.stringify(canonicalize(payload)); }
export function auditPayloadHash(payload) { return createHash("sha256").update(payload, "utf8").digest("hex"); }
const nowIso = (value) => value == null ? new Date().toISOString() : String(value);
const valueOf = (input, camel, snake = camel) => input?.[camel] ?? input?.[snake];

function readPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("audit payload must be a non-null object");
  const serialized = canonicalAuditPayload(payload);
  return { serialized, hash: auditPayloadHash(serialized) };
}

export function appendShortEvaluationSnapshot({
  marketId = null, marketQuestion = null, durationType = null, asset = null,
  capturedAt, createdAt = new Date().toISOString(),
  contractVersion = SHORT_EVALUATION_CONTRACT_VERSION, modelVersion = SHORT_EVALUATION_MODEL_VERSION,
  auditPayload = null, payload = auditPayload, runId = null, sequence = null,
  collectionMode = null, scheduledAt = null, startedAt = null, finishedAt = null,
  attemptStatus = null, errorCode = null, leaseOwner = null, leaseToken = null, now = null,
} = {}) {
  if (runId != null || sequence != null) return appendShortEvaluationSnapshotAttempt({
    marketId, marketQuestion, durationType, asset, capturedAt, createdAt, contractVersion,
    modelVersion, auditPayload: payload, runId, sequence, collectionMode, scheduledAt,
    startedAt, finishedAt, attemptStatus, errorCode, leaseOwner, leaseToken, now,
  });
  try {
    if (!capturedAt) throw new Error("capturedAt is required for a short evaluation snapshot");
    const serialized = readPayload(payload);
    const info = db.prepare(`INSERT INTO short_evaluation_snapshots
      (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      marketId == null ? null : String(marketId), marketQuestion == null ? null : String(marketQuestion),
      durationType == null ? null : String(durationType), asset == null ? null : String(asset), String(capturedAt), String(createdAt),
      String(contractVersion), String(modelVersion), serialized.serialized, serialized.hash,
    );
    return Number(info.lastInsertRowid);
  } catch (error) { console.error("[Storage] appendShortEvaluationSnapshot error:", error.message); return null; }
}

export function getShortEvaluationSnapshots({ marketId = null, marketQuestion = null, limit = 100 } = {}) {
  try {
    const conditions = []; const params = [];
    if (marketId != null) { conditions.push("market_id = ?"); params.push(String(marketId)); }
    if (marketQuestion != null) { conditions.push("market_question = ?"); params.push(String(marketQuestion)); }
    params.push(Math.max(0, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 100)));
    const rows = db.prepare(`SELECT id, market_id, market_question, duration_type, asset, captured_at, created_at,
      contract_version, model_version, payload, audit_payload_hash, run_id, sequence, collection_mode,
      scheduled_at, started_at, finished_at, attempt_status, error_code FROM short_evaluation_snapshots
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...params);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  } catch (error) { console.error("[Storage] getShortEvaluationSnapshots error:", error.message); return []; }
}

function runRow(runId) { return db.prepare("SELECT * FROM short_observation_runs WHERE run_id = ?").get(String(runId)) || null; }
function canonicalConfig(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config must be an object");
  return JSON.stringify(canonicalize(parsed));
}

export function enrollShortObservationRun(input = {}) {
  try {
    const runId = valueOf(input, "runId", "run_id"); const enrollmentKey = valueOf(input, "enrollmentKey", "enrollment_key");
    const marketId = valueOf(input, "marketId", "market_id"); const marketQuestion = valueOf(input, "marketQuestion", "market_question");
    const asset = valueOf(input, "asset"); const durationType = valueOf(input, "durationType", "duration_type");
    const nextScheduledAt = valueOf(input, "nextScheduledAt", "next_scheduled_at");
    if ([runId, enrollmentKey, marketId, marketQuestion, asset, durationType, nextScheduledAt].some((v) => v == null || String(v) === "")) throw new Error("run enrollment requires canonical identity and schedule");
    const config = canonicalConfig(valueOf(input, "config", "config_json") ?? input.configJson);
    const createdAt = nowIso(valueOf(input, "createdAt", "created_at"));
    db.prepare(`INSERT INTO short_observation_runs
      (run_id, enrollment_key, market_id, market_question, asset, duration_type, config_json, status, next_sequence, next_scheduled_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?) ON CONFLICT(enrollment_key) DO NOTHING`).run(
      String(runId), String(enrollmentKey), String(marketId), String(marketQuestion), String(asset), String(durationType), config,
      Number(valueOf(input, "nextSequence", "next_sequence") ?? 0), String(nextScheduledAt), createdAt, nowIso(valueOf(input, "updatedAt", "updated_at") ?? createdAt),
    );
    return db.prepare("SELECT * FROM short_observation_runs WHERE enrollment_key = ?").get(String(enrollmentKey)) || null;
  } catch (error) { console.error("[Storage] enrollShortObservationRun error:", error.message); return null; }
}
export const enrollShortObservation = enrollShortObservationRun;
export function getShortObservationRun(runId) { try { return runRow(runId); } catch { return null; } }
export function getShortObservationRuns({ status = null, limit = 100 } = {}) {
  try { const params = []; const where = status == null ? "" : " WHERE status = ?"; if (status != null) params.push(String(status)); params.push(Math.max(0, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 100))); return db.prepare(`SELECT * FROM short_observation_runs${where} ORDER BY next_scheduled_at, run_id LIMIT ?`).all(...params); } catch { return []; }
}
export const listShortObservationRuns = getShortObservationRuns;

function leaseArgs(input, owner, token, expiresAt, now) {
  if (input && typeof input === "object") return {
    runId: valueOf(input, "runId", "run_id"), leaseOwner: valueOf(input, "leaseOwner", "lease_owner") ?? valueOf(input, "owner"),
    leaseToken: valueOf(input, "leaseToken", "lease_token") ?? valueOf(input, "token"), leaseExpiresAt: valueOf(input, "leaseExpiresAt", "lease_expires_at") ?? valueOf(input, "expiresAt"), now: valueOf(input, "now") ?? valueOf(input, "at"),
  };
  return { runId: input, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expiresAt, now };
}
export function claimShortObservationRun(input, owner, token, expiresAt, at) {
  try { const args = leaseArgs(input, owner, token, expiresAt, at); if (!args.runId || !args.leaseOwner || !args.leaseExpiresAt) throw new Error("lease claim requires owner and expiry"); const leaseToken = String(args.leaseToken || randomUUID()); const now = nowIso(args.now); const info = db.prepare(`UPDATE short_observation_runs SET lease_token = ?, lease_owner = ?, lease_expires_at = ?, status = CASE WHEN status = 'scheduled' THEN 'observing' ELSE status END, started_at = COALESCE(started_at, ?), updated_at = ? WHERE run_id = ? AND status IN ('scheduled', 'observing') AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`).run(leaseToken, String(args.leaseOwner), String(args.leaseExpiresAt), now, now, String(args.runId), now); return info.changes === 1 ? runRow(args.runId) : null; } catch (error) { console.error("[Storage] claimShortObservationRun error:", error.message); return null; }
}
export function releaseShortObservationRun(input, owner, token, at) {
  try { const args = leaseArgs(input, owner, token, undefined, at); if (!args.runId || !args.leaseOwner || !args.leaseToken) throw new Error("lease release requires owner and token"); return db.prepare("UPDATE short_observation_runs SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ? AND lease_owner = ? AND lease_token = ?").run(nowIso(args.now), String(args.runId), String(args.leaseOwner), String(args.leaseToken)).changes === 1; } catch { return false; }
}
const terminalStatuses = new Set(["completed", "missed", "invalid"]);
export function terminalizeShortObservationRun(input = {}) {
  try { const runId = valueOf(input, "runId", "run_id"); const status = String(valueOf(input, "status") || ""); const owner = valueOf(input, "leaseOwner", "lease_owner") ?? valueOf(input, "owner"); const token = valueOf(input, "leaseToken", "lease_token") ?? valueOf(input, "token"); const now = nowIso(valueOf(input, "now")); const terminalAt = String(valueOf(input, "terminalAt", "terminal_at") ?? now); if (!runId || !terminalStatuses.has(status) || !owner || !token) return null; return db.transaction(() => { const info = db.prepare(`UPDATE short_observation_runs SET status = ?, terminal_at = ?, completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END, error_code = ?, error_message = ?, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE run_id = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ? AND status IN ('scheduled', 'observing')`).run(status, terminalAt, status, terminalAt, valueOf(input, "errorCode", "error_code") ?? null, valueOf(input, "errorMessage", "error_message") ?? null, now, String(runId), String(owner), String(token), now); if (info.changes !== 1) throw new Error("terminal transition was lease-fenced"); return runRow(runId); })(); } catch { return null; }
}
export const transitionShortObservationRunTerminal = terminalizeShortObservationRun;

export function appendShortEvaluationSnapshotAttempt(input = {}) {
  try {
    const runId = valueOf(input, "runId", "run_id"); const sequence = Number(valueOf(input, "sequence"));
    const owner = valueOf(input, "leaseOwner", "lease_owner") ?? valueOf(input, "owner"); const token = valueOf(input, "leaseToken", "lease_token") ?? valueOf(input, "token");
    const marketId = valueOf(input, "marketId", "market_id"); const marketQuestion = valueOf(input, "marketQuestion", "market_question"); const durationType = valueOf(input, "durationType", "duration_type"); const asset = valueOf(input, "asset");
    const capturedAt = valueOf(input, "capturedAt", "captured_at"); const now = nowIso(valueOf(input, "now"));
    if (!runId || !Number.isInteger(sequence) || sequence < 0 || !owner || !token || [marketId, marketQuestion, durationType, asset, capturedAt].some((v) => v == null || String(v) === "")) throw new Error("collector attempt requires lease, identity, and sequence");
    const payload = readPayload(valueOf(input, "auditPayload") ?? valueOf(input, "payload"));
    return db.transaction(() => {
      const run = db.prepare(`SELECT * FROM short_observation_runs WHERE run_id = ? AND market_id = ? AND market_question = ? AND duration_type = ? AND asset = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ? AND status IN ('scheduled', 'observing')`).get(String(runId), String(marketId), String(marketQuestion), String(durationType), String(asset), String(owner), String(token), now);
      if (!run || sequence !== Number(run.next_sequence)) throw new Error("collector lease or sequence is not active");
      const info = db.prepare(`INSERT INTO short_evaluation_snapshots
        (market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash, run_id, sequence, collection_mode, scheduled_at, started_at, finished_at, attempt_status, error_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        String(marketId), String(marketQuestion), String(durationType), String(asset), String(capturedAt), nowIso(valueOf(input, "createdAt", "created_at")),
        String(valueOf(input, "contractVersion", "contract_version") ?? SHORT_EVALUATION_CONTRACT_VERSION), String(valueOf(input, "modelVersion", "model_version") ?? SHORT_EVALUATION_MODEL_VERSION), payload.serialized, payload.hash, String(runId), sequence,
        valueOf(input, "collectionMode", "collection_mode") ?? null, valueOf(input, "scheduledAt", "scheduled_at") ?? null, valueOf(input, "startedAt", "started_at") ?? null, valueOf(input, "finishedAt", "finished_at") ?? null, valueOf(input, "attemptStatus", "attempt_status") ?? null, valueOf(input, "errorCode", "error_code") ?? null,
      );
      const checkpoint = db.prepare(`UPDATE short_observation_runs SET next_sequence = ?, next_scheduled_at = COALESCE(?, next_scheduled_at), updated_at = ? WHERE run_id = ? AND market_id = ? AND duration_type = ? AND asset = ? AND lease_owner = ? AND lease_token = ? AND lease_expires_at > ? AND status IN ('scheduled', 'observing') AND next_sequence = ?`).run(sequence + 1, valueOf(input, "nextScheduledAt", "next_scheduled_at") ?? null, now, String(runId), String(marketId), String(durationType), String(asset), String(owner), String(token), now, sequence);
      if (checkpoint.changes !== 1) throw new Error("collector checkpoint was fenced");
      return Number(info.lastInsertRowid);
    })();
  } catch (error) { console.error("[Storage] appendShortEvaluationSnapshotAttempt error:", error.message); return null; }
}
export const appendCollectorAttempt = appendShortEvaluationSnapshotAttempt;

export function getShortEvaluationSnapshotAttempts({ runId = null, sequence = null, limit = 100 } = {}) {
  try { const conditions = ["run_id IS NOT NULL"]; const params = []; if (runId != null) { conditions.push("run_id = ?"); params.push(String(runId)); } if (sequence != null) { conditions.push("sequence = ?"); params.push(Number(sequence)); } params.push(Math.max(0, Math.floor(Number.isFinite(Number(limit)) ? Number(limit) : 100))); const rows = db.prepare(`SELECT id, market_id, market_question, duration_type, asset, captured_at, created_at, contract_version, model_version, payload, audit_payload_hash, run_id, sequence, collection_mode, scheduled_at, started_at, finished_at, attempt_status, error_code FROM short_evaluation_snapshots WHERE ${conditions.join(" AND ")} ORDER BY sequence, id LIMIT ?`).all(...params); return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) })); } catch { return []; }
}
export const getCollectorAttempts = getShortEvaluationSnapshotAttempts;

export function getCache(key, ttlSeconds = config.cacheTtlSeconds) {
  try {
    const row = db.prepare('SELECT value, saved_at FROM cache WHERE key = ?').get(key);
    if (!row) return null;

    const ageSeconds = (Date.now() - row.saved_at) / 1000;
    if (ageSeconds > ttlSeconds) {
      db.prepare('DELETE FROM cache WHERE key = ?').run(key);
      return null;
    }

    return JSON.parse(row.value);
  } catch (error) {
    console.error("[Storage] getCache error:", error.message);
    return null;
  }
}

export function setCache(key, value) {
  try {
    db.prepare(`
      INSERT INTO cache (key, value, saved_at) 
      VALUES (?, ?, ?) 
      ON CONFLICT(key) DO UPDATE SET 
        value = excluded.value, 
        saved_at = excluded.saved_at
    `).run(key, JSON.stringify(value), Date.now());
  } catch (error) {
    console.error("[Storage] setCache error:", error.message);
  }
}

export function deleteCache(key) {
  try {
    return db.prepare('DELETE FROM cache WHERE key = ?').run(key).changes > 0;
  } catch (error) {
    console.error("[Storage] deleteCache error:", error.message);
    return false;
  }
}

export function appendAnalysisLog(entry) {
  try {
    const createdAt = new Date().toISOString();
    const data = JSON.stringify({ at: createdAt, ...entry });
    db.prepare('INSERT INTO analysis_log (created_at, data) VALUES (?, ?)').run(createdAt, data);
  } catch (error) {
    console.error("[Storage] appendAnalysisLog error:", error.message);
  }
}

export function getAnalysisLogs(limit = 50) {
  try {
    const rows = db.prepare('SELECT id, created_at, data FROM analysis_log ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map(r => ({
      id: r.id,
      created_at: r.created_at,
      data: JSON.parse(r.data)
    }));
  } catch (error) {
    console.error("[Storage] getAnalysisLogs error:", error.message);
    return [];
  }
}

export function addAnalyzedEvent(event) {
  try {
    const createdAt = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO analyzed_events (market_id, question, url, prediction, actionable, status, analysis_conclusion, qwen_confidence, data_confidence, execution_time, strategy_version, fair_probability, max_entry_price, signal_data_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'belum selesai', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(event.market_id, event.question, event.url, event.prediction, event.actionable ? 1 : 0, event.analysis_conclusion, event.qwen_confidence ?? null, event.data_confidence ?? null, event.execution_time ?? null, ANALYSIS_STRATEGY_VERSION, event.fair_probability ?? null, event.max_entry_price ?? null, event.signal_data_at || null, createdAt);
    return info.lastInsertRowid;
  } catch (error) {
    console.error("[Storage] addAnalyzedEvent error:", error.message);
    return null;
  }
}

export function getAnalyzedEvents(limit = 100, startDate = null, endDate = null) {
  try {
    let query = `SELECT a.* FROM analyzed_events a`;
    const params = [];
    const conditions = [];

    if (startDate) {
      conditions.push(`substr(a.created_at, 1, 10) >= ?`);
      params.push(startDate);
    }
    if (endDate) {
      conditions.push(`substr(a.created_at, 1, 10) <= ?`);
      params.push(endDate);
    }

    if (conditions.length > 0) {
      query += ` WHERE ` + conditions.join(' AND ');
    }

    query += ` ORDER BY a.id DESC LIMIT ?`;
    params.push(limit);

    return db.prepare(query).all(...params);
  } catch (error) {
    console.error("[Storage] getAnalyzedEvents error:", error.message);
    return [];
  }
}

export function getUnresolvedAnalyzedEvents() {
  try {
    return db.prepare("SELECT * FROM analyzed_events WHERE status = 'belum selesai' ORDER BY id ASC").all();
  } catch (error) {
    console.error("[Storage] getUnresolvedAnalyzedEvents error:", error.message);
    return [];
  }
}

export function summarizePlayStats(events, strategyVersion = null) {
  const resolved = (Array.isArray(events) ? events : []).filter((event) =>
    (!strategyVersion || event.strategy_version === strategyVersion)
    && Number(event.actionable) === 1
    && event.status === "selesai"
    && (event.result === "menang" || event.result === "kalah")
  );
  const wins = resolved.filter((event) => event.result === "menang").length;
  const losses = resolved.length - wins;
  return {
    sampleSize: resolved.length,
    wins,
    losses,
    winRate: resolved.length ? Number(((wins / resolved.length) * 100).toFixed(1)) : 0,
  };
}

function getResolvedPlayEvents() {
  return db.prepare(`
    SELECT strategy_version, actionable, status, result
    FROM analyzed_events
    WHERE actionable = 1 AND status = 'selesai' AND result IN ('menang', 'kalah')
    ORDER BY id ASC
  `).all();
}

export function getRecentResolvedOutcomes({ days = 30 } = {}) {
  try {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return db.prepare(`
      SELECT market_id, question, url, prediction, status, result, created_at
      FROM analyzed_events
      WHERE created_at >= ? AND status = 'selesai' AND result IN ('menang', 'kalah')
      ORDER BY created_at DESC
    `).all(since);
  } catch (error) {
    console.error("[Storage] getRecentResolvedOutcomes error:", error.message);
    return [];
  }
}

export function getStats() {
  try {
    const playStats = summarizePlayStats(getResolvedPlayEvents());
    const totalRow = db.prepare("SELECT COUNT(*) AS total FROM analyzed_events").get();
    return {
      totalAnalyzed: Number(totalRow?.total || 0),
      sampleSize: playStats.sampleSize,
      wins: playStats.wins,
      losses: playStats.losses,
      winRate: playStats.winRate,
      strategyVersion: ANALYSIS_STRATEGY_VERSION,
    };
  } catch (error) {
    console.error("[Storage] getStats error:", error.message);
    return { totalAnalyzed: 0, sampleSize: 0, wins: 0, losses: 0, winRate: 0 };
  }
}

export function getDashboardMetrics() {
  try {
    const resolvedEvents = getResolvedPlayEvents();
    const playStats = summarizePlayStats(resolvedEvents);
    let currentEquity = 0;
    let peakEquity = 0;
    let maxDrawdown = 0;

    for (const ev of resolvedEvents) {
      if (ev.result === 'menang') {
        currentEquity++;
      } else if (ev.result === 'kalah') {
        currentEquity--;
      }
      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      const drawdown = peakEquity - currentEquity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    // Financial metrics require fills, fees, and realized PnL, which this schema does not store yet.
    const profitFactor = "N/A";
    const expectancy = "N/A";

    const latestEvent = db.prepare(`
      SELECT question, prediction, analysis_conclusion, qwen_confidence, created_at, resolved_at, status
      FROM analyzed_events
      WHERE actionable = 1 AND UPPER(prediction) IN ('YES', 'UP', 'NO', 'DOWN')
      ORDER BY id DESC LIMIT 1
    `).get();
    
    let signalText = "-";
    let signalDir = "WAITING";
    let conclusion = "Menunggu data...";
    let confluenceScore = "0%";
    let eventName = "-";
    let eventTime = "-";
    
    if (latestEvent) {
      eventName = latestEvent.question;
      if (latestEvent.status === 'selesai' && latestEvent.resolved_at) {
        eventTime = latestEvent.resolved_at;
      } else {
        eventTime = latestEvent.created_at || "-";
      }
      let assetMatch = latestEvent.question.match(/^([A-Z0-9]+)\b/i);
      if (assetMatch) {
          signalText = assetMatch[1].toUpperCase();
          if (signalText === 'WILL') signalText = 'MARKET';
      } else {
          signalText = "MARKET";
      }
      
      if (latestEvent.prediction) {
          const predUpper = latestEvent.prediction.toUpperCase();
          if (predUpper.includes('YES') || predUpper.includes('UP')) signalDir = "LONG";
          else if (predUpper.includes('NO') || predUpper.includes('DOWN')) signalDir = "SHORT";
          else signalDir = "SIGNAL";
      }
      
      if (latestEvent.analysis_conclusion) {
          // Hanya ambil satu kalimat pertama atau teks pendek agar tidak merusak UI
          const fullText = latestEvent.analysis_conclusion.trim();
          let shortText = fullText.split('\n')[0];
          if (shortText.length > 50) shortText = shortText.substring(0, 50) + "...";
          conclusion = shortText;
          if (fullText.includes("KESIMPULAN CEPAT")) {
               const kcMatch = fullText.match(/KESIMPULAN CEPAT\r?\n(.*)/);
               if (kcMatch && kcMatch[1]) {
                    conclusion = kcMatch[1].substring(0, 50) + "...";
               }
          }
      }
      if (latestEvent.qwen_confidence) confluenceScore = latestEvent.qwen_confidence;
      if (!confluenceScore.includes('%')) confluenceScore += '%';
    }

    return {
      profitFactor,
      expectancy,
      maxDrawdown: "N/A",
      winRate: playStats.winRate.toFixed(1),
      sampleSize: playStats.sampleSize,
      strategyVersion: ANALYSIS_STRATEGY_VERSION,
      playStats,
      latestSignal: {
        asset: signalText,
        direction: signalDir,
        conclusion,
        confluenceScore,
        eventName,
        eventTime
      }
    };
  } catch (error) {
    console.error("[Storage] getDashboardMetrics error:", error.message);
    return null;
  }
}

export function updateAnalyzedEventStatus(id, status, result, actualOutcome) {
  try {
    const resolvedAt = new Date().toISOString();
    const info = db.prepare("UPDATE analyzed_events SET status = ?, result = ?, actual_outcome = ?, resolved_at = ? WHERE id = ? AND status != 'selesai'")
      .run(status, result, actualOutcome, resolvedAt, id);
    return info.changes > 0;
  } catch (error) {
    console.error("[Storage] updateAnalyzedEventStatus error:", error.message);
    return false;
  }
}

export function getAnalyzedEventById(id) {
  try {
    return db.prepare('SELECT * FROM analyzed_events WHERE id = ?').get(id);
  } catch (error) {
    console.error("[Storage] getAnalyzedEventById error:", error.message);
    return null;
  }
}

export function getStorageHealth() {
  try {
    return db.prepare("SELECT 1 AS ok").get()?.ok === 1;
  } catch {
    return false;
  }
}
