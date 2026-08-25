import { expect, test } from "@playwright/test";

const MARKET_SUMMARY_REPORT = `MARKET SUMMARY
Market: BTC 5m QA Window
Durasi Analisis: 8 detik
AI Tokens: 3567
API close/resolution: 29 Jul 2026, 19:20 WIB
URL: https://polymarket.com/event/qa-market-5m
Arah market: DOWN (deterministic Chainlink terminal model)
Entry status: SKIP / guardrail blocked
Dominan: DOWN
Market Price Up: 26% | Market Price Down: 74%
Gap dominansi: 48 points
Underdog: skor 6/10
Liquidity: $20,422
Gamma volume: $563
Orderbook DOWN: bid n/a | ask 0.01 | spread n/a
Executable books: UP ask 0.75 / mid 0.74 | DOWN ask n/a / mid 0.26
Data confidence: 67/100 | Deterministic confidence: 100/100
Risks: liquidity LOW, spread HIGH, resolution MEDIUM
Data warning: DOWN executable ask missing
Guardrail: missing executable DOWN ask; actionable false
Explanation: Deterministic model flags TRENDING condition, but DOWN executable ask is missing.
Selected/lean Fair Prob: 72% | Terminal UP Prob: 28%
Expected Value (EV): 11.25 cents per share
Kelly Sizing Rec: 0% of Portfolio
Bull point: Price remains below the target into resolution.
Bear point: A late reversal can invalidate the lean.
Final reason: Guardrail blocks entry because the selected side has no executable ask.
Kesimpulan Analisis: Deterministic model flags TRENDING condition, but DOWN executable ask missing.
Target Price: 64388.846658832445
Realtime Chainlink Price: 64236.841398426855`;

async function mockTerminalApi(page) {
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "text/css",
    body: "",
  }));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        engine: "qa-terminal",
        qwen: { qwenConfigured: true, qwenStatus: "key_loaded", qwenLabel: "AI provider configured" },
        providerConnection: { configured: true, reachable: true, provider: "qa", modelsAvailable: true, configuredModels: ["qa-model"], missingModels: [] },
        trading: { enabled: false, authenticated: false },
        cooldown: { commandWaitMs: 0, qwenWaitMs: 0, qwenInFlight: false },
        totalAITokensUsed: {},
      });
    }
    if (url.pathname === "/api/short-entry-snapshot") {
      return json({
        ok: true,
        snapshot: {
          remainingSeconds: 149,
          marketActive: true,
          marketClosed: false,
          acceptingOrders: true,
          actionable: true,
          blockers: [],
          oracleAgeMs: 1_000,
          feeBufferCents: 2,
          forecastDirection: "UP",
          capturedAt: new Date().toISOString(),
          sides: {
            UP: { fairProbability: 59, ask: 0.6, netEvCents: -3 },
            DOWN: { fairProbability: 41, ask: 0.41, netEvCents: -2 },
          },
        },
      });
    }
    if (url.pathname === "/api/short-term") {
      return json({
        ok: true,
        markets: [{
          id: "qa-market-5m",
          url: "https://polymarket.com/event/qa-market-5m",
          question: "Will Bitcoin finish higher in this five minute window?",
          duration_type: "5m",
          endDate: new Date(Date.now() + 180_000).toISOString(),
          outcomePrices: [0.26, 0.74],
          outcomes: ["Up", "Down"],
        }],
      });
    }
    if (url.pathname === "/api/command") {
      return json({
        ok: true,
        engine: "qa-terminal",
        messages: [{ role: "assistant", text: MARKET_SUMMARY_REPORT }],
        result: { type: "analysis", status: "success" },
        cooldown: { commandWaitMs: 0, qwenWaitMs: 0, qwenInFlight: false },
      });
    }
    if (url.pathname === "/api/history/events") {
      return json({
        ok: true,
        events: [{
          id: "history-1",
          market_id: "qa-market-5m",
          question: "BTC 5m QA Window",
          url: "https://polymarket.com/event/qa-market-5m",
          prediction: "DOWN",
          result: "menunggu hasil",
          analysis_conclusion: MARKET_SUMMARY_REPORT,
          created_at: "2026-07-29T12:20:00.000Z",
        }],
      });
    }
    if (url.pathname === "/api/ws-status") {
      return json({ sniffer: "disconnected", binance: { liquidation: false, depth: false } });
    }
    if (url.pathname === "/api/stats") return json({ ok: true, stats: {} });
    if (url.pathname === "/api/dashboard-metrics") return json({ ok: true });
    if (url.pathname === "/api/tracker-config") return json({ ok: true, config: { minUsd: 1000, trackedWallets: [] } });
    if (url.pathname.startsWith("/api/settings/")) return json({ ok: true, enabled: false });
    if (url.pathname === "/api/sniffer-whales") return json({ ok: true, whales: [] });
    if (url.pathname === "/api/memory-checklist") return json({ ok: true, checklist: [] });
    if (url.pathname === "/api/live-prices") {
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: 'data: {"type":"CONNECTED"}\n\n',
      });
    }
    return json({ ok: true });
  });
}

