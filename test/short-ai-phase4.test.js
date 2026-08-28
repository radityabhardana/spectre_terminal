import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  isSupportedShortAiItem,
  markShortAiAnalysisTriggered,
  shouldTriggerShortAiAnalysis,
  shortAiTriggerSeconds,
} from "../public/short-ai-trigger.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "public", "app.js"), "utf8");
const web = readFileSync(join(root, "src", "web.js"), "utf8");

const market = (duration_type, question = "Bitcoin Up or Down") => ({ id: "1", duration_type, question });

test("short AI triggers at, below, and not above each supported threshold", () => {
  for (const [duration, threshold] of Object.entries({ "5m": 150, "15m": 450, "1h": 1800, "4h": 7200 })) {
    const item = market(duration);
    assert.equal(shortAiTriggerSeconds(item), threshold);
    assert.equal(shouldTriggerShortAiAnalysis(item, threshold), true);
    assert.equal(shouldTriggerShortAiAnalysis(item, threshold - 1), true);
    assert.equal(shouldTriggerShortAiAnalysis(item, threshold + 1), false);
    assert.equal(shouldTriggerShortAiAnalysis(item, 0), false);
    assert.equal(shouldTriggerShortAiAnalysis(item, -1), false);
  }
});

test("supported short market classification accepts BTC ETH DOGE Up or Down only", () => {
  for (const asset of ["Bitcoin", "BTC", "Ethereum", "ETH", "Dogecoin", "DOGE"]) {
    assert.equal(isSupportedShortAiItem(market("15m", `${asset} Up or Down`)), true);
  }
  for (const item of [market("15m", "Solana Up or Down"), market("15m", "Bitcoin Above or Below"), market("2h"), { duration_type: "15m" }]) {
    assert.equal(isSupportedShortAiItem(item), false);
  }
});

test("one-shot guard and trigger timestamp are behavioral state transitions", () => {
  const item = market("5m");
  assert.equal(shouldTriggerShortAiAnalysis(item, 123), true);
  markShortAiAnalysisTriggered(item, 123);
  assert.equal(item.aiAnalysisTriggeredAtRemainingSeconds, 123);
  assert.equal(shouldTriggerShortAiAnalysis(item, 123), false);
  item.aiAnalysisTriggered = false;
  assert.equal(shouldTriggerShortAiAnalysis(item, 123), false);
});

test("frontend uses the helper and backend retains stable contract checks", () => {
  assert.match(app, /short-ai-trigger\.js/);
  assert.match(app, /ai\?\.confidence == null/);
  assert.match(web, /\/api\/short-ai-analysis/);
  assert.match(web, /timedOut \? 504/);
});

test("backend validates unsafe JSON bodies and never writes after disconnect", () => {
  assert.match(web, /!body \|\| typeof body !== "object" \|\| Array\.isArray\(body\)/);
  assert.match(web, /clientCancelled \|\| controller\.signal\.aborted \? 499/);
  assert.match(web, /if \(res\.destroyed \|\| res\.writableEnded\) return;/);
});

test("AI trigger invocation precedes the deterministic 5m scanner branch", () => {
  const tick = app.slice(app.indexOf("function runSniperTick()"));
  const trigger = tick.indexOf("shouldTriggerShortAiAnalysis(m, remainingSeconds)");
  const scannerBranch = tick.indexOf("if (isDynamicEntryItem(m))");
  assert.ok(trigger >= 0, "AI trigger invocation must exist");
  assert.ok(scannerBranch >= 0, "deterministic scanner branch must exist");
  assert.ok(trigger < scannerBranch, "AI trigger must be evaluated before the 5m branch");
});
