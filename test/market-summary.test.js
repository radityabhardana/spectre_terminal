import test from "node:test";
import assert from "node:assert/strict";

const SAMPLE_REPORT = `MARKET SUMMARY
Market: Bitcoin Up or Down - August 1, 9:20AM-9:25AM ET
Market ID: 3239001
Durasi Analisis: 8 detik
AI Tokens: 3567
API close/resolution: 29 Jul 2026, 19:20 WIB
URL: https://polymarket.com/event/btc-updown-5m-test

KESIMPULAN CEPAT
Arah market: DOWN (deterministic Chainlink terminal model)
Entry status: SKIP / guardrail blocked

ARAH MARKET - SCOUTING
Dominan: DOWN
Market Price Up: 26% | Market Price Down: 74%
Gap dominansi: 48 points
Underdog: skor 6/10 (UP = underdog di market ini)

SNAPSHOT DATA
Liquidity: $20,422
Gamma volume: $563
Orderbook DOWN: bid n/a | ask 0.01 | spread n/a
Executable books: UP ask 0.75 / mid 0.74 | DOWN ask n/a / mid 0.26

CONFIDENCE & RISK
Data confidence: 67/100 | Deterministic confidence: 100/100
Risks: liquidity LOW, spread HIGH, resolution MEDIUM
Data warning: DOWN executable ask missing
Guardrail: missing executable DOWN ask; actionable false

ALASAN SINGKAT
Explanation: Deterministic model flags TRENDING condition, but DOWN executable ask is missing.
Selected/lean Fair Prob: 72% | Terminal UP Prob: 28%
Expected Value (EV): 11.25 cents per share
Kelly Sizing Rec: 0% of Portfolio
Bull point: Price remains below the target into resolution.
Bear point: A late reversal can invalidate the directional lean.
Final reason: Guardrail blocks entry because the selected side has no executable ask.

ENTRY VERDICT
SKIP

KESIMPULAN AKHIR
Hasil Arah: DOWN
Data Confidence: 67/100
Deterministic Confidence: 100/100
Kesimpulan Analisis: Deterministic model flags TRENDING condition, but DOWN executable ask missing.
Target Price: 64388.846658832445
Realtime Chainlink Price: 64236.841398426855`;

test("parses decision, risk, and evidence fields from a market report", async () => {
  const { parseMarketSummary } = await import("../public/market-summary.js");
  const result = parseMarketSummary(SAMPLE_REPORT);

  assert.equal(result.market, "Bitcoin Up or Down - August 1, 9:20AM-9:25AM ET");
  assert.equal(result.direction, "DOWN");
  assert.equal(result.entry, "SKIP");
  assert.equal(result.realtimeSource, "Chainlink");
  assert.equal(result.realtimePrice, "64236.841398426855");
  assert.equal(result.targetPrice, "64388.846658832445");
  assert.equal(result.summary, "Deterministic model flags TRENDING condition, but DOWN executable ask missing.");
  assert.match(result.finalReason, /no executable ask/i);
  assert.match(result.guardrail, /actionable false/i);
  assert.match(result.risks, /spread HIGH/i);
  assert.match(result.dataWarning, /ask missing/i);
  assert.match(result.executableBooks, /DOWN ask n\/a/i);
  assert.equal(result.fairProbability, "72%");
  assert.equal(result.terminalProbability, "28%");
  assert.equal(result.expectedValue, "11.25 cents per share");
  assert.equal(result.kellySizing, "0% of Portfolio");
  assert.equal(result.bidPercent, 26);
  assert.equal(result.askPercent, 74);
  assert.ok(result.priceDelta < -151 && result.priceDelta > -153);
});

test("renders a balanced decision board with escaped report content", async () => {
  const { buildMarketSummaryHtml } = await import("../public/market-summary.js");
  const html = buildMarketSummaryHtml(`${SAMPLE_REPORT}\nBull point: <img src=x onerror=alert(1)>`, { isHistory: false });

  assert.match(html, /class="msp-board is-down"/);
  assert.match(html, /class="msp-detail-grid"/);
  assert.match(html, /data-summary-section="why"/);
  assert.match(html, /data-summary-section="risks"/);
  assert.match(html, /data-summary-section="evidence"/);
  assert.match(html, /Guardrail blocks entry/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("does not fabricate status, source, or market depth when report fields are missing", async () => {
  const { buildMarketSummaryHtml, parseMarketSummary } = await import("../public/market-summary.js");
  const sparseReport = "MARKET SUMMARY\nMarket: Sparse report\nTarget Price:\nRealtime Price:";
  const result = parseMarketSummary(sparseReport);
  const html = buildMarketSummaryHtml(sparseReport);

  assert.equal(result.direction, null);
  assert.equal(result.entry, null);
  assert.equal(result.realtimeSource, null);
  assert.equal(result.bidPercent, null);
  assert.equal(result.askPercent, null);
  assert.match(html, /BID Unavailable/);
  assert.match(html, /ASK Unavailable/);
  assert.doesNotMatch(html, /BID 50%|ASK 50%/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /msp-entry-decision is-neutral/);
});

test("normalizes multi-word no-entry statuses", async () => {
  const { parseMarketSummary } = await import("../public/market-summary.js");

  assert.equal(parseMarketSummary("Entry status: NO ENTRY / guardrail blocked").entry, "NO_ENTRY");
  assert.equal(parseMarketSummary("Entry status: NO CHASE because price moved").entry, "NO_CHASE");
});

test("presents an internal neutral decision as no signal and no entry", async () => {
  const { buildMarketSummaryHtml } = await import("../public/market-summary.js");
  const html = buildMarketSummaryHtml("MARKET SUMMARY\nArah market: NEUTRAL\nEntry status: NO ENTRY");

  assert.match(html, /<span aria-hidden="true">\?<\/span>NO SIGNAL/);
  assert.match(html, /msp-entry-decision is-risk[\s\S]*?<strong>NO_ENTRY<\/strong>/);
  assert.doesNotMatch(html, />NEUTRAL</);
});