test.beforeEach(async ({ page }) => {
  await mockTerminalApi(page);
  await page.goto("/");
});

test("terminal enforces the focused dark theme", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("razorbot_mode", "light");
    localStorage.setItem("razorbot_font", "padre");
  });
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-font", "geist");
  await expect(page.locator("#btnThemePanelTrigger")).not.toBeVisible();
});

test("terminal shell loads without page or console errors", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.reload();
  await page.waitForTimeout(500);

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("desktop exposes the focused analysis workflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "desktop-only layout assertion");

  await expect(page.locator('[data-terminal-region="opportunities"]')).toBeVisible();
  await expect(page.locator('[data-terminal-region="analysis"]')).toBeVisible();
  await expect(page.locator('[data-terminal-region="queue"]')).toBeVisible();
  await expect(page.locator("#shortMarketPanel")).toBeVisible();
  await expect(page.locator("#btnRefreshShortMarket")).toBeVisible();
  await expect(page.locator("#commandInput")).toHaveCount(0);
  await expect(page.locator("#entryDecisionSpine")).toBeVisible();
  await expect(page.locator("#entryDecisionSpine")).toContainText("Experimental Candidate");
  await expect(page.locator("#entryDecisionSpine")).not.toContainText("ENTRY");
  await expect(page.locator("#btnRunQueue")).toBeDisabled();
  await expect(page.locator("#analysisFlow")).toContainText("Verdict");
  await expect(page.locator("#analysisFlow")).toContainText("Why");
  await expect(page.locator("#analysisFlow")).toContainText("Probability + EV");
  await expect(page.locator("#analysisFlow")).toContainText("Risks");
  await expect(page.locator("#analysisFlow")).toContainText("Evidence");
  await expect(page.locator('[data-terminal-region="analysis"]')).toHaveAttribute("data-analysis-state", "empty");
  await expect(page.getByText("Deep Analyze", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Search", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Orderbook", { exact: true })).toHaveCount(0);
  await expect(page.getByText("AI Best Pick", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Netral", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Tanpa Netral", { exact: true })).toHaveCount(0);
  await expect(page.locator("#aggressiveModeBtn")).toHaveCount(0);
  await expect(page.getByText("NO NETRAL: OFF", { exact: true })).toHaveCount(0);
});

