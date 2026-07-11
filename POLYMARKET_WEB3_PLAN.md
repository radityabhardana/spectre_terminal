# Goal: Polymarket Web3 Wallet Integration & Local Bot Trading Setup

This plan details the architecture for securely connecting a Web3 wallet (e.g., MetaMask) to the local bot for automated trading on Polymarket, adhering strictly to our security guardrails.

## Proposed Changes

### 1. Setup Script (`src/scripts/setup_polymarket_auth.js`)
[NEW] A one-time execution script that:
- Prompts the user for their raw MetaMask Private Key.
- Uses the `@polymarket/clob-client` SDK to sign an L1 EIP-712 message.
- Derives the L2 CLOB API Credentials (`API_KEY`, `SECRET`, `PASSPHRASE`).
- Automatically appends these derived credentials to `.env`.
- Instructs the user to delete the raw private key from their clipboard/system immediately after execution.

### 2. Trading Module Update (`src/trading/polymarket_client.js`)
[NEW/MODIFY] Update the bot's runtime to initialize the Polymarket CLOB client using *only* the derived credentials from `.env`:
- `POLYMARKET_API_KEY`
- `POLYMARKET_SECRET`
- `POLYMARKET_PASSPHRASE`
- `POLYMARKET_RELAYER_API_KEY` (for potential gasless/attribution features)

The bot will never require the raw wallet private key to operate day-to-day.

### 3. Dependency Management
- Ensure `@polymarket/clob-client` and `ethers` are installed.

## Security Verification
- Verify that `.env` is correctly excluded via `.gitignore`.
- Verify the setup script does not log or store the raw private key anywhere on disk.
- Test placing a tiny test order ($1) using the derived credentials to confirm L2 authentication is working.
