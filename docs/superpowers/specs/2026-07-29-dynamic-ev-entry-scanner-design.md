# Dynamic EV Entry Scanner

## Goal

Replace one-shot short-market analysis with an early, bounded scan window that surfaces the first stable, executable edge for manual entry without waiting for AI explanation.

## Scope

The first release applies dynamic scanning to 5-minute short crypto markets. Existing fixed triggers remain available for longer durations.

## Entry Policy

- Scan window: 04:00 through 02:00 remaining.
- Scan cadence: every 5 seconds.
- Minimum fair probability: 60% for the selected side.
- Minimum net EV: 8 cents after the configured fee buffer.
- Maximum executable ask: 0.65.
- Confirmation: the same direction must qualify on two consecutive snapshots.
- Signal lifetime: 10 seconds, with quote revalidation every 2 seconds.
- One entry signal per market.
- If no candidate confirms before 02:00, mark the market `SKIP: NO VALID EDGE`.

## Architecture

### Fast Snapshot API

A dedicated web endpoint accepts a market ID and returns a deterministic snapshot. It resolves the current market, fetches executable CLOB prices, obtains fresh Chainlink opening/live prices and interval volatility, and evaluates both sides. It does not call the AI explanation provider, update command cooldowns, or persist a final analysis.

### Scanner State

Each queue item tracks its scanner state, latest snapshot, candidate direction, consecutive confirmation count, and final entry signal. Eligible queue items are scanned independently so simultaneous BTC, ETH, and DOGE markets do not block each other.

### Final Analysis

When an entry signal confirms, the UI displays it immediately. Full analysis/history processing may run afterward, but it cannot delay or alter the already-displayed manual-entry signal. Markets that reach the end of the scan window without a signal are terminal skips.

## UI

Queue states become `WAITING`, `WATCHING`, `CANDIDATE`, `ENTRY`, `NO CHASE`, `SKIP`, and `FAILED`. During the scan window, each row shows direction, executable ask, fair probability, and net EV.

A pinned entry panel displays direction, current ask, maximum entry price, net EV, remaining market time, and signal expiry. If revalidation moves the ask beyond the edge-preserving cap, it changes to `NO CHASE`.

The 5-minute settings replace the fixed trigger with scan start, scan stop, minimum fair probability, minimum EV, maximum ask, and confirmation count. Longer-duration settings retain their current fixed trigger controls.

## Failure Handling

- A failed snapshot does not confirm or reset a valid candidate unless the next successful snapshot disagrees.
- Repeated API failures are shown as degraded scanner state; the item is failed only after the scan window ends without recoverable data.
- Stale oracle data, missing executable asks, closed markets, and invalid volatility can never produce an entry signal.
- A quote crossing the cap after confirmation produces `NO CHASE`, never a higher suggested entry price.

## Verification

- Unit tests cover qualification, consecutive confirmation, candidate reset, window expiry, and no-chase transitions.
- API tests cover valid snapshots and invalid market input.
- Existing deterministic guardrail and queue tests remain green.
- Syntax checks cover all backend and frontend JavaScript.

## Success Criteria

- A qualifying 5-minute signal appears without waiting for AI explanation.
- No new entry signal is created after 02:00 remaining.
- Weak, overpriced, stale, or unstable candidates are skipped.
- The queue and entry panel expose enough pricing information for a fast manual decision.