test("mobile uses focused bottom navigation without page overflow", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only navigation assertion");

  const nav = page.locator("#mobileTerminalNav");
  await expect(nav).toBeVisible();
  await expect(nav.getByRole("button", { name: "Markets" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Analysis" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Queue" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Tracker" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);

  await nav.getByRole("button", { name: "Markets" }).click();
  await expect(page.locator("#shortMarketPanel")).toBeVisible();

  await nav.getByRole("button", { name: "Analysis" }).click();
  await expect(page.locator('[data-terminal-region="analysis"]')).toBeVisible();
  await expect(page.locator("#commandInput")).toHaveCount(0);

  await nav.getByRole("button", { name: "Queue" }).click();
  await expect(page.locator("#btnRunQueue")).toBeVisible();

  await nav.getByRole("button", { name: "Tracker" }).click();
  await expect(page.locator("#secondaryToolsDrawer")).toBeVisible();
});

test("settings exposes every pane in an anchored desktop popover or mobile sheet", async ({ page }, testInfo) => {
  const trigger = page.locator("#terminalSettingsTrigger");
  const modal = page.locator("#settingsModal");
  const panel = modal.locator(".settings-dropdown-panel");
  const tablist = panel.getByRole("tablist", { name: "System settings sections" });
  const tabs = {
    alerts: tablist.getByRole("tab", { name: "Alerts & Audio", exact: true }),
    sniper: tablist.getByRole("tab", { name: "Sniper Trigger", exact: true }),
    analytics: tablist.getByRole("tab", { name: "Analytics", exact: true }),
  };

  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(modal).toBeVisible();
  await expect(panel).toBeVisible();
  await panel.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect(panel.locator("#closeSettingsModal")).toBeFocused();
  await expect(tablist).toBeVisible();
  await expect(tabs.alerts).toBeVisible();
  await expect(tabs.sniper).toBeVisible();
  await expect(tabs.analytics).toBeVisible();
  await expect.poll(() => tablist.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const tab of Object.values(tabs)) {
    await expect.poll(() => tab.evaluate((element) => (
      element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight
    ))).toBe(true);
  }

  await testInfo.attach(`settings-${testInfo.project.name}-alerts`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });

  const layout = await page.evaluate(() => {
    const triggerElement = document.querySelector("#terminalSettingsTrigger");
    const panelElement = document.querySelector(".settings-dropdown-panel");
    if (!triggerElement || !panelElement) return null;
    const triggerRect = triggerElement.getBoundingClientRect();
    const panelRect = panelElement.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      panelLeft: panelRect.left,
      panelRight: panelRect.right,
      panelTop: panelRect.top,
      panelHeight: panelRect.height,
      panelWidth: panelRect.width,
      triggerBottom: triggerRect.bottom,
    };
  });

  expect(layout).not.toBeNull();
  expect(layout.panelLeft).toBeGreaterThanOrEqual(0);
  expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.panelWidth).toBeLessThanOrEqual(480);
  if (testInfo.project.name === "desktop") {
    expect(layout.panelTop).toBeGreaterThanOrEqual(layout.triggerBottom + 7);
    expect(layout.panelHeight).toBeLessThan(500);
  } else {
    expect(layout.panelLeft).toBe(0);
    expect(layout.panelRight).toBe(layout.viewportWidth);
  }

  await expect(panel.locator("#pane-alerts")).toBeVisible();
  await expect(panel.locator("#pane-alerts")).toContainText("Master Audio");
  await expect(tabs.alerts).toHaveAttribute("aria-selected", "true");

  await tabs.sniper.click();
  await expect(panel.locator("#pane-sniper")).toBeVisible();
  await expect(panel.locator("#pane-sniper")).toContainText("Dynamic EV Scanner");
  await expect(tabs.sniper).toHaveAttribute("aria-selected", "true");
  await panel.locator("#set5mMinFair").fill("64");

  await tabs.analytics.click();
  await expect(panel.locator("#pane-analytics")).toBeVisible();
  await expect(panel.locator("#pane-analytics")).toContainText("Analytics Stats");
  await expect(tabs.analytics).toHaveAttribute("aria-selected", "true");

  await tabs.alerts.click();
  await expect(panel.locator("#pane-alerts")).toBeVisible();
  await expect(panel.locator("#pane-sniper")).toBeHidden();
  await expect(panel.locator("#pane-analytics")).toBeHidden();

  await tabs.sniper.click();
  await expect(panel.locator("#set5mMinFair")).toHaveValue("64");

  const navigationLayout = await page.evaluate(() => {
    const nav = document.querySelector(".settings-tablist");
    const content = document.querySelector(".settings-popover-content");
    if (!nav || !content) return null;
    const navRect = nav.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      navDisplay: getComputedStyle(nav).display,
      navColumns: getComputedStyle(nav).gridTemplateColumns.split(" ").length,
      navHeight: navRect.height,
      navWidth: navRect.width,
      contentLeft: contentRect.left,
      navLeft: navRect.left,
    };
  });
  expect(navigationLayout).not.toBeNull();
  expect(navigationLayout.navDisplay).toBe("grid");
  expect(navigationLayout.navColumns).toBe(3);
  expect(navigationLayout.navHeight).toBeLessThanOrEqual(44);
  expect(navigationLayout.contentLeft).toBe(navigationLayout.navLeft);
  expect(navigationLayout.navWidth).toBeGreaterThanOrEqual(layout.panelWidth - 2);

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(modal).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(modal).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await tabs.sniper.click();
  await panel.locator("#set5mMinFair").fill("66");
  await panel.locator("#btnSaveSettings").click();
  await expect(modal).toBeHidden();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("sniperConfig"))?.m5?.minFairProbability)).toBe(66);
});

