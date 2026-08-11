# Spectre Polymarket Analyzer

Local, read-only intelligence terminal for Polymarket. It combines public Gamma/CLOB data, crypto market context, deterministic Dynamic EV guardrails, multi-role AI analysis, outcome resolution, and read-only Polygon wallet tracking.

The application cannot sign wallets or submit orders. Private-wallet execution, live trading, Shadow Bot, and AI reflection memory have been removed.

## Requirements

- Node.js 20.10 or newer
- A supported AI provider API key
- Optional Polygon RPC URL for tracked-wallet transfer monitoring

## Setup

```bash
cp .env.example .env
npm ci
```

Configure at least one AI provider in `.env`. The default setup uses 9Router:

```text
NINEROUTER_API_KEY=
NINEROUTER_BASE_URL=http://127.0.0.1:20128/v1
QWEN_BULL_MODEL=alims-intl/deepseek-v4-flash
QWEN_BEAR_MODEL=alims-intl/deepseek-v4-flash
QWEN_RISK_MANAGER_MODEL=alims-intl/deepseek-v4-pro
QWEN_FALLBACK_MODEL=alims-intl/deepseek-v3.2
```

Public market-data providers do not require CLOB credentials:

```text
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com
POLYGON_RPC_URL=
```

## Run

Start the web terminal and read-only market-data services:

```bash
npm start
```

Open `http://127.0.0.1:8787`.

`WEB_HOST` defaults to `127.0.0.1`. A non-loopback host such as `0.0.0.0` is rejected unless `WEB_PASSWORD` is configured. Basic authentication should be used only behind HTTPS when traffic leaves the local machine.

To run only the web server:

```bash
npm run web
```

## Analysis Commands

The command engine supports:

- `/top [volume|liquidity|new|ending]`
- `/search <keyword>`
- `/book <market ID or Polymarket URL>`
- `/analyze <keyword, market ID, or Polymarket URL>`
- `/quickscan <event URL or slug>`
- `/top3 <event URL or slug>`
- `/analyzebest <event URL or slug>`
- `/analyzeall <event URL>`
- `/resolve [history ID]`
- `/add <0x wallet address> [nickname]`
- `/del <0x wallet address>`

The current terminal UI focuses on short-market discovery, Dynamic EV scanning, analysis evidence, history, Market Pulse, and wallet intelligence. It intentionally exposes no order-entry or wallet-signing controls.

## Outcomes And Statistics

Deep analyses are stored in SQLite. `/resolve` and the history controls read official closed-market outcomes and classify records as win, loss, or neutral without an AI post-mortem.

Win-rate statistics include only actionable, resolved win/loss records. Neutral and unresolved records are excluded.

## Database Migration

The canonical database is `data/database.db`. Startup applies versioned migrations through `src/migrations.js`.

Before a legacy database is changed, the migration:

1. Creates an online SQLite backup under `data/backups/`.
2. Sets directory mode `0700` and backup mode `0600`.
3. Runs SQLite `quick_check` against the backup.
4. Applies the schema transaction.
5. Verifies the resulting schema and `user_version`.

Stop the running application before deploying a migration. Retired execution, reflection, shadow, alert, and profile tables are removed only after the verified backup succeeds.

## Security Model

- No private key, seed phrase, or CLOB credential is accepted by the runtime.
- Non-loopback web binding fails closed without `WEB_PASSWORD`.
- State-changing browser API requests require JSON and same-origin request metadata.
- CSP blocks inline scripts and event handlers.
- Static file resolution is confined to `public/`.
- Wallet profile requests accept only canonical EVM addresses.
- External URLs and dynamic HTML are escaped or allowlisted before rendering.

If a credential ever entered Git history or a public channel, rotate it. Removing current configuration does not invalidate an exposed credential.

## Verification

```bash
npm run check
npm test
npm run test:e2e
npx htmlhint public/index.html
npm audit --audit-level=moderate
```

This software is an analysis tool, not financial advice. Entry labels are informational guardrails only; the application never submits a trade.
