# Dynamic EV Entry Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fast 5-minute market scanner that emits the first stable, executable manual-entry signal during a bounded EV window without waiting for AI explanation.

**Architecture:** Add a pure scanner-state module and a fast deterministic backend snapshot endpoint. The frontend queue polls eligible 5-minute markets independently, confirms two qualifying snapshots, displays a live entry card, and runs the existing full analysis only after a signal confirms.

**Tech Stack:** Node.js 20+, native HTTP server, browser JavaScript, SQLite, Node test runner.

## Global Constraints

- Scan 5-minute markets from 04:00 through 02:00 remaining every 5 seconds.
- Require 60% fair probability, 8 cents net EV, maximum ask 0.65, and two consecutive confirmations.
- Entry signals expire after 10 seconds and become `NO CHASE` when the quote exceeds the edge-preserving cap.
- Do not invoke AI in the fast snapshot path.
- Preserve fixed trigger behavior for 15-minute, 1-hour, 4-hour, and 1-day markets.
- Do not add dependencies.

---

### Task 1: Scanner Decision State

**Files:**
- Create: `public/entry-scanner.js`
- Test: `test/entry-scanner.test.js`

**Interfaces:**
- Produces: `DEFAULT_ENTRY_SCANNER_CONFIG`, `qualifyEntrySnapshot(snapshot, config)`, and `advanceEntryScannerState(state, snapshot, config)`.
- Snapshot fields: `remainingSeconds`, `direction`, `fairProbability`, `ask`, `netEvCents`, `maxEntryPrice`, `oracleAgeMs`, `marketActive`, `acceptingOrders`.

- [ ] Write tests for qualifying UP/DOWN snapshots, rejected weak/expensive/stale snapshots, two consecutive confirmations, disagreement reset, window expiry, and no-chase.
- [ ] Run `node --test test/entry-scanner.test.js` and confirm failure because the module is absent.
- [ ] Implement the pure state transitions with no network or storage dependency.
- [ ] Run `node --test test/entry-scanner.test.js` and confirm all scanner tests pass.

### Task 2: Fast Deterministic Snapshot

**Files:**
- Modify: `src/short_condition.js`
- Modify: `src/index.js`
- Modify: `src/web.js`
- Test: `test/decision-guardrails.test.js`

**Interfaces:**
- Produces: `getFastShortEntrySnapshot(marketId, signal)` returning `{ marketId, question, endDate, capturedAt, remainingSeconds, direction, fairProbability, ask, netEvCents, maxEntryPrice, oracleAgeMs, marketActive, acceptingOrders, blockers }`.
- HTTP: `POST /api/short-entry-snapshot` with `{ marketId }`.

- [ ] Add a test showing the fast evaluator returns deterministic pricing fields and does not require explanation metadata.
- [ ] Run the focused guardrail test and confirm failure.
- [ ] Refactor the short evaluator so AI explanation and context-only requests can be disabled while retaining Chainlink/CLOB/volatility guardrails.
- [ ] Add the exported market snapshot function and HTTP endpoint with input validation and abort propagation.
- [ ] Run the focused test and `npm run check`.

### Task 3: Queue Scanner Runtime

**Files:**
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `POST /api/short-entry-snapshot` and the pure state contract from Task 1 mirrored in browser state fields.
- Produces queue states: `waiting`, `watching`, `candidate`, `entry`, `no_chase`, `skipped`, `failed`.

- [ ] Replace the fixed 5-minute fire path with a scanner tick that begins at 04:00 and stops at 02:00.
- [ ] Poll active eligible items every 5 seconds without using `executeCommand` or Qwen cooldowns.
- [ ] Confirm candidates on two consecutive successful snapshots and run full `/analyzequeue` only after confirmation.
- [ ] Revalidate confirmed quotes every 2 seconds for 10 seconds and transition to `NO CHASE` when invalid.
- [ ] Keep existing fixed sniper behavior unchanged for longer durations.
- [ ] Run `node --check public/app.js`.

### Task 4: Scanner Layout and Settings

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles-v2.css`

**Interfaces:**
- Settings IDs: `set5mScanStart`, `set5mScanStop`, `set5mMinFair`, `set5mMinEv`, `set5mMaxAsk`, `set5mConfirmations`.
- Entry panel IDs: `entrySignalPanel`, `entrySignalStatus`, `entrySignalDirection`, `entrySignalAsk`, `entrySignalMaxAsk`, `entrySignalEv`, `entrySignalFair`, `entrySignalExpiry`.

- [ ] Replace the 5-minute fixed timing inputs with dynamic scanner controls and safe defaults.
- [ ] Add a pinned entry panel near the queue with clear `ENTRY`, `NO CHASE`, and `SKIP` visual states.
- [ ] Update queue rows to expose live ask, fair probability, EV, and scanner status without changing the overall page structure.
- [ ] Bump the sniper config version so stale 2-minute settings migrate once while preserving longer-duration settings.
- [ ] Verify desktop and narrow-screen CSS behavior.

### Task 5: Integration Verification

**Files:**
- Modify: `public/app.js`
- Modify: `src/polymarket.js`

- [ ] Bump matching client/server version strings.
- [ ] Run `npm test` and require all tests to pass.
- [ ] Run `npm run check` and require success.
- [ ] Run `git diff --check` and inspect the final diff for unrelated changes.
- [ ] Query one live eligible market through `/api/short-entry-snapshot` when available; otherwise report that live verification was not possible.