test("market-card countdown is flush with its content row edge", async ({ page }) => {
  const card = page.locator(".btc5m-card").first();
  const actions = card.locator(".short-market-actions");
  const timer = card.locator(".short-market-timer");

  await expect(card).toBeVisible();
  await expect(timer).toBeVisible();
  await expect.poll(() => card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  const alignment = await page.evaluate(() => {
    const actionsElement = document.querySelector(".btc5m-card .short-market-actions");
    const timerElement = document.querySelector(".btc5m-card .short-market-timer");
    if (!actionsElement || !timerElement) return null;
    return actionsElement.getBoundingClientRect().right - timerElement.getBoundingClientRect().right;
  });

  expect(alignment).not.toBeNull();
  expect(Math.abs(alignment)).toBeLessThanOrEqual(1);
});

test("queued market produces a deterministic no-entry result", async ({ page }) => {
  await page.evaluate(() => window.addToQueue({
    id: "qa-market-5m",
    url: "https://polymarket.com/event/qa-market-5m",
    question: "Will Bitcoin finish higher in this five minute window?",
    duration_type: "5m",
    endDate: new Date(Date.now() + 180_000).toISOString(),
  }));

  if (await page.locator("#mobileTerminalNav").isVisible()) {
    await page.locator("#mobileTerminalNav").getByRole("button", { name: "Queue" }).click();
  }

  const runButton = page.locator("#btnRunQueue");
  await expect(runButton).toBeVisible();
  await expect(runButton).toBeEnabled();
  await runButton.click();

  await expect(page.locator("#entrySignalStatus")).toHaveText("Not selected", { timeout: 10_000 });
  await expect(page.locator("#entrySignalData")).toHaveText("READY");
  await expect(page.locator("#entrySignalGates")).toContainText("Fair probability must be at least 60%.");
  await expect(page.locator("#entrySignalGates")).toContainText("Required 2 same-direction confirmations");
  await expect(page.locator('[data-decision-step="no_entry"]')).toHaveAttribute("aria-current", "step");
});

test("market summary fills the workspace with decision details", async ({ page }, testInfo) => {
  if (testInfo.project.name === "mobile") {
    await page.locator("#mobileTerminalNav").getByRole("button", { name: "Analysis" }).click();
  }

  await page.evaluate(() => window.analyzeShortMarket("qa-market-5m", "https://polymarket.com/event/qa-market-5m"));

  const board = page.locator(".msp-board");
  await expect(page.locator(".message.user")).toContainText(/\/shortanalyze https:\/\/polymarket\.com\/event\/qa-market-5m/);
  await expect(board).toBeVisible();
  await expect(page.locator(".msp-decision-band")).toBeVisible();
  await expect(page.locator(".msp-detail-card")).toHaveCount(3);
  await expect(page.locator('[data-summary-section="why"]')).toContainText("Deterministic model");
  await expect(page.locator('[data-summary-section="risks"]')).toContainText("actionable false");
  await expect(page.locator('[data-summary-section="evidence"]')).toContainText("11.25 cents per share");

  if (testInfo.project.name === "desktop") {
    const panelBox = await page.locator("#staticResultContent").boundingBox();
    const boardBox = await board.boundingBox();
    const decisionBox = await page.locator(".msp-decision-band").boundingBox();
    expect(panelBox && boardBox && decisionBox).toBeTruthy();
    expect(boardBox.height).toBeGreaterThan(panelBox.height * 0.8);
    expect(decisionBox.y).toBeLessThan(panelBox.y + panelBox.height * 0.3);
  } else {
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth === document.documentElement.clientWidth)).toBe(true);
  }
});

test("archived analysis uses the balanced market summary", async ({ page }, testInfo) => {
  await expect(page.locator('[data-history-action="show"][data-event-id="history-1"]')).toHaveCount(1);
  await page.evaluate(() => window.showHistoryChat("history-1"));
  if (testInfo.project.name === "mobile") {
    await page.locator("#mobileTerminalNav").getByRole("button", { name: "Analysis" }).click();
  }

  await expect(page.locator(".msp-board")).toBeVisible();
  await expect(page.locator(".msp-eyebrow")).toContainText("History Archive");
  await expect(page.locator('[data-summary-section="why"]')).toContainText("Deterministic model");
});
