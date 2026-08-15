# Strict Short-Market UI Design

## Goal

Make the web terminal expose only the fixed-window crypto Up/Down workflow while preserving neutral evaluation internally as a no-entry safety state.

## Command Surface

- Replace the legacy action selector (`Deep Analyze`, `Search`, `Orderbook`, and `AI Best Pick`) with one `Analyze Short` action.
- Accept a Polymarket short-market URL, market ID, or resolvable short-market input.
- Send manual requests through `/shortanalyze`, which resolves the input and rejects non-short or multi-market event targets.
- Keep generic backend commands intact for existing non-web consumers.

## Neutral Presentation

- Remove Netral filters, counters, and diagnostic lean labels from the web UI.
- Keep `NEUTRAL` inside deterministic evaluation and scanner state.
- Present internal neutral states as `NO SIGNAL` or `NO ENTRY`; never force an UP/DOWN recommendation.

## Verification

- Browser tests assert that legacy actions and Netral controls are absent.
- Browser tests assert that Run submits `/shortanalyze`.
- Unit tests assert that the strict command rejects non-short targets.
- Existing scanner, unit, syntax, accessibility, and responsive browser checks remain green.
