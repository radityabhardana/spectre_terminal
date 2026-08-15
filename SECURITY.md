# Security Notes

Spectre Terminal is a local, read-only Polymarket intelligence tool. It does not sign transactions, store private keys or seed phrases, submit orders, or enable live trading, Shadow Bot, wallet signing, or CLOB execution.

## AgentRouter credential incident

An AgentRouter credential was present in Git history in `test_agentrouter.js` and `test_urls.js`. That credential must be treated as compromised even if those files are no longer in the current tree.

The account owner must revoke and rotate the credential from the provider dashboard. Removing a file from the current tree does not remove the credential from Git history. History cleanup is a separate operation using `git filter-repo`; this task does not rewrite history and does not force-push.

CI runs a local secret-pattern scan over the checkout. If it detects a likely secret, the scanner reports only the relative path and detection type, never the matched value.

## Wallet tracker privacy

Runtime tracker settings belong in the ignored `data/tracker_config.json`. Start from `tracker_config.example.json`; the runtime default is `minUsd: 1000` with no tracked wallets. The loader can migrate a legacy root `tracker_config.json` into the runtime location only when the runtime file is absent, and never deletes the legacy file automatically.

## Owner actions

- Revoke/rotate the historical AgentRouter credential.
- Clean the Git history separately with `git filter-repo`, then coordinate any required force-push with repository owners.
- Enable GitHub Secret Scanning and Dependabot.
- Enable branch protection for `main`.
