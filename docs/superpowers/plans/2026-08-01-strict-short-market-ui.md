# Strict Short-Market UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove legacy general-market controls from the web terminal and route its single manual action through a short-market-only backend command.

**Architecture:** The browser always builds `/shortanalyze <input>`. The new command reuses existing input resolution and short-market analysis, but rejects non-short and ambiguous event targets before analysis. Neutral remains an internal safety value and is translated to no-entry language at presentation boundaries.

**Tech Stack:** Browser ES modules, Node.js command handler, Node test runner, Playwright.

## Global Constraints

- Do not alter deterministic short scanner thresholds, timing, guardrails, or trade behavior.
- Do not remove generic backend commands used by Telegram or other consumers.
- Do not force neutral evaluations into UP or DOWN.
- Do not commit without an explicit user request.

---

### Task 1: Lock the strict browser contract

**Files:**
- Modify: `e2e/terminal.spec.js`

**Interfaces:**
- Consumes: `#commandInput`, `#runButton`, and mocked `/api/command` requests.
- Produces: browser regressions for the short-only command surface.

- [ ] Add assertions that `Deep Analyze`, `Search`, `Orderbook`, `AI Best Pick`, and Netral controls are absent.
- [ ] Capture the command request and assert that Run submits `/shortanalyze qa-market-5m`.
- [ ] Run `npm run test:e2e -- --project=desktop` and verify the new assertions fail for the legacy UI.

### Task 2: Add the strict backend command

**Files:**
- Modify: `src/index.js`
- Modify: `src/rate-limit.js`
- Test: `test/decision-guardrails.test.js` or a focused command test.

**Interfaces:**
- Consumes: `resolveAnalyzeInput(input)`, `isShortCryptoMarket(market)`, and `deepAnalyzeMarket(...)`.
- Produces: `/shortanalyze <input>` with fail-closed short-market validation.

- [ ] Add a failing command test for a resolved non-short market.
- [ ] Run the focused test and confirm the command currently falls through.
- [ ] Implement `/shortanalyze` by resolving one market, validating `isShortCryptoMarket`, and delegating to `deepAnalyzeMarket`.
- [ ] Register `/shortanalyze` as an AI/rate-limited command.
- [ ] Run the focused test and confirm it passes.

### Task 3: Simplify the web terminal and neutral presentation

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/market-summary.js`

**Interfaces:**
- Consumes: manual input text and internal neutral evaluations.
- Produces: one `Analyze Short` action and no user-facing Netral terminology.

- [ ] Remove legacy action groups and the Netral history controls/count.
- [ ] Make `buildCommand()` return `/shortanalyze <input>` and remove action-selection state/listeners.
- [ ] Keep raw command execution out of the main manual input path.
- [ ] Render a neutral direction as `NO SIGNAL` and neutral entry state as `NO ENTRY`.
- [ ] Run focused browser and Market Summary tests until green.

### Task 4: Verify the complete change

**Files:**
- Verify only.

**Interfaces:**
- Consumes: completed implementation.
- Produces: fresh release evidence.

- [ ] Run `npm test`.
- [ ] Run `npm run check`.
- [ ] Run `npm run test:e2e`.
- [ ] Run `npx htmlhint "public/index.html"`.
- [ ] Run `git diff --check`.
- [ ] Run `npm audit`.
