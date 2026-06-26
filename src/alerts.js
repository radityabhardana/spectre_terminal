/**
 * alerts.js — Price Alert System
 * Ditiru dari CloddsBot src/alerts/ & skill bundled/alerts/SKILL.md
 * Polling Polymarket CLOB API (gratis, no auth) setiap 30 detik.
 * Supports: price_above, price_below, price_change_pct
 */

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

// ─── DB setup ──────────────────────────────────────────────────────────────

const dataDir = path.resolve(process.cwd(), "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "database.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS price_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_id   TEXT NOT NULL,
    market_id  TEXT NOT NULL,
    question   TEXT NOT NULL,
    condition  TEXT NOT NULL,
    threshold  REAL NOT NULL,
    last_price REAL,
    triggered  INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

// ─── CLOB price fetch (public, no auth) ────────────────────────────────────

const CLOB_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";

async function fetchTokenPrice(tokenId) {
  try {
    const res = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();

    const bids = Array.isArray(data.bids) ? data.bids : [];
    const asks = Array.isArray(data.asks) ? data.asks : [];

    const bestBid = bids.map(b => Number(b.price)).filter(isFinite).sort((a, b) => b - a)[0];
    const bestAsk = asks.map(a => Number(a.price)).filter(isFinite).sort((a, b) => a - b)[0];

    if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
    return bestBid ?? bestAsk ?? null;
  } catch {
    return null;
  }
}

// ─── Alert CRUD ────────────────────────────────────────────────────────────

export function addAlert({ tokenId, marketId, question, condition, threshold }) {
  const stmt = db.prepare(`
    INSERT INTO price_alerts (token_id, market_id, question, condition, threshold, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(tokenId, marketId, question, condition, threshold, new Date().toISOString());
  return info.lastInsertRowid;
}

export function listAlerts() {
  return db.prepare("SELECT * FROM price_alerts WHERE triggered = 0 ORDER BY id DESC").all();
}

export function deleteAlert(id) {
  return db.prepare("DELETE FROM price_alerts WHERE id = ?").run(id).changes > 0;
}

function markTriggered(id) {
  db.prepare("UPDATE price_alerts SET triggered = 1 WHERE id = ?").run(id);
}

function updateLastPrice(id, price) {
  db.prepare("UPDATE price_alerts SET last_price = ? WHERE id = ?").run(price, id);
}

// ─── Condition checker ─────────────────────────────────────────────────────

function checkCondition(alert, currentPrice) {
  const { condition, threshold, last_price } = alert;

  if (condition === "price_above") return currentPrice >= threshold;
  if (condition === "price_below") return currentPrice <= threshold;
  if (condition === "price_change_pct") {
    if (last_price == null || last_price === 0) return false;
    const changePct = Math.abs((currentPrice - last_price) / last_price) * 100;
    return changePct >= threshold;
  }
  return false;
}

// ─── Emoji helper ──────────────────────────────────────────────────────────

function conditionEmoji(condition, currentPrice, threshold) {
  if (condition === "price_above") return "📈";
  if (condition === "price_below") return "📉";
  if (condition === "price_change_pct") return "⚡";
  return "🔔";
}

// ─── Alert runner ──────────────────────────────────────────────────────────

/** sendFn: async (text) => void — fungsi kirim pesan ke Telegram */
export function startAlertMonitor(sendFn, intervalMs = 30_000) {
  console.log("[Alerts] Monitor started, interval:", intervalMs, "ms");

  const tick = async () => {
    const alerts = listAlerts();
    if (!alerts.length) return;

    for (const alert of alerts) {
      try {
        const price = await fetchTokenPrice(alert.token_id);
        if (price == null) continue;

        if (checkCondition(alert, price)) {
          const emoji = conditionEmoji(alert.condition, price, alert.threshold);
          const priceFormatted = (price * 100).toFixed(1) + "¢";
          const thresholdFormatted = (alert.threshold * 100).toFixed(1) + "¢";

          let msg = `${emoji} *ALERT TRIGGERED*\n`;
          msg += `📊 *${alert.question}*\n\n`;

          if (alert.condition === "price_above") {
            msg += `Harga naik ke *${priceFormatted}* (threshold: ≥${thresholdFormatted})`;
          } else if (alert.condition === "price_below") {
            msg += `Harga turun ke *${priceFormatted}* (threshold: ≤${thresholdFormatted})`;
          } else {
            const prev = alert.last_price;
            const changePct = prev ? ((price - prev) / prev * 100).toFixed(1) : "?";
            msg += `Harga berubah ${changePct}% → *${priceFormatted}* (threshold: ≥${alert.threshold}%)`;
          }

          msg += `\n\n_Alert ID: ${alert.id} | /delalert ${alert.id} untuk hapus_`;

          await sendFn(msg).catch(e => console.error("[Alerts] send error:", e.message));
          markTriggered(alert.id);
        } else {
          updateLastPrice(alert.id, price);
        }
      } catch (e) {
        console.error("[Alerts] tick error for id", alert.id, e.message);
      }
    }
  };

  // Run immediately then on interval
  tick();
  const interval = setInterval(tick, intervalMs);
  return () => clearInterval(interval); // returns stop function
}

// ─── Format helpers for Telegram ───────────────────────────────────────────

export function formatAlertsList() {
  const alerts = listAlerts();
  if (!alerts.length) return "📭 Tidak ada alert aktif.";

  let text = `🔔 *Alert Aktif (${alerts.length})*\n\n`;
  for (const a of alerts) {
    const threshold = a.condition === "price_change_pct"
      ? `${a.threshold}%`
      : (a.threshold * 100).toFixed(1) + "¢";

    const condLabel = {
      price_above: "≥",
      price_below: "≤",
      price_change_pct: "±",
    }[a.condition] ?? "?";

    const lastPrice = a.last_price != null
      ? ` | Harga sekarang: ${(a.last_price * 100).toFixed(1)}¢`
      : "";

    text += `• ID *${a.id}* — ${a.question.slice(0, 50)}\n`;
    text += `  Kondisi: harga ${condLabel}${threshold}${lastPrice}\n`;
    text += `  /delalert ${a.id}\n\n`;
  }

  return text.trim();
}

export function parseAlertCommand(args) {
  // Format: <token_id> <condition> <threshold>
  // Example: "abc123 above 0.70" | "abc123 below 0.30" | "abc123 change 5"
  const parts = args.trim().split(/\s+/);
  if (parts.length < 3) return null;

  const [tokenId, conditionRaw, thresholdRaw] = parts;
  const threshold = parseFloat(thresholdRaw);
  if (!isFinite(threshold)) return null;

  const condMap = {
    above: "price_above",
    naik: "price_above",
    below: "price_below",
    turun: "price_below",
    change: "price_change_pct",
    pct: "price_change_pct",
    berubah: "price_change_pct",
  };

  const condition = condMap[conditionRaw.toLowerCase()];
  if (!condition) return null;

  return { tokenId, condition, threshold };
}
